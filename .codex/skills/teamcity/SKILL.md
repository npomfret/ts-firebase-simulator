---
name: teamcity
description: >-
  The required recipe for every build this project runs on our TeamCity
  server, ci.snowmonkey.co.uk: .teamcity/settings.kts, pom.xml, cli.json and
  the scripts/teamcity.py shim. Load this before creating, changing,
  renaming or reviewing a build configuration, its triggers, test reporting
  or Apple build steps, and before attaching a project to the server. Covers
  reaching the server only through scripts/teamcity.py, what may run in CI
  and what may not (no Docker or live services), the fixed configuration
  names, renaming with the existing uuid, legs plus an All Checks
  composite, toolchain checks instead of agent requirements, the trigger
  rules and staggered nightly, JUnit XML on the Tests tab, simulators and
  Xcode locks, saying what a green build proves, and the server-side steps
  handed to the user.
---

## TeamCity builds

Every project that builds in CI builds on our own TeamCity server,
`ci.snowmonkey.co.uk`, and every build on it follows one recipe. A project does
not invent its own shape, names or triggers: read a sibling project's
`.teamcity/settings.kts` and copy it. Good references are
`~/projects/energy-stats` (Node), `~/projects/fantasy-football` (Node, several
legs, browser tests) and `~/projects/super-funmax-music` (iOS and macOS on
simulators, then delivery to TestFlight).

The full background is `~/projects/agent-standards/docs/teamcity-setup.md`, at
that path on every Mac. For Apple delivery, read
`~/projects/agent-standards/docs/apple-testflight-delivery.md` as well. Those
are the reference; this is the part every build must get right.

### Reaching the server

- **Only through `scripts/teamcity.py`**, run from the repo root as
  `python3 scripts/teamcity.py <command>`. It opens an SSH tunnel to the
  TeamCity container on `snowmonkey.co.uk` and calls the REST API from there.
  The `teamcity-builds` skill lists its commands and the triage workflow.
- **Never through a browser,** and never with `curl` at
  `https://ci.snowmonkey.co.uk`. The UI and `/app/rest` both sit behind Google
  sign-in, and an agent has no Google session, so either way ends at a login
  page.
- The access token is a full-admin credential, in iCloud Drive under
  `projects/teamcity/`. Only the script reads it, and it travels only on curl's
  stdin: never in an argument, a remote shell string, a log or a repo.
- The script is read-only, and stays that way. Changing anything on the server
  (creating a project, attaching a repo, starting or cancelling a build) is the
  user's decision. Prepare the exact steps and hand them over, as described
  under "Attaching it to the server" below.

### What may run

- **Allowed:** compiling, linting, typechecking, unit and other in-process test
  suites, browser tests against network fixtures, and iOS or macOS builds and
  tests on simulators.
- **Not allowed yet:** anything that needs Docker or other infrastructure. That
  covers `docker build`, `docker run`, compose, Postgres or any other service a
  suite would start, and anything that reaches a deployed server or needs
  credentials in order to test. Such a suite stays local, and the settings say
  so (see "What green means" below).
- The three build agents are one shared Mac (`macstudio.local`, macOS/arm64,
  agents running as `nickpomfret`). A build brings or selects its own toolchain
  and never installs software on the host.

### Files in the repo

```
.teamcity/settings.kts   # the build, Kotlin DSL, `version = "2026.1"`
.teamcity/pom.xml        # copied from a sibling; rename name/groupId/artifactId
.teamcity/cli.json       # what scripts/teamcity.py needs to know about this project
scripts/teamcity.py      # the shared shim, byte-identical everywhere
```

- **`pom.xml`**: `groupId` is the TeamCity project id, in PascalCase from the
  repo name (`EnergyStats`). `artifactId` is that id plus `_dsl`.
- **`cli.json`**:
  ```json
  {
    "project": "EnergyStats",
    "composite": "AllChecks",
    "buildTypes": ["StaticChecks", "UnitTests", "AllChecks"],
    "testLegs": ["UnitTests"],
    "logDir": "tmp/teamcity"
  }
  ```
  The `logDir` must be gitignored.
