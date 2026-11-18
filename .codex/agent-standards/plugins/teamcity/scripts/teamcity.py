#!/usr/bin/env python3
"""Inspect and operate a project's TeamCity builds from the command line.

Shared across every project that builds on `ci.snowmonkey.co.uk`. The project
supplies `.teamcity/cli.json`; nothing else here is per-project.

The credential handling is the reason this is one script rather than a snippet
pasted into each session. The access key is a full-admin token whose one safe
route is curl's stdin config -- not a remote shell string, not `ssh` arguments,
not a local process list where `ps` can read it. A rule that has to be
re-implemented by hand on each use is a rule that will be got wrong once.

The locator matters as much. Assembling an answer out of REST calls and `jq` by
hand invites reading the wrong build: the newest build in the project is
routinely not the newest build of the configuration being asked about, and the
composite's own status is never the cause of anything.

The server's REST API is behind Google SSO, so every request is made from inside
the container over SSH. These commands need the tunnel to `ci.snowmonkey.co.uk`
to be up; there is no offline mode and none is wanted.

Triggering and rerunning builds, cancelling running or queued builds, and
reordering the queue are authorized agent operations. Use --dry-run to preview
an operation. Cancellation requires --yes; agents supply it without prompting.

Configuration -- `.teamcity/cli.json`, found by walking up from the working
directory. Its folder is the repository root for revision lookups:

    {
      "project":    "FantasyFootball",   # required, the TeamCity project id
      "composite":  "Verify",            # optional; the chain-gathering config,
                                         # omit in a project that has no composite
      "testLegs":   ["Tests"],           # configs that run tests, for `history`
      "buildTypes": ["Checks", "Tests"], # optional whitelist; omit for all
      "logDir":     "tmp/teamcity",      # optional; omit to not save logs
      "host":       "root@ci.snowmonkey.co.uk"   # optional, this is the default
    }

Usage:
    teamcity.py status              # every configuration, green or red
    teamcity.py failures            # failed tests on the red legs
    teamcity.py failures --build 1939
    teamcity.py queue               # what is waiting and what is running
    teamcity.py trigger --leg Checks # queue this configuration (default: composite)
    teamcity.py rerun --build 1939   # rerun its recorded revisions
    teamcity.py cancel --build 1939 --yes
    teamcity.py move --build 1939 --position first
    teamcity.py watch               # wait for what is running or queued to finish
    teamcity.py watch --build 1939  # wait for one build
    teamcity.py builds              # which revision each recent build tested
    teamcity.py chain               # the composite and every leg under it
    teamcity.py log --build 1939 --grep 'error:'
    teamcity.py artifacts --build 1939
    teamcity.py artifacts --build 1939 --get logs/ui.json
    teamcity.py artifacts --build 1939 --get-all --out-dir tmp/teamcity/1939
    teamcity.py history testTheLobbyBuilds
    teamcity.py --selftest
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.parse
import zipfile
from pathlib import Path, PurePosixPath

CONFIG_PATH = Path(".teamcity") / "cli.json"

DEFAULT_HOST = "root@ci.snowmonkey.co.uk"
DEFAULT_CONTAINER = "teamcity"
DEFAULT_BASE_URL = "http://localhost:8111"
# The same file under either home for it: a Mac with Desktop & Documents syncing has one
# ~/Documents, and a Mac without it keeps the synced copy in iCloud Drive beside a local one.
DEFAULT_TOKEN_FILES = (
    "~/Documents/projects/teamcity/accesskey.txt",
    "~/Library/Mobile Documents/com~apple~CloudDocs/projects/teamcity/accesskey.txt",
)


def load_config() -> dict:
    """The nearest `.teamcity/cli.json` at or above the working directory."""
    here = Path.cwd().resolve()
    for folder in (here, *here.parents):
        candidate = folder / CONFIG_PATH
        if candidate.is_file():
            break
    else:
        raise SystemExit(
            f"No {CONFIG_PATH} at or above {here}.\n"
            "Every project on ci.snowmonkey.co.uk needs one; see the teamcity plugin's README."
        )
    try:
        settings = json.loads(candidate.read_text())
    except json.JSONDecodeError as error:
        raise SystemExit(f"{candidate} is not valid JSON: {error}") from error
    if not settings.get("project"):
        raise SystemExit(f"{candidate} is missing required project")
    settings["_root"] = candidate.parent.parent
    return settings


CONFIG = load_config()

REPO_ROOT = CONFIG["_root"]
PROJECT = CONFIG["project"]
HOST = CONFIG.get("host") or DEFAULT_HOST
CONTAINER = CONFIG.get("container") or DEFAULT_CONTAINER
BASE_URL = CONFIG.get("baseUrl") or DEFAULT_BASE_URL
TOKEN_FILES = tuple(
    Path(p).expanduser() for p in CONFIG.get("tokenFiles") or DEFAULT_TOKEN_FILES
)

# The composite that gathers the chain, if the project has one. Its own status only
# ever restates its legs, so `status` and the red-leg scan exclude it; `chain` is the
# one command that needs it and the one command a project without one cannot run.
COMPOSITE = CONFIG.get("composite")
# The configurations that run tests, newest-build-first, for history lookups.
TEST_LEGS = tuple(CONFIG.get("testLegs") or ())
# A whitelist for `status` and the red-leg scan. Empty means every configuration
# in the project, which is what a project with nothing else in it wants.
BUILD_TYPES = tuple(CONFIG.get("buildTypes") or ())
# Where `log` saves the raw build log. Unset means it is not saved.
LOG_DIR = REPO_ROOT / CONFIG["logDir"] if CONFIG.get("logDir") else None

RECENT_BUILDS = (
    "app/rest/builds?locator=project:{project},count:{count}"
    "&fields=build(id,buildTypeId,number,status,state,statusText,webUrl,finishDate,"
    "revisions(revision(version)))"
)
FAILED_TESTS = (
    "app/rest/testOccurrences?locator=build:(id:{build}),status:FAILURE"
    "&fields=count,testOccurrence(name,duration,currentlyMuted,details,"
    "firstFailed(build(number,buildTypeId)))"
)
BUILD_PROBLEMS = (
    "app/rest/problemOccurrences?locator=build:(id:{build})"
    "&fields=count,problemOccurrence(type,identity,details)"
)
QUEUED = "app/rest/buildQueue?fields=build(id,buildTypeId,number,state,waitReason,branchName)"
RUNNING = (
    "app/rest/builds?locator=project:{project},state:running"
    "&fields=build(id,buildTypeId,number,percentageComplete,statusText,"
    "revisions(revision(version)))"
)
# One build's progress, for `watch`: from the queue, where a build waits under
# buildQueue, to the result it finishes with under builds.
BUILD_STATE = (
    "app/rest/builds/id:{build}?fields=id,buildTypeId,number,status,state,statusText,"
    "webUrl,revisions(revision(version))"
)
QUEUED_BUILD = "app/rest/buildQueue/id:{build}?fields=id,buildTypeId,number,state,waitReason"
CHAIN = (
    "app/rest/builds/id:{build}?fields=id,buildTypeId,number,status,state,statusText,webUrl,"
    "revisions(revision(version)),"
    "snapshot-dependencies(build(id,buildTypeId,number,status,state,statusText))"
)
ARTIFACT_LIST = (
    "app/rest/builds/id:{build}/artifacts/children/{path}"
    "?fields=file(name,size,children(file(name,size)))"
)
ARTIFACT_CONTENT = "app/rest/builds/id:{build}/artifacts/content/{path}"
ARTIFACT_ARCHIVE = "app/rest/builds/id:{build}/artifacts/archived/{path}"
BUILD_LOG = "downloadBuildLog.html?buildId={build}"
TEST_HISTORY = (
    "app/rest/testOccurrences?locator=test:(name:{name}),count:{count}"
    "&fields=count,testOccurrence(status,duration,currentlyMuted,"
    "build(id,buildTypeId,number,finishDate))"
)
BUILD_TESTS = (
    "app/rest/testOccurrences?locator=build:(id:{build}),count:5000"
    "&fields=testOccurrence(name)"
)
# What a configuration *is*, rather than how its last build went. The server is
# the record for a UI-owned project and this is the only way to read it: a build
# log shows the steps, and steps are the smallest part of what a configuration
# is. Needed whenever settings move into a Kotlin DSL, because versioned
# settings are authoritative — a configuration the DSL omits or misstates is one
# TeamCity deletes or rewrites — and needed again afterwards to prove the server
# still holds what the DSL says.
PROJECT_BUILD_TYPES = "app/rest/projects/id:{project}?fields=buildTypes(buildType(id,name))"
BUILD_TYPE_SETTINGS = "app/rest/buildTypes/id:{id}"
# Not in the default field set, and what a DSL must carry to rename a configuration
# without TeamCity deleting it and restarting its build counter.
BUILD_TYPE_UUID = "app/rest/buildTypes/id:{id}?fields=uuid"
PROJECT_SETTINGS = (
    "app/rest/projects/id:{project}"
    "?fields=id,name,description,parameters(property(name,value)),"
    "projectFeatures(projectFeature(id,type,properties(property(name,value))))"
)
VCS_ROOT = "app/rest/vcs-roots/id:{id}?fields=id,name,vcsName,properties(property(name,value))"


def remote_command(relative_url: str) -> list[str]:
    """The argv for one authenticated GET. The token is not in it; it arrives on stdin."""
    target = shlex.quote(f"{BASE_URL}/{relative_url}")
    inner = (
        f"docker exec -i {CONTAINER} curl --silent --show-error --fail-with-body "
        f"--config - {target}"
    )
    # LogLevel=ERROR, not -q. Both silence the connection banner this host prints on
    # every session, but -q silences ssh's own fatal errors with it, so a request that
    # never left the machine arrived here as exit 255 and an empty stderr.
    return ["ssh", "-o", "LogLevel=ERROR", HOST, inner]


def curl_config(token: str, accept: str = "application/json") -> str:
    return f'header = "Authorization: Bearer {token}"\nheader = "Accept: {accept}"\n'


def read_token() -> str:
    found = next((path for path in TOKEN_FILES if path.is_file()), None)
    if found is None:
        searched = "\n  ".join(str(path) for path in TOKEN_FILES)
        raise SystemExit(f"TeamCity token is not readable at:\n  {searched}")
    token = found.read_text().strip()
    if not token:
        raise SystemExit(f"TeamCity token file is empty: {found}")
    return token


def failure_hint(returncode: int, detail: str) -> str:
    """What a failed request means, read from what ssh actually said.

    ssh reserves 255 for its own failures, so that code alone separates "never
    reached the server" from "the server ran the command and it failed".
    """
    if returncode != 255:
        return "ssh reached the server, so docker or curl is what rejected this, not the connection."
    if "Operation not permitted" in detail:
        return (
            "The local machine refused ssh the socket; the server was never contacted. "
            "That is an agent sandbox: it blocks port 22 for every command its settings do "
            "not exempt, and it exempts this script only when the whole command is "
            "`python3 scripts/teamcity.py <command>` or `./scripts/teamcity.py <command>`, "
            "run from the repo root. A loop, `bash -c`, an absolute path, or a script "
            "calling this one stays sandboxed. To wait for a build, use `watch`, not a loop."
        )
    return "ssh never reached the server."


def request(relative_url: str, accept: str = "application/json", text: bool = True) -> subprocess.CompletedProcess:
    """Run one REST call. `text=False` keeps the body as bytes, for artifacts that are not text."""
    config = curl_config(read_token(), accept)
    return subprocess.run(
        remote_command(relative_url),
        input=config if text else config.encode(),
        capture_output=True,
        text=text,
        check=False,
    )


def request_failed(relative_url: str, finished: subprocess.CompletedProcess) -> SystemExit:
    detail = finished.stderr.strip() or finished.stdout.strip()
    return SystemExit(
        f"TeamCity request failed ({finished.returncode}) for {relative_url}\n"
        f"{detail or 'It said nothing at all, on either stream.'}\n"
        f"{failure_hint(finished.returncode, detail)}"
    )


def fetch(relative_url: str, accept: str = "application/json") -> str:
    finished = request(relative_url, accept)
    if finished.returncode != 0:
        raise request_failed(relative_url, finished)
    return finished.stdout


def artifact_text(body: bytes) -> str | None:
    """An artifact's content as text, or None when it is binary and printing it would be noise."""
    if b"\0" in body:
        return None
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError:
        return None


