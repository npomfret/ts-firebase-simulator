# CI builds must start from a clean, empty checkout

Project: `ts-firebase-simulator`. Requested by Nick on 31 October 2026. Status: open, real legs pending.

Ensure every CI build starts from an empty source directory before checking out
the exact requested revision, unless a specific, justified exception is recorded.
Follow the [shared acceptance criteria](../../snowmonkey-proxy-common/tasks/2026-10-31-ci-clean-checkouts.md#shared-acceptance-criteria).

Local CI entry points found: `.teamcity`. Include server-managed builds and inherited templates in the inventory too.

## Why it matters here

`Integration` #125 and #129 failed at `npm ci` with exit code 190. #129's log
shows `ENOTEMPTY` on `node_modules/firebase-tools` in the reused directory
`work/5a6779e0d80833b`, which both legs shared by VCS-settings hash.

## Inventory

TeamCity project `TsFirebaseSimulator`, wholly owned by versioned settings
(`.teamcity/settings.kts`, `ALWAYS_USE_CURRENT`). `settings` shows no templates,
no paused builds and no build outside the two below. There is no
`.github/workflows`, and no release or deployment job: `npm publish` is run by
hand.

| Build | Checkout before | Checkout now | Outputs |
|---|---|---|---|
| `BuildAndUnit` | Agent-side, reused hash directory shared with `Integration`; cleaned only on a branch change | `ts-firebase-simulator-build-and-unit`, emptied before checkout, removed after the build | `dist/`, `node_modules/`, `test-reports/unit.xml` (published, parsed during the build) |
| `Integration` | As `BuildAndUnit` | `ts-firebase-simulator-integration`, emptied before checkout, removed after the build | `node_modules/`, `test-reports/integration.xml` (published, parsed during the build) |

Retained state, all outside the checkout: the agent's Git mirror and npm's
content-addressed download cache. `Integration` reads the service account key
from its fixed path on the agent host and never writes it. No artifact
dependencies exist.

## Verification evidence

Removal after the build, from `ProbeBuildCleanup` on `macstudio-2` at
`ac13e975`, with `cleanCheckout` off and `expireHours=0`. Each run confirmed the
exact revision and seeded the workspace; the next build on the agent then listed
the workspaces without it, with no disk cleaner in that build's log.

| Build | Ending | Finished | Directory gone by | Sentinel artifact |
|---|---|---|---|---|
| #1, 21247 | Success | 16:26:38 | 16:26:42 | Published |
| #2, 21348 | Controlled failure, exit 1 | 16:44:18 | 16:44:22 | Published |
| #3, 21440 | Execution timeout | 16:59:22 | 16:59:26 | Published |

Disk pressure: the shared disk is under TeamCity's 3 GB requirement, and the
agent's free-disk cleaner ran with 2.5 GB free in 21246 and 21440. It deletes
workspaces, so `ProbeControl` #2 (21347) and `ProbeCleanCheckout` #2 and #3
(21260, 21359) are not evidence: their directories were gone before they ran.

Emptying before checkout, from a chain in one directory on `macstudio-2` at
`89844ebf`, removed once recorded. A run counted only if the clean checkout
started within seconds of the green survival check, with no `Free disk space`
line in its log.

| Build | Cleaning | Started | All six seeds |
|---|---|---|---|
| `ProbeSeed` #4, 21657 | None | 17:48:41 | Planted |
| `ProbeSeedSurvives` #1, 21658 | None | 17:48:52 | Found, `.git/probe-sentinel` included |
| `ProbeCleanCheckout` #4, 21659 | `cleanCheckout` | 17:49:04 | None found |

21659 logged `Full checkout enforced. Reason: ["Delete all files before the
build" turned on]`. Every probe confirmed the exact revision.

Real legs: `BuildAndUnit` #137 and `Integration` #131 ran in the old shared
directory, queued before the settings applied, so they are not evidence.
Pending: the first green build of each leg in its named directory.

- [x] Inventory every CI build/leg and its checkout and output directories.
- [x] Apply clean checkout isolation and explicit cache/artifact handling.
- [ ] Verify freshness and cleanup serially; record build IDs and evidence.
- [x] Record each justified exception with its build/path, reason, retained
  state and freshness/isolation controls, or record why no exception is needed.

No exception is needed: neither leg reuses a directory, and the Git mirror and
npm cache cannot supply a generated file or a test result. No build here is
paused.

Residual risk: the old shared `work/5a6779e0d80833b` directories stay on the
agents until TeamCity expires them; no build uses them. The agents' shared disk
is below 3 GB free, which belongs to the CI storage cleanup task.