- **`scripts/teamcity.py`**: copy it from a sibling project, or from
  `~/projects/agent-standards/templates/teamcity-shim.py`. Never edit it.
  agent-standards' `sync.py` rewrites it in every repo that has a
  `.teamcity/cli.json`.
- **Imports**: copy them exactly from a sibling `settings.kts`. Adding one that
  looks right can break a symbol that already resolves from the wildcard import.

### Names

Every build configuration's name says what kind of check it is. Its Kotlin id
is the name with spaces and brackets removed, so the REST id is the project id
plus that, for example `EnergyStats_UnitTests`. Use only these names:

| Name | Id | What it runs |
|---|---|---|
| `Static Checks` | `StaticChecks` | lint, format, typecheck, compile and bundle. No tests. |
| `Unit Tests` | `UnitTests` | the unit suite, and nothing else |
| `Integration Tests` | `IntegrationTests` | in-process integration suites, with no Docker or live services |
| `Browser Tests` | `BrowserTests` | Playwright or browser-mode suites against fixtures |
| `UI Tests (iOS)` | `UiTestsIos` | XCUITest on a simulator, one configuration per platform: `UI Tests (macOS)`, … |
| `All Checks` | `AllChecks` | the composite. It runs nothing itself, and is the one light per commit. |
| `TestFlight Delivery` | `TestFlightDelivery` | delivery of the revision `All Checks` passed |
| `Deploy (Production)` | `DeployProduction` | a deployment configuration, one per target |

Never `Tests`, `Unit`, `Checks`, `Verify`, `Verdict` or `Build & Unit`. If a
new kind of leg is needed, ask the user for its name and add it to this table
in agent-standards first.

To rename an existing configuration, keep its history by putting its current
`uuid` in the DSL, read with `python3 scripts/teamcity.py settings --json`:

```kotlin
id("UnitTests")
uuid = "<the configuration's existing uuid>"
```

Without the uuid, TeamCity deletes the old configuration, creates a new one, and
the build counter restarts at #1. Update `cli.json` in the same commit.

### Shape

- **Legs plus a composite.** Each kind of check is its own configuration, so a
  red build says what broke, the legs can run at the same time on the three
  agents, and per-test history belongs to a build that only runs tests.
  `All Checks` is `type = BuildTypeSettings.Type.COMPOSITE` and takes a
  `snapshot(...) { onDependencyFailure = FailureAction.ADD_PROBLEM }` on each
  leg. A project with a single leg needs no composite.
- **The triggers go on the composite only.** It pulls its legs in, so there is
  one trigger and one place to change it.
- **CI calls the project's own commands** (`npm run test:unit`,
  `./scripts/verify.sh unit`). It never re-spells what they do, so a step added
  to the developer command reaches CI too.
- **Every leg** has:
  - `maxRunningBuilds = 1`
  - `param("env.TMPDIR", "%system.teamcity.build.tempDir%")`, because the shared
    Mac's own temp dir is used by every project on it
  - `vcs { root(DslContext.settingsRoot) }`
  - an `executionTimeoutMin`
- **No agent requirements.** The agents report no capability that honestly means
  "has Node 22", and a build that no agent accepts sits in the queue looking
  like an outage. Make the first step a toolchain check: it asserts each tool and
  version and fails in seconds, naming what is missing. Agents are daemons that
  never read a shell profile, so load nvm or corepack explicitly, and hand
  `PATH` to later steps with
  `##teamcity[setParameter name='env.PATH' value='…']`.
- **Install from the lockfile:** `npm ci`, `pnpm install --frozen-lockfile`,
  `uv sync --frozen`.
- **Cleanup:** `cleanup { baseRule { artifacts(days = 7); history(days = 30) } }`.

### Triggers

```kotlin
val onlyWhatCanChangeTheVerdict = """
    +:**
    -:tasks/**
    -:docs/**
    -:.claude/**
    -:.codex/**
    -:.idea/**
    -:**/*.md
    -:*.md
""".trimIndent()

triggers {
    vcs {
        branchFilter = "+:<default>"
        triggerRules = onlyWhatCanChangeTheVerdict
    }
    schedule {
        schedulingPolicy = daily { hour = 5; timezone = "Europe/London" }
        branchFilter = "+:<default>"
        triggerBuild = always()
        withPendingChangesOnly = false
        enforceCleanCheckout = true
        enforceCleanCheckoutForDependencies = true
    }
}
```