def fetch_bytes(relative_url: str) -> bytes:
    finished = request(relative_url, accept="*/*", text=False)
    if finished.returncode != 0:
        raise request_failed(relative_url, subprocess.CompletedProcess(
            finished.args,
            finished.returncode,
            finished.stdout.decode(errors="replace"),
            finished.stderr.decode(errors="replace"),
        ))
    return finished.stdout


def get(relative_url: str) -> dict:
    body = fetch(relative_url)
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        raise SystemExit(
            f"TeamCity returned no JSON for {relative_url}:\n{body[:400]}"
        ) from None


def revision_of(build: dict) -> str:
    revisions = build.get("revisions", {}).get("revision") or []
    return revisions[0].get("version", "") if revisions else ""


def newest_per_build_type(builds: list[dict]) -> list[dict]:
    """The builds arrive newest first, so the first sighting of each id is its latest."""
    seen: dict[str, dict] = {}
    for build in builds:
        seen.setdefault(build.get("buildTypeId", ""), build)
    return list(seen.values())


def leg_name(build: dict) -> str:
    return build.get("buildTypeId", "").removeprefix(f"{PROJECT}_")


def scoped(builds: list[dict]) -> list[dict]:
    """Only the configurations this project asked about, when it named any."""
    if not BUILD_TYPES:
        return builds
    return [b for b in builds if leg_name(b) in BUILD_TYPES]


