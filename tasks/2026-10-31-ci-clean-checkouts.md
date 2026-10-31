# CI builds must start from a clean, empty checkout

Project: `ts-firebase-simulator`. Requested by Nick on 31 October 2026. Status: open.

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

| Build | Checkout before | Checkout configured, verification pending | Outputs |
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

Emptying before checkout is covered by the temporary chain `ProbeSeed`,
`ProbeSeedSurvives`, `ProbeCleanCheckout`, removed once its evidence is recorded.
A run counts only if the clean checkout starts within seconds of the green
survival check on the same agent, with no `Free disk space` line in its log.
Real legs: `BuildAndUnit` #137 (20842) and `Integration` #131 (20841) green at
`ac13e975`.

- [x] Inventory every CI build/leg and its checkout and output directories.
- [ ] Apply clean checkout isolation and explicit cache/artifact handling.
- [ ] Verify freshness and cleanup serially; record build IDs and evidence.
- [ ] Record each justified exception with its build/path, reason, retained
  state and freshness/isolation controls, or record why no exception is needed.

Keep paused builds paused. Creating this task does not change CI settings,
delete build data or claim the requirement is already satisfied.