- **Both Markdown rules are required.** `**/*.md` does not match a file at the
  repository root.
- **Every project has a nightly.** A green build proves the code passed against
  that day's dependencies, toolchain and date. Without
  `withPendingChangesOnly = false` the nightly never runs on an unchanged repo.
  Without the two `enforceCleanCheckout` lines, the composite reuses yesterday's
  legs and goes green having run nothing.
- **Stagger the hour.** Read the other projects' `hour =` lines and take one
  nobody uses. There are three agents.
- **A delivery configuration follows the composite.** A nightly then means a
  nightly delivery. Decide that deliberately (see the Apple doc).

### Test results

Every leg that runs tests publishes JUnit XML to the Tests tab, which gives
failures by name, per-test history, flaky detection and muting:

```kotlin
artifactRules = "test-reports/junit.xml => test-reports"
features {
    feature {
        type = "xml-report-plugin"
        param("xmlReportParsing.reportType", "junit")
        param("xmlReportParsing.reportDirs", "+:test-reports/junit.xml")
        param("xmlReportParsing.verboseOutput", "true")
    }
}
```

- **Vitest and pytest** nest their output correctly and need nothing extra.
- **`node --test`** emits bare `<testcase>` elements. Wrap them with
  `wordy-gamey`'s `scripts/junit-wrap.mjs`, run with `;` rather than `&&` so a
  failing run still writes its report.
- **xcodebuild**: convert the `.xcresult` with `xcrun xcresulttool`, as
  `super-funmax-music`'s `apple/scripts/run_tests.py` does. It adds no
  dependency.
- **Prove it on the first build.** The log's
  `report processed: N suites, M tests` line must match the runner's own totals,
  not merely show that a file was parsed.

### Apple builds

- **Each project owns its simulators.** Never share a device with another
  project, and pin the OS in the destination.
- **Isolate DerivedData and temp output** under the build's temp dir.
- **Serialise Xcode with a shared resource.** Use a `sharedResources` lock
  named after the project (`funmax-xcode`). Take a write lock for compiles and a
  read lock for UI legs on different simulators. A project's lock does not lock
  the Mac.
- **Delivery builds the revision that passed.** `TestFlight Delivery` takes a
  snapshot dependency on `All Checks` and never commits, pulls or rebases.
  Submitting for App Review stays manual.

### What green means

The header comment of `settings.kts` says what a green build proves, how that
was measured (date, test counts), and what is **deliberately not covered**:
Docker or database suites, live services, device performance. Nobody should be
able to read a green light as more than it is.

### Attaching it to the server

The repo side is done in the project. The server side needs the user. Hand them
these steps, filled in:

1. **Create the TeamCity project** with the id from `pom.xml`, under Root.
2. **Create a read-only GitHub deploy key** named `<repo>-ci`:
   `ssh-keygen -t ed25519 -N "" -C <repo>-ci -f /tmp/<repo>-ci` and
   `gh repo deploy-key add /tmp/<repo>-ci.pub -R npomfret/<github-repo>`.
3. **Upload the private key** to the project as SSH key `<repo>-ci`, then
   delete the local copy.
4. **Create the VCS root** `<ProjectId>_Main`:
   - URL `git@github.com:npomfret/<github-repo>.git`, branch `refs/heads/main`,
     branch spec `+:refs/heads/*`
   - auth method "uploaded key", using `<repo>-ci`
5. **Turn on Versioned Settings:**
   - format Kotlin, "use settings from VCS"
   - allow UI editing off
   - import from VCS (`importDecision: "importFromVCS"`)
6. **Check the first build's log.** Zero
   `Failed to retrieve uploaded ssh key` lines, and the
   `report processed` line agreeing with the runner. A compile error is listed
   in full by `GET /app/rest/projects/id:<id>/versionedSettings/status`.

After that, the project's `scripts/teamcity.py status` is how anyone checks a
build.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*