def recent(count: int) -> list[dict]:
    return get(RECENT_BUILDS.format(project=PROJECT, count=count)).get("build") or []


def local_revisions() -> dict[str, str]:
    out: dict[str, str] = {}
    for name, ref in (("HEAD", "HEAD"), ("origin/main", "origin/main")):
        finished = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "rev-parse", ref],
            capture_output=True,
            text=True,
            check=False,
        )
        if finished.returncode == 0:
            out[name] = finished.stdout.strip()
    return out


def show_status(count: int) -> int:
    builds = recent(count)
    if not builds:
        print(f"No builds found for project {PROJECT}")
        return 1

    latest = scoped(newest_per_build_type(builds))
    red = [b for b in latest if b.get("status") != "SUCCESS"]

    width = max(len(leg_name(b)) for b in latest)
    for build in sorted(latest, key=leg_name):
        mark = "ok  " if build.get("status") == "SUCCESS" else "RED "
        print(
            f"{mark} {leg_name(build):<{width}}  #{build.get('number', '?'):<5} "
            f"{revision_of(build)[:8]}  {build.get('statusText', '')}"
        )

    tested = {revision_of(b) for b in latest if revision_of(b)}
    print()
    for name, sha in local_revisions().items():
        note = "" if sha in tested else "  <- not tested by any build above"
        print(f"local {name}: {sha[:8]}{note}")

    if red:
        print()
        print(
            f"{len(red)} red: "
            + ", ".join(f"{leg_name(b)} (id {b.get('id')})" for b in sorted(red, key=leg_name))
        )
        print("Read them with: npm run tc:failures")
    return 1 if red else 0


def show_builds(leg: str | None, count: int) -> int:
    """Which revision each recent build tested, so a first-failed build number names a commit."""
    builds = recent(count)
    if leg:
        wanted = leg.removeprefix(f"{PROJECT}_").lower()
        builds = [b for b in builds if leg_name(b).lower() == wanted]
    if not builds:
        print(f"No builds found for project {PROJECT}" + (f", configuration {leg}" if leg else ""))
        return 1

    width = max(len(leg_name(b)) for b in builds)
    for build in builds:
        mark = "ok  " if build.get("status") == "SUCCESS" else "RED "
        print(
            f"{mark} {leg_name(build):<{width}}  #{build.get('number', '?'):<5} "
            f"id {build.get('id'):<6} {revision_of(build)[:8]}  {build.get('statusText', '')}"
        )
    return 0


def red_leg_ids(count: int) -> list[int]:
    latest = scoped(newest_per_build_type(recent(count)))
    return [
        b["id"]
        for b in sorted(latest, key=leg_name)
        if b.get("status") != "SUCCESS" and leg_name(b) != COMPOSITE
    ]


def show_failures(build_ids: list[int], count: int) -> int:
    if not build_ids:
        build_ids = red_leg_ids(count)
        if not build_ids:
            print("Nothing red in the newest build of each configuration.")
            return 0

    for build_id in build_ids:
        print(f"=== build {build_id} ===")
        tests = get(FAILED_TESTS.format(build=build_id)).get("testOccurrence") or []
        for test in tests:
            muted = " [MUTED]" if test.get("currentlyMuted") else ""
            first = test.get("firstFailed", {}).get("build", {})
            print(f"{test.get('name')}{muted}")
            if first:
                print(
                    f"  first failed: {first.get('buildTypeId', '?')} #{first.get('number', '?')}"
                )
            for line in (test.get("details") or "").splitlines()[:6]:
                print(f"  {line}")
            print()
        problems = get(BUILD_PROBLEMS.format(build=build_id)).get("problemOccurrence") or []
        for problem in problems:
            print(f"problem {problem.get('type')}: {problem.get('identity')}")
            for line in (problem.get("details") or "").splitlines()[:6]:
                print(f"  {line}")
            print()
        if not tests and not problems:
            print("No failed test or build problem is recorded against this build.\n")
    return 0


