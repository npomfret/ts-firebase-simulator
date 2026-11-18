"""Build operations for the shared CLI; dependencies are supplied by its entry point."""

from __future__ import annotations

import json
import shlex
import subprocess
from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class BuildAction:
    method: str
    path: str
    body: str
    description: str


@dataclass(frozen=True)
class TeamCityClient:
    host: str
    container: str
    base_url: str
    token_reader: Callable[[], str]
    run: Callable[..., subprocess.CompletedProcess]
    clock: Callable[[], float]
    log: Callable[[str], object]

    def request(self, method: str, path: str, body: str | None) -> dict:
        # Both the credential and JSON body travel through curl's stdin config.
        token = self.token_reader()
        config = (
            f'header = "Authorization: Bearer {token}"\n'
            'header = "Accept: application/json"\n'
            f'request = "{method}"\n'
        )
        if body is not None:
            config += 'header = "Content-Type: application/json"\n'
            config += f"data = {json.dumps(body)}\n"
        remote = shlex.join([
            "docker", "exec", "-i", self.container, "curl", "--silent",
            "--show-error", "--fail-with-body", "--max-time", "10",
            "--config", "-", f"{self.base_url}/{path}",
        ])
        started = self.clock()
        self.log(f"{method} {path}: started\n")
        try:
            result = self.run(
                ["ssh", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=5", self.host, remote],
                input=config, capture_output=True, text=True, check=False, timeout=15,
            )
        except subprocess.TimeoutExpired:
            self.log(f"{method} {path}: timed out after {self.clock() - started:.3f}s (limit 15s)\n")
            raise SystemExit(
                f"TeamCity {method} {path} timed out after 15s. "
                "Its outcome is unknown; inspect the queue before retrying."
            ) from None
        self.log(f"{method} {path}: exit {result.returncode} after {self.clock() - started:.3f}s\n")
        if result.returncode:
            detail = (result.stderr or result.stdout).strip()
            # curl may echo a failed request; never emit the credential.
            detail = detail.replace(token, "[redacted]") if token else detail
            raise SystemExit(
                f"TeamCity {method} {path} failed ({result.returncode}): {detail}\n"
                "Inspect the build and queue before retrying a state change."
            )
        try:
            return json.loads(result.stdout) if result.stdout.strip() else {}
        except json.JSONDecodeError:
            raise SystemExit(
                f"TeamCity {method} {path} returned invalid JSON. "
                "Inspect the build and queue before retrying a state change."
            ) from None

    def get(self, path: str) -> dict:
        return self.request("GET", path, None)

    def send(self, action: BuildAction) -> dict:
        return self.request(action.method, action.path, action.body)


@dataclass(frozen=True)
class BuildOperations:
    read: Callable[[str], dict]
    project: str
    composite: str | None

    def trigger(self, leg: str | None, branch: str | None, comment: str) -> BuildAction:
        name = leg or self.composite
        if not name:
            raise SystemExit("This project has no composite; specify trigger --leg NAME.")
        listing = self.read(f"app/rest/projects/id:{self.project}?fields=buildTypes(buildType(id))")
        ids = [item["id"] for item in listing.get("buildTypes", {}).get("buildType", [])]
        wanted = name.removeprefix(f"{self.project}_").lower()
        matches = [value for value in ids if value.removeprefix(f"{self.project}_").lower() == wanted]
        if len(matches) != 1:
            raise SystemExit(f"No unique configuration {name!r} in project {self.project}.")
        payload = {"buildType": {"id": matches[0]}, "comment": {"text": comment}}
        if branch is not None:
            payload["branchName"] = branch
        return BuildAction("POST", "app/rest/buildQueue", json.dumps(payload), f"Queue {matches[0]}")

    def rerun(self, build_id: int, comment: str) -> BuildAction:
        source = self.read(
            f"app/rest/builds/id:{build_id}?fields=id,buildTypeId,branchName,"
            "revisions(revision(version,vcsBranchName,vcs-root-instance(id)))"
        )
        payload = {"buildType": {"id": source["buildTypeId"]}, "comment": {"text": comment}}
        if "branchName" in source:
            payload["branchName"] = source["branchName"]
        revisions = source.get("revisions", {}).get("revision", [])
        if not revisions:
            raise SystemExit(
                f"Build {build_id} has no recorded VCS revisions; "
                "use trigger to build the latest changes instead."
            )
        payload["revisions"] = {"revision": revisions, "failOnMissingRevisions": True}
        return BuildAction(
            "POST", "app/rest/buildQueue", json.dumps(payload),
            f"Rerun build {build_id} at its recorded revisions",
        )

    def cancel(self, build_id: int, comment: str) -> BuildAction | None:
        # This endpoint also resolves builds that have started since being queued.
        build = self.read(f"app/rest/buildQueue/id:{build_id}?fields=id,state,buildTypeId")
        state = build.get("state")
        if state == "finished":
            return None
        if state not in ("queued", "running"):
            raise SystemExit(f"Build {build_id} has unexpected state {state!r}; nothing cancelled.")
        collection = "buildQueue" if state == "queued" else "builds"
        return BuildAction(
            "POST", f"app/rest/{collection}/id:{build_id}",
            json.dumps({"comment": comment, "readdIntoQueue": False}),
            f"Cancel {state} build {build_id}",
        )

    def move(self, build_id: int, position: str) -> BuildAction:
        if position not in ("first", "last"):
            raise ValueError("Queue position must be first or last.")
        build = self.read(f"app/rest/buildQueue/id:{build_id}?fields=id,state")
        if build.get("state") != "queued":
            raise SystemExit(f"Build {build_id} is not queued; nothing moved.")
        return BuildAction(
            "PUT", f"app/rest/buildQueue/order/{position}", json.dumps({"id": build_id}),
            f"Move build {build_id} to {position} in the server queue",
        )
