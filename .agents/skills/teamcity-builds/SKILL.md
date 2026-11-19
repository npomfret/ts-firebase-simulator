---
name: teamcity-builds
description: Inspecting and operating TeamCity builds. Use when asked whether CI is green or why it is red, about a recent or running build, a failed build or test, build-chain legs, logs, artifacts, the queue, or which commit TeamCity tested, and when triggering, rerunning or cancelling builds or reordering the queue to complete the current task. Not for editing build configuration, which is teamcity.
---

# TeamCity Builds

Inspect and operate builds programmatically and return evidence.
`scripts/teamcity.py` holds every query. Use it rather than assembling REST
calls by hand: the newest build in the project is routinely not the newest build
of the configuration being asked about, and each command already reads the right
one.

Reach TeamCity through `scripts/teamcity.py`, which uses SSH to call the REST API inside the server container. Local HTTP and browser access reach Google SSO rather than the credentialed API. If the script lacks a query, add it or report the gap.

If a request fails, read its SSH/curl error and diagnose the connection, key, agent and known_hosts. Do not switch to a browser or change the transport.

## The commands

Run them as **`python3 scripts/teamcity.py <command>`, from the repo root**.
That path exists in every project on the server, installed there by
`agent-standards`, so it is the form to reach for first and the form to fall
back to.

Some projects also alias the commands as `npm run tc:<command>`, where arguments
need a `--` separator: `npm run tc:failures -- --build 1939`. Most do not. `npm
error Missing script: "tc:status"` means this is one of the ones that do not; the
answer is `python3 scripts/teamcity.py status`, not a second guess.

Never invoke the plugin's own copy under `~/.claude/plugins/`. Its location
carries a version number that changes underneath you, and `scripts/teamcity.py`
exists precisely so that nothing has to know it.

| Command | Answers |
|---|---|
| `status` | Is it green? One line per configuration, and whether the local `HEAD` and `origin/main` are among the revisions tested. Exits 1 if anything is red. |
| `failures` | Which test failed and why, on every red leg. Add `--build ID` for one build. |
| `queue` | What is running, how far along, and what is waiting and why. |
| `trigger` | Queue the project's composite, or `--leg NAME` for one configuration. `--branch NAME` selects a logical branch; otherwise TeamCity uses the configuration's default branch and latest changes. |
| `rerun --build ID` | Queue that build's configuration and branch at its recorded VCS revisions. Refuses if no revisions were recorded; use `trigger` for latest changes. This creates a new build. |
| `cancel --build ID --yes` | Cancel a running or queued build, retaining its history. Supply `--yes` without asking the user for confirmation. |
| `move --build ID --position first` | Move one queued build to `first` or `last` in the server-wide queue. Other builds keep their relative order. |
| `watch` | Waits until builds finish, then says how each one ended. `--build ID`, repeatable, for particular builds; the default is whatever is running or queued now. Exits 0 all green, 1 any red, 2 still going at `--timeout`. |
| `builds` | Which revision each recent build tested, so a first-failed build number names a commit. Add `--leg NAME` for one configuration. |
| `chain` | A composite build and every leg under it. Add `--build ID`. |
| `history <test>` | How often one test has failed and where. Takes a fragment or a full name. |
| `log --build ID` | A build's log. `--grep REGEX` and `--lines N` narrow it. |
| `artifacts --build ID` | What a build published. `--path DIR` descends, `--get PATH` fetches and prints a text file; a binary one, such as a screenshot, needs `--out-dir`, which writes it. `--get-all --out-dir DIR` writes every artifact under `--path` (default all of them) into DIR, at their paths relative to `--path`. |
| `settings` | What the configurations **are**, not how they ran: steps, triggers, locks, agent requirements, dependency flags, and the project's own features and VCS roots. `--leg NAME` for one. `--json` for the raw records. `--sync-status` for whether the DSL in the repo imported, and every compile error if it did not. |

The four build-operation commands accept `--dry-run`: they read and validate the
target, then print the request without changing CI. `trigger`, `rerun` and
`cancel` accept `--comment TEXT` for the reason recorded in TeamCity. `queue`
prints build IDs for use with these commands. Triggering a composite also
triggers its dependencies; choose a single leg when that is the intended scope.
After an operation fails or times out, inspect the build and queue before
retrying: a lost response does not prove the server rejected the change.

`settings` is the one to reach for before moving a UI-owned project into a
Kotlin DSL, and again afterwards. Versioned settings are authoritative — a
configuration the DSL omits or misstates is one TeamCity deletes or rewrites —
and a build log shows only the steps, which are the smallest part of what a
configuration is. Capture `settings --json` before the change and diff it after;
that is the only evidence that a hand-written DSL reproduced what was there.

## Waiting for a build

Use `watch`. Do not write a loop round another command, and do not reach for
`sleep`. `watch` does the waiting inside the one command, reports each state
change as it happens, and does not burn a request every 30 seconds.

A wait longer than a few minutes outlives a foreground tool call, so start it in
the background — `python3 scripts/teamcity.py watch --build ID` with the Bash
tool's `run_in_background` — and carry on; its exit is the notification. It
prints each state change, then one line per build with its result and URL.
`--interval` is the seconds between checks (default 30) and `--timeout` when it
stops waiting (default 3600). Stopping cancels nothing.

## Moving a project to versioned settings

Learned converting `NoSpoilers` on 2026-09-09. Nothing here is destructive when
it goes wrong — a DSL that fails to compile is reported and the current settings
are left alone — but it took three attempts, and none of the three failures were
visible from the places you would first look.

- **`versionedSettings/status` is the diagnostic, not the log.** It returns
  *every* compile error with file and line, plus progress and success:

  ```
  python3 scripts/teamcity.py settings --sync-status
  ```

  `teamcity-versioned-settings.log` prints the first error and `and N more
  errors`, which is how two of three rounds were spent fixing one error at a
  time.