def show_queue() -> int:
    running = get(RUNNING.format(project=PROJECT)).get("build") or []
    queued = get(QUEUED).get("build") or []
    if running:
        print("running:")
        for build in running:
            print(
                f"  id {build['id']} {leg_name(build)} #{build.get('number', '?')} "
                f"{build.get('percentageComplete', '?')}% {revision_of(build)[:8]} "
                f"{build.get('statusText', '')}"
            )
    if queued:
        print("queued:")
        for build in queued:
            print(f"  id {build['id']} {leg_name(build)}  {build.get('waitReason', '')}")
    if not running and not queued:
        print("Nothing is running and nothing is queued.")
    return 0


def build_state(build_id: int) -> dict:
    """Where one build has got to. A build still waiting is found under the queue."""
    url = BUILD_STATE.format(build=build_id)
    started = request(url)
    if started.returncode == 0:
        return json.loads(started.stdout)
    queued = request(QUEUED_BUILD.format(build=build_id))
    if queued.returncode == 0:
        return json.loads(queued.stdout)
    raise request_failed(url, started)


def watch_outcome(finished: list[dict]) -> int:
    """0 when every watched build succeeded, 1 when any did not."""
    return 0 if finished and all(b.get("status") == "SUCCESS" for b in finished) else 1


def show_watch(build_ids: list[int], interval: int, timeout: int) -> int:
    """Wait for builds to finish, inside the one command an agent sandbox exempts.

    An agent told to watch a build otherwise writes a loop round `status` with a
    `sleep` in it. The sandbox exemption for this script matches the command as
    typed, so the loop is sandboxed and its first request is refused, and a
    shell `sleep` is often not allowed at all. The waiting has to happen here.
    """
    if not build_ids:
        running = get(RUNNING.format(project=PROJECT)).get("build") or []
        queued = [
            b for b in get(QUEUED).get("build") or []
            if b.get("buildTypeId", "").startswith(f"{PROJECT}_")
        ]
        build_ids = [b["id"] for b in running + queued]
        if not build_ids:
            print(f"Nothing is running or queued in {PROJECT}.")
            return 0

    deadline = time.monotonic() + timeout
    states: dict[int, str] = {}
    finished: dict[int, dict] = {}
    while True:
        for build_id in build_ids:
            if build_id in finished:
                continue
            build = build_state(build_id)
            state = build.get("state", "?")
            if states.get(build_id) != state:
                states[build_id] = state
                print(
                    f"{leg_name(build)} #{build.get('number', '?')} id {build_id}: {state}"
                    f"  {revision_of(build)[:8]}",
                    flush=True,
                )
            if state == "finished":
                finished[build_id] = build
        if len(finished) == len(build_ids):
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            waiting = ", ".join(str(i) for i in build_ids if i not in finished)
            print(
                f"\nNot finished after {timeout}s: id {waiting}. "
                "Nothing was cancelled; watch again to keep waiting."
            )
            return 2
        time.sleep(min(interval, remaining))

    print()
    for build_id in build_ids:
        build = finished[build_id]
        mark = "ok  " if build.get("status") == "SUCCESS" else "RED "
        print(
            f"{mark} {leg_name(build)} #{build.get('number', '?')} id {build_id}"
            f"  {build.get('statusText', '')}"
        )
        if build.get("webUrl"):
            print(f"     {build['webUrl']}")
    return watch_outcome(list(finished.values()))


def show_chain(build_id: int | None, count: int) -> int:
    if build_id is None:
        if not COMPOSITE:
            print(
                f"{PROJECT} declares no composite in .teamcity/cli.json, so there is no\n"
                "chain to gather. Ask for one leg with --build, or use `status`."
            )
            return 1
        composites = [
            b for b in recent(count) if leg_name(b) == COMPOSITE and b.get("state") == "finished"
        ]
        if not composites:
            print(f"No finished {COMPOSITE} build in the last {count} builds.")
            return 1
        build_id = composites[0]["id"]

    top = get(CHAIN.format(build=build_id))
    print(
        f"{leg_name(top)} #{top.get('number', '?')} {top.get('status')} "
        f"{revision_of(top)[:8]}  {top.get('statusText', '')}"
    )
    print(f"  {top.get('webUrl', '')}")
    legs = top.get("snapshot-dependencies", {}).get("build") or []
    if not legs:
        print("  (no snapshot dependencies -- this is not a composite build)")
        return 0 if top.get("status") == "SUCCESS" else 1
    width = max(len(leg_name(b)) for b in legs)
    for leg in sorted(legs, key=leg_name):
        mark = "ok  " if leg.get("status") == "SUCCESS" else "RED "
        print(
            f"  {mark} {leg_name(leg):<{width}}  #{leg.get('number', '?'):<5} "
            f"id {leg.get('id')}  {leg.get('statusText', '')}"
        )
    return 0 if top.get("status") == "SUCCESS" else 1


def show_log(build_id: int, lines: int, pattern: str | None) -> int:
    body = fetch(BUILD_LOG.format(build=build_id), accept="text/plain")
    if LOG_DIR is not None:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        target = LOG_DIR / f"build-{build_id}.log"
        target.write_text(body)
        print(f"saved raw log to {target.relative_to(REPO_ROOT)}", file=sys.stderr)
    kept = body.splitlines()
    if pattern:
        import re

        matcher = re.compile(pattern)
        kept = [line for line in kept if matcher.search(line)]
        if not kept:
            print(f"Nothing in build {build_id}'s log matched {pattern!r}")
            return 1
    for line in kept[-lines:]:
        print(line)
    return 0


def extract_archive(body: bytes, out_dir: Path) -> list[Path]:
    """Unpack a TeamCity artifact archive under out_dir, refusing any entry that would land outside it."""
    root = out_dir.resolve()
    try:
        archive = zipfile.ZipFile(io.BytesIO(body))
    except zipfile.BadZipFile:
        raise SystemExit(
            f"TeamCity did not return a zip ({len(body)} bytes), starting: {body[:200]!r}"
        ) from None
    with archive:
        members = [m for m in archive.infolist() if not m.is_dir()]
        for member in members:
            name = PurePosixPath(member.filename)
            if name.is_absolute() or ".." in name.parts or "\\" in member.filename:
                raise SystemExit(f"The archive entry {member.filename!r} would land outside {root}")
        archive.extractall(root, members)
    return [root / m.filename for m in members]


def show_artifacts(
    build_id: int, path: str, get_path: str | None, out_dir: str | None, get_all: bool = False
) -> int:
    if get_all:
        if not out_dir:
            raise SystemExit("--get-all needs --out-dir DIR to write the artifacts into.")
        body = fetch_bytes(ARTIFACT_ARCHIVE.format(build=build_id, path=path.strip("/")))
        written = extract_archive(body, Path(out_dir))
        if not written:
            print(f"Build {build_id} published no artifact under {path or '/'!r}")
            return 0
        total = sum(f.stat().st_size for f in written)
        print(f"wrote {len(written)} files ({total} bytes) under {Path(out_dir).resolve()}")
        return 0
    if get_path:
        body = fetch_bytes(ARTIFACT_CONTENT.format(build=build_id, path=get_path))
        if out_dir:
            target = Path(out_dir) / Path(get_path).name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
            print(f"wrote {target} ({len(body)} bytes)")
        else:
            text = artifact_text(body)
            if text is None:
                raise SystemExit(
                    f"{get_path} is binary ({len(body)} bytes), so it is not printed. "
                    "Save it with --out-dir DIR."
                )
            sys.stdout.write(text)
        return 0

    listing = get(ARTIFACT_LIST.format(build=build_id, path=path.strip("/")))
    files = listing.get("file") or []
    if not files:
        print(f"Build {build_id} published no artifact under {path or '/'!r}")
        return 0
    for entry in files:
        children = entry.get("children", {}).get("file") or []
        size = entry.get("size")
        if size is None:
            print(f"{entry.get('name')}/")
        else:
            print(f"{entry.get('name')}  {size}")
        for child in children:
            print(f"  {entry.get('name')}/{child.get('name')}  {child.get('size', '')}")
    print("\nFetch one with: npm run tc:artifacts -- --build ID --get <path>")
    return 0


def test_locator_value(name: str) -> str:
    """A test name as a locator value, ready for the query string.

    TeamCity splits a locator on commas and parentheses, and real test names hold
    both, so a name sent as it is comes back 400. `$base64:` is the locator's own
    escape for a value, and it survives any character a test name can contain.
    """
    encoded = base64.urlsafe_b64encode(name.encode()).decode()
    return urllib.parse.quote(f"$base64:{encoded}", safe="")


def resolve_test_names(fragment: str, count: int) -> list[str]:
    """TeamCity matches a test name exactly, so a fragment is resolved against real builds first."""
    if ":" in fragment:
        return [fragment]
    latest = newest_per_build_type(recent(count))
    names: list[str] = []
    for build in sorted(latest, key=leg_name):
        if leg_name(build) not in TEST_LEGS or build.get("state") != "finished":
            continue
        for test in get(BUILD_TESTS.format(build=build["id"])).get("testOccurrence") or []:
            name = test.get("name", "")
            if fragment.lower() in name.lower():
                names.append(name)
    return names


def show_history(fragment: str, count: int, recent_count: int) -> int:
    names = resolve_test_names(fragment, recent_count)
    if not names:
        print(f"No test in the newest build of {', '.join(TEST_LEGS)} matches {fragment!r}")
        return 1
    for name in names:
        runs = get(TEST_HISTORY.format(name=test_locator_value(name), count=count)).get("testOccurrence") or []
        failed = sum(1 for r in runs if r.get("status") == "FAILURE")
        print(f"{name}")
        print(f"  {failed} failed of the last {len(runs)}")
        for run in runs:
            build = run.get("build", {})
            mark = "ok  " if run.get("status") == "SUCCESS" else "FAIL"
            print(
                f"  {mark} {leg_name(build)} #{build.get('number', '?')} "
                f"{run.get('duration', '?')}ms"
            )
        print()
    return 0


def properties_of(node: dict) -> dict[str, str]:
    """TeamCity's `{properties: {property: [{name, value}]}}` as a plain dict."""
    return {
        p.get("name", ""): p.get("value", "")
        for p in (node.get("properties", {}).get("property") or [])
    }