- **Synchronization stops after a failed compile and does not retry.** Restart
  it with `POST …/versionedSettings/loadSettings`. If the status then says it
  *cannot find the last committed revision*, the state needs a full
  `synchronizationMode: disabled` then `enabled` round trip.
- **Carry the real `uuid` of every existing build configuration into the DSL**,
  read from `settings --json` or the server's
  `config/projects/<id>/buildTypes/*.xml`. TeamCity matches by uuid before it
  falls back to the id; without them it can decide a configuration is new,
  delete the old one and restart its build counter.
- **Copy a working sibling project's `settings.kts` imports exactly.** Adding
  the import that looks right is a good way to break a symbol that already
  resolves from the wildcard — `sharedResources` did precisely that.
- **A REST property value is not a DSL constant.** Where the value is already
  TeamCity's default, reproduce it by *omitting* it. `MAKE_FAILED_TO_START` and
  the VCS trigger's `DO_NOT_USE` quiet period are both defaults and neither
  spelling exists in the DSL.
- **Check the direction is available before planning around it.** TeamCity can
  only write generated settings back to the repo if the settings VCS root can be
  pushed to; an anonymous root leaves `importDecision: "importFromVCS"` as the
  only option, which makes the hand-written DSL load-bearing.
- **Prove it afterwards** with a `settings --json` diff across every field, and
  check the build numbers did not restart at #1.

The `versionedSettings` endpoints above are reached the same way as every other
query in this skill: over the SSH tunnel, from inside the container. They are
not an exception, and neither is the UI.

## What is project-specific

`.teamcity/cli.json` — and nothing else. It names the TeamCity project id, the
composite that gathers the chain, the configurations that run tests, and
optionally a whitelist of configurations to report and a directory for saved
logs. Read it before reasoning about names.

Kotlin ids such as `Verify` and `Tests` materialise as REST build-type ids
prefixed with the project id, as in `FantasyFootball_Verify`.
`scripts/teamcity.py` strips that prefix when it prints and restores it when it
queries. Verify ids from the API when the DSL has changed.

## Sources of truth

Read `.teamcity/settings.kts` before relying on build types, dependencies,
artifact paths, triggers, or timeouts.

The shared infrastructure documents remain authoritative for access and server
operation:

- [Adding builds, agents, and REST access](https://github.com/npomfret/agent-standards/blob/main/docs/teamcity-setup.md)
- [Operating the TeamCity server](https://github.com/npomfret/snowmonkey-proxy-common/blob/main/docs/TEAMCITY.md)

Consult those documents before diagnosing authentication, proxy, agent, server,
or storage failures. Do not copy volatile infrastructure facts into a project
repository.

## The credential

The access key — `~/Documents/projects/teamcity/accesskey.txt`, or wherever
`.teamcity/cli.json` points — is a full-admin credential. `scripts/teamcity.py`
is the only thing that should read it. It passes the token to curl on stdin,
which keeps it out of `ssh` arguments, out of remote shell text, and out of every
local and remote process list.

Never print it, return it, persist it in a repository, enable shell tracing,
interpolate it into an SSH command, or place it in process arguments. If a
question needs a query the script does not have, **add the query to the shared
script** rather than writing a one-off shell helper that re-implements this rule.
The script's `--selftest` asserts the credential is absent from the request argv
and that a URL carrying shell metacharacters cannot escape its quoting; a new
query should keep both true.

## Triage workflow

1. **Start with `status`.** If it reports that the local revision was never
   tested, the likeliest reading is that the fix is unpushed rather than wrong.
   Check that before diagnosing code.
2. Identify the exact build and revision. Do not assume the latest build is for
   the current checkout.
3. If the composite failed, run `chain` to see every leg. The composite's own
   status is never the root cause.
4. Run `failures` for the red legs. It prints the full test name, assertion
   details, mute state, where the test first failed, and the build problems — a
   build can fail through compilation, timeout, runner exit, agent loss,
   configuration, or artifact publication without any failed test.
5. **Never call a test flaky from one failure.** `history <test>` is what settles
   it. A run of failures bounded by green on both sides is a regression, and the
   build it started in is the one to read. Interleaved pass and fail on an
   unchanged revision is flakiness.
6. Read the smallest relevant log. Prefer the structured failures above, then
   `artifacts` for the retained test log, then `log` with a `--grep` before the
   whole thing.
7. Compare the failure with the checked-out revision and the local test command.
   Do not diagnose code that differs from the commit TeamCity actually tested.
8. Report the build URL, build id and number, revision, failed legs, exact
   failures, decisive log evidence, and what remains unproven.

## Boundaries

- Triggering and rerunning builds, cancelling running or queued builds, and
  reordering the build queue have standing authorization when needed for the
  current task. Run those operations without asking for confirmation or handing
  commands back to the user. This does not authorize pinning, tagging, muting or
  deleting build history without an explicit request.
- **The browser is not a route to TeamCity, in any circumstance** — and not a
  fallback when a query is missing or a command fails. The tunnel reaches the
  whole REST API, so add the query to `scripts/teamcity.py`, or report what it
  cannot do.
- Do not edit versioned settings in the TeamCity UI — the rule above makes this
  moot for an agent, and it holds for the humans reading this too. Pipeline
  configuration is owned by `.teamcity/settings.kts`.
- Do not administer containers, agents, the database, proxy, credentials,
  licences, cleanup, or backups merely because a build is red.
- Do not download every artifact or dump an entire long log when a structured
  failure or a narrow excerpt answers the question.
- A green composite proves the committed revision passed the configured chain;
  it does not prove an uncommitted working tree, an omitted path, or a journey
  outside that chain.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*