def print_settings(bt: dict) -> None:
    """One configuration, in the terms a Kotlin DSL has to reproduce."""
    print(f"=== {bt.get('id')}  —  {bt.get('name')!r}")
    if bt.get("uuid"):
        print(f"    uuid: {bt['uuid']}")
    if bt.get("type"):
        print(f"    type: {bt['type']}")
    if bt.get("paused"):
        print("    PAUSED")
    if bt.get("description"):
        print(f"    description: {bt['description']}")

    roots = [
        e.get("vcs-root", {}).get("id", "?") + (f" rules={e['checkout-rules']}" if e.get("checkout-rules") else "")
        for e in (bt.get("vcs-root-entries", {}).get("vcs-root-entry") or [])
    ]
    print(f"    vcs roots: {', '.join(roots) if roots else 'none'}")

    params = {
        p.get("name", ""): p.get("value", "")
        for p in (bt.get("parameters", {}).get("property") or [])
    }
    print("    parameters:" if params else "    parameters: none")
    for name, value in sorted(params.items()):
        print(f"      {name} = {value!r}")

    steps = bt.get("steps", {}).get("step") or []
    print(f"    steps: {len(steps)}" if steps else "    steps: none")
    for index, step in enumerate(steps, start=1):
        props = properties_of(step)
        mode = props.get("teamcity.step.mode", "default")
        print(f"      {index}. {step.get('name')!r} ({step.get('type')}, mode={mode})")
        for line in (props.get("script.content") or "").splitlines():
            print(f"         | {line}")

    for key, child, label in (
        ("triggers", "trigger", "triggers"),
        ("features", "feature", "features"),
        ("agent-requirements", "agent-requirement", "requirements"),
    ):
        items = bt.get(key, {}).get(child) or []
        print(f"    {label}:" if items else f"    {label}: none")
        for item in items:
            print(f"      {item.get('type')}")
            for name, value in sorted(properties_of(item).items()):
                print(f"        {name} = {value!r}")

    deps = bt.get("snapshot-dependencies", {}).get("snapshot-dependency") or []
    print("    snapshot dependencies:" if deps else "    snapshot dependencies: none")
    for dep in deps:
        print(f"      {dep.get('id')}")
        for name, value in sorted(properties_of(dep).items()):
            print(f"        {name} = {value!r}")

    # `buildNumberCounter` is where the next build number lives, not a setting
    # anybody writes down; everything else here is a real non-default option.
    options = {
        p.get("name", ""): p.get("value", "")
        for p in (bt.get("settings", {}).get("property") or [])
        if p.get("name") != "buildNumberCounter"
    }
    print("    options:" if options else "    options: all default")
    for name, value in sorted(options.items()):
        print(f"      {name} = {value!r}")
    print()


def show_settings(leg: str | None, as_json: bool) -> int:
    """What the configurations *are*: steps, triggers, locks, requirements, dependencies."""
    listing = get(PROJECT_BUILD_TYPES.format(project=PROJECT))
    ids = [b["id"] for b in (listing.get("buildTypes", {}).get("buildType") or [])]
    if leg:
        wanted = leg.removeprefix(f"{PROJECT}_").lower()
        ids = [i for i in ids if i.removeprefix(f"{PROJECT}_").lower() == wanted]
    if not ids:
        print(f"No configuration found in project {PROJECT}" + (f" named {leg}" if leg else ""))
        return 1

    project = get(PROJECT_SETTINGS.format(project=PROJECT))
    build_types = [get(BUILD_TYPE_SETTINGS.format(id=i)) for i in ids]
    for i, bt in zip(ids, build_types):
        bt["uuid"] = get(BUILD_TYPE_UUID.format(id=i)).get("uuid")

    roots = sorted(
        {
            entry.get("vcs-root", {}).get("id")
            for bt in build_types
            for entry in (bt.get("vcs-root-entries", {}).get("vcs-root-entry") or [])
            if entry.get("vcs-root", {}).get("id")
        }
    )
    vcs_roots = [get(VCS_ROOT.format(id=r)) for r in roots]

    if as_json:
        print(json.dumps(
            {"project": project, "buildTypes": build_types, "vcsRoots": vcs_roots},
            indent=2,
            sort_keys=True,
        ))
        return 0

    print(f"### project {project.get('id')}  —  {project.get('name')!r}")
    features = project.get("projectFeatures", {}).get("projectFeature") or []
    print("    project features:" if features else "    project features: none")
    for feature in features:
        print(f"      {feature.get('id')} {feature.get('type')}")
        for name, value in sorted(properties_of(feature).items()):
            print(f"        {name} = {value!r}")
    params = project.get("parameters", {}).get("property") or []
    print("    project parameters:" if params else "    project parameters: none")
    for p in params:
        print(f"      {p.get('name')} = {p.get('value')!r}")
    print()

    for root in vcs_roots:
        print(f"### vcs root {root.get('id')}  ({root.get('vcsName')})")
        for name, value in sorted(properties_of(root).items()):
            print(f"      {name} = {value!r}")
        print()

    for bt in build_types:
        print_settings(bt)
    return 0


def selftest() -> int:
    failures: list[str] = []

    argv = remote_command("app/rest/builds?locator=a:b")
    if any("Bearer" in part for part in argv):
        failures.append("the request argv carried a credential")
    if argv[0] != "ssh" or argv[-2] != HOST:
        failures.append(f"unexpected ssh invocation: {argv[:-1]}")
    if "-q" in argv or "LogLevel=QUIET" in argv:
        failures.append("the ssh invocation silences ssh's own errors")
    if "'http://localhost:8111/app/rest/builds?locator=a:b'" not in argv[-1]:
        failures.append(f"the url was not quoted into the remote command: {argv[-1]}")

    hostile = remote_command("app/rest/x?q=';id;'")
    if "; id ;" in hostile[-1] or hostile[-1].count("'") % 2 != 0:
        failures.append("a url with shell metacharacters escaped its quoting")

    hint = failure_hint(255, "ssh: connect to host h port 22: Operation not permitted")
    for form in ("python3 scripts/teamcity.py <command>", "./scripts/teamcity.py <command>", "watch"):
        if form not in hint:
            failures.append(f"the sandbox hint does not name {form!r}")

    if watch_outcome([{"status": "SUCCESS"}, {"status": "FAILURE"}]) != 1:
        failures.append("watch_outcome passed a set with a failed build in it")
    if watch_outcome([{"status": "SUCCESS"}]) != 0 or watch_outcome([]) != 1:
        failures.append("watch_outcome misjudged an all-green or an empty set")

    with tempfile.TemporaryDirectory() as scratch:
        packed = io.BytesIO()
        with zipfile.ZipFile(packed, "w") as archive:
            archive.writestr("logs/ui.log", "text")
            archive.writestr("shots/a.png", b"\x89PNG\0\xff")
        written = extract_archive(packed.getvalue(), Path(scratch))
        if sorted(f.relative_to(Path(scratch).resolve()).as_posix() for f in written) != [
            "logs/ui.log", "shots/a.png"
        ] or (Path(scratch) / "shots/a.png").read_bytes() != b"\x89PNG\0\xff":
            failures.append("extract_archive did not write every file, byte for byte, at its path")
        for climbing in ("../outside.txt", "a/../b.txt", "/abs.txt"):
            escaping = io.BytesIO()
            with zipfile.ZipFile(escaping, "w") as archive:
                archive.writestr(climbing, "x")
            try:
                extract_archive(escaping.getvalue(), Path(scratch) / "inner")
                failures.append(f"extract_archive accepted the climbing entry {climbing!r}")
            except SystemExit:
                pass
        try:
            extract_archive(b"<html>sign in</html>", Path(scratch) / "page")
            failures.append("extract_archive accepted a body that is not a zip")
        except SystemExit as refused:
            if "did not return a zip" not in str(refused):
                failures.append(f"a non-zip body was refused without saying so: {refused}")

    config = curl_config("SECRET-TOKEN")
    if not config.startswith('header = "Authorization: Bearer SECRET-TOKEN"'):
        failures.append("the curl config did not carry the token as a header")

    sample = [{"buildTypeId": f"{PROJECT}_Alpha"}, {"buildTypeId": f"{PROJECT}_Omega"}]
    if BUILD_TYPES:
        kept = {leg_name(b) for b in scoped(sample)}
        if kept - set(BUILD_TYPES):
            failures.append(f"scoped kept a configuration outside buildTypes: {kept}")
    elif len(scoped(sample)) != 2:
        failures.append("scoped dropped builds when no whitelist was configured")

    newest = newest_per_build_type(
        [
            {"buildTypeId": "P_Ui", "number": "9", "status": "FAILURE"},
            {"buildTypeId": "P_Ui", "number": "8", "status": "SUCCESS"},
            {"buildTypeId": "P_Unit", "number": "3", "status": "SUCCESS"},
        ]
    )
    if [b["number"] for b in newest] != ["9", "3"]:
        failures.append(f"newest_per_build_type kept the wrong builds: {newest}")

    if revision_of({"revisions": {"revision": [{"version": "abc123"}]}}) != "abc123":
        failures.append("revision_of did not read the revision")
    if revision_of({}) != "":
        failures.append("revision_of did not tolerate a build with no revision")

    if leg_name({"buildTypeId": f"{PROJECT}_UiPhone"}) != "UiPhone":
        failures.append("leg_name did not strip the project prefix")

    root = ARTIFACT_LIST.format(build=7, path="")
    nested = ARTIFACT_LIST.format(build=7, path="logs")
    for url in (root, nested):
        if url.count("?") != 1 or "&fields" in url:
            failures.append(f"the artifact listing url is malformed: {url}")
    if "children/?fields=" not in root:
        failures.append(f"an empty artifact path did not keep its query separator: {root}")
    if "children/logs?fields=" not in nested:
        failures.append(f"a nested artifact path did not keep its query separator: {nested}")

    # A name that already looks fully qualified is used as given, without a lookup.
    qualified = "FunMax iPad.Suite: FunMax iPad.Suite.testThing()"
    if resolve_test_names(qualified, 1) != [qualified]:
        failures.append("a fully qualified test name was not passed through")

    awkward = "a.test.ts: Suite > refuses (a, b), and never (c"
    value = urllib.parse.unquote(test_locator_value(awkward))
    if not value.startswith("$base64:") or any(c in value for c in ",()"):
        failures.append(f"a test name with commas or parentheses reached the locator raw: {value}")
    elif base64.urlsafe_b64decode(value.removeprefix("$base64:")).decode() != awkward:
        failures.append("a test name did not survive its locator encoding")

    if artifact_text(b"PK\x03\x04\x14\x00\xa0\x00") is not None:
        failures.append("a zip artifact was taken for text")
    if artifact_text(b"\x89PNG\r\n\x1a\n\x00") is not None:
        failures.append("a png artifact was taken for text")
    if artifact_text("caf\u00e9 ok\n".encode()) != "caf\u00e9 ok\n":
        failures.append("a utf-8 text artifact was not read as text")

    every = "".join(
        [
            RECENT_BUILDS,
            FAILED_TESTS,
            BUILD_PROBLEMS,
            QUEUED,
            RUNNING,
            BUILD_STATE,
            QUEUED_BUILD,
            CHAIN,
            ARTIFACT_LIST,
            ARTIFACT_CONTENT,
            BUILD_LOG,
            TEST_HISTORY,
            BUILD_TESTS,
        ]
    )
    for verb in ("action=", "/trigger", "buildQueue?", "mute", "delete", "pin"):
        if verb in every and verb != "buildQueue?":
            failures.append(f"a url template reaches a state change: {verb}")

    for problem in failures:
        print(f"FAIL {problem}")
    print(f"teamcity.py selftest: {'FAILED' if failures else 'ok'}")
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--selftest", action="store_true", help="check this script, touch nothing")
    parser.add_argument(
        "--count", type=int, default=40, help="how many recent builds to read (default 40)"
    )
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("status", help="the newest build of every configuration, and what it tested")

    failures = sub.add_parser("failures", help="failed tests and build problems on the red legs")
    failures.add_argument(
        "--build", type=int, action="append", default=[], help="a build id; repeatable"
    )

    sub.add_parser("queue", help="what is running and what is waiting, and why")

    trigger = sub.add_parser("trigger", help="queue a configuration (default: the composite)")
    trigger.add_argument("--leg", help="configuration name or full id")
    trigger.add_argument("--branch", help="logical branch name (default: the configuration's default)")
    rerun = sub.add_parser("rerun", help="rerun a build at its recorded revisions")
    rerun.add_argument("--build", type=int, required=True)
    cancel = sub.add_parser("cancel", help="cancel a running or queued build, retaining its history")
    cancel.add_argument("--build", type=int, required=True)
    cancel.add_argument("--yes", action="store_true", help="perform the cancellation without a prompt")
    move = sub.add_parser("move", help="move a queued build to first or last in the server queue")
    move.add_argument("--build", type=int, required=True)
    move.add_argument("--position", choices=("first", "last"), required=True)
    for operation in (trigger, rerun, cancel, move):
        operation.add_argument("--dry-run", action="store_true", help="validate and show the request without changing CI")
    for operation in (trigger, rerun, cancel):
        operation.add_argument("--comment", default="Requested by coding agent", help="reason recorded in TeamCity")

    watch = sub.add_parser("watch", help="wait until builds finish, then how each one ended")
    watch.add_argument(
        "--build", type=int, action="append", default=[],
        help="a build id; repeatable (default: whatever is running or queued now)",
    )
    watch.add_argument("--interval", type=int, default=30, help="seconds between checks (default 30)")
    watch.add_argument(
        "--timeout", type=int, default=3600, help="stop waiting after this many seconds (default 3600)"
    )

    builds = sub.add_parser("builds", help="recent builds and the revision each one tested")
    builds.add_argument("--leg", default=None, help="one configuration, such as UiPhone")

    chain = sub.add_parser("chain", help="a composite build and every leg under it")
    chain.add_argument("--build", type=int, default=None, help="a build id (default: newest Verdict)")

    log = sub.add_parser("log", help="a build's log, filtered")
    log.add_argument("--build", type=int, required=True)
    log.add_argument("--lines", type=int, default=80, help="how many lines to show (default 80)")
    log.add_argument("--grep", default=None, help="keep only lines matching this regex")

    artifacts = sub.add_parser("artifacts", help="what a build published, and one file's content")
    artifacts.add_argument("--build", type=int, required=True)
    artifacts.add_argument("--path", default="", help="a directory inside the artifacts")
    fetching = artifacts.add_mutually_exclusive_group()
    fetching.add_argument("--get", default=None, help="an artifact path to fetch")
    artifacts.add_argument("--out-dir", default=None, help="write the fetched artifact here")
    fetching.add_argument(
        "--get-all", action="store_true",
        help="fetch every artifact under --path (default all of them) into --out-dir, at their paths relative to --path",
    )

    history = sub.add_parser("history", help="how often one test has failed, and where")
    history.add_argument("test", help="a full test name, or a fragment of one")
    history.add_argument("--runs", type=int, default=15, help="how many runs to read (default 15)")

    settings = sub.add_parser(
        "settings", help="what the configurations are: steps, triggers, locks, requirements"
    )
    settings.add_argument("--leg", default=None, help="one configuration, such as Verify")
    settings.add_argument(
        "--json", action="store_true", help="the raw records, for diffing across a change"
    )
    settings.add_argument(
        "--sync-status", action="store_true",
        help="the whole project's versioned-settings import status and compile errors, as JSON; "
        "exits 1 unless the server reports type info",
    )

    args = parser.parse_args()
    if args.selftest:
        return selftest()
    if args.command in ("trigger", "rerun", "cancel", "move"):
        if args.command == "cancel" and not args.dry_run and not args.yes:
            parser.error("cancel requires --yes (or use --dry-run to preview)")
        if args.command != "trigger" and args.build <= 0:
            parser.error("--build must be a positive build id")
        # The project shim executes this file with runpy; make its sibling module
        # importable from the plugin directory as well as when called directly.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from teamcity_operations import BuildOperations, TeamCityClient

        log_path = REPO_ROOT / "tmp" / "logs" / "teamcity-operations.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        print(f"Log: {log_path}")
        with log_path.open("a") as log_file:
            def log_event(message: str) -> None:
                log_file.write(message)
                log_file.flush()

            client = TeamCityClient(HOST, CONTAINER, BASE_URL, read_token, subprocess.run, time.monotonic, log_event)
            operations = BuildOperations(client.get, PROJECT, COMPOSITE)
            if args.command == "trigger":
                action = operations.trigger(args.leg, args.branch, args.comment)
            elif args.command == "rerun":
                action = operations.rerun(args.build, args.comment)
            elif args.command == "cancel":
                action = operations.cancel(args.build, args.comment)
            else:
                action = operations.move(args.build, args.position)
            if action is None:
                print(f"Build {args.build} is already finished; nothing to cancel.")
                return 0
            log_event(f"{'preview' if args.dry_run else 'execute'}: {action.description}\n")
            if args.dry_run:
                print(f"Would {action.description}: {action.method} {action.path}\n{action.body}")
                return 0
            result = client.send(action)
            print(f"{action.description}: id {result.get('id', '?')} {result.get('webUrl', '')}".rstrip())
        return 0
    if args.command == "failures":
        return show_failures(args.build, args.count)
    if args.command == "queue":
        return show_queue()
    if args.command == "watch":
        return show_watch(args.build, args.interval, args.timeout)
    if args.command == "builds":
        return show_builds(args.leg, args.count)
    if args.command == "chain":
        return show_chain(args.build, args.count)
    if args.command == "log":
        return show_log(args.build, args.lines, args.grep)
    if args.command == "artifacts":
        return show_artifacts(args.build, args.path, args.get, args.out_dir, args.get_all)
    if args.command == "history":
        return show_history(args.test, args.runs, args.count)
    if args.command == "settings":
        if args.sync_status:
            # Import status belongs to the whole project, so a leg filter or the
            # raw-records flag would be silently meaningless here.
            if args.leg or args.json:
                parser.error("--sync-status covers the whole project and takes no --leg or --json")
            status = get(f"app/rest/projects/id:{PROJECT}/versionedSettings/status")
            print(json.dumps(status, indent=2))
            # Anything but "info" is a warning or a failed compile, and a caller
            # going by the exit code must not read that as a pass.
            return 0 if status.get("type") == "info" else 1
        return show_settings(args.leg, args.json)
    return show_status(args.count)


if __name__ == "__main__":
    sys.exit(main())
