# ts-firebase-simulator

A published npm package: TypeScript-first, in-memory Firebase stubs for unit
testing. It provides interfaces that mirror Firebase's API
(`IFirestoreDatabase`, `ICloudTasksClient`, `IStorage`), stub implementations of
them, and factories that adapt the real Firebase clients to the same
interfaces.

- Other projects depend on this one, so its exported surface is a contract. A
  change to an exported name, type or behaviour is a breaking change: say so
  rather than absorbing it quietly.
- The stubs exist to behave like the real services. Integration tests run the
  same suite against the stub, the Firebase emulator and real Firebase — see
  `CONTRIBUTING.md`. Where a stub and the real service disagree, the defect is
  in the stub, not in the test.
- Never publish. `release:patch`, `release:minor` and `release:major` each run
  `npm publish`, and those are the user's to run.
- `examples/` is documentation that compiles. A change to the API it
  demonstrates changes it too.

## Canonical Commands

- Build and typecheck: `npm run build`
- Unit tests: `npm run test:unit`
- Integration tests against the emulator: `npm run test:with-emulator`
- Format: `npm run format:check`
- Build status on the server: `npm run tc:status`

## Scope

Complete the requested work and verify it. Include the dependent changes needed to make it work, such as affected callers, tests or migrations.

- Use the request and existing project requirements as the boundary. Leave unrelated refactors, renames, cleanup, dependency bumps and documentation changes for separate work.
- Add special handling or tests for a failure scenario when there is evidence for it: observed data, an incident or a reproducible failure.
- Suggest adjacent work briefly at the end of the report; continue the current task. An unanswered suggestion is not approval.
- Ask when different interpretations would lead to materially different work. If a necessary change exceeds the authorized scope, explain the concrete dependency and wait for a decision.
- Finish when the requested behavior works and its verification passes. Report what changed, the evidence, and any remaining blocker.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*

## Running commands

Run commands yourself unless they require the user's login, password, sudo, device or installation action. Load the `scripting` skill before writing a script the project keeps.

- When the user must run a command, give them one short command. For anything multiline, chained or longer than about 80 characters, write an executable `tmp/<purpose>.sh` with `#!/usr/bin/env bash`, `set -euo pipefail`, a purpose comment and logging under `tmp/logs/`. Show it, ask them to run `! tmp/<purpose>.sh`, then read its log.
- Keep lengthy build, test, install and data output in `tmp/logs/`. Read relevant portions and report the useful lines with the log path. Do not enable verbose/debug output merely to watch a run.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*

## State and dependencies

Construct dependencies at the program's entry point and pass each consumer the specific collaborators and configuration it uses. Static application state is not allowed.

### Prefer

- Required constructor parameters for classes and explicit parameters for functions. Constructed objects are ready to use; per-call data belongs in method arguments.
- Narrow, application-owned interfaces for external capabilities such as network, storage, time, randomness and scheduling. Put unavoidable platform globals behind injected adapters.
- Runtime-owned instances with a defined lifetime, shared by passing references. Use an injected narrow factory when construction depends on later request/session data.
- Immutable values and fields, including owned collections and nested data. Use `const` in JavaScript/TypeScript, `let` in Swift, or the language's equivalent; an immutable reference alone does not protect its contents.
- Minimal private mutable state with a behavioral reason, one owner and a validity/invalidation policy. Keep transitions consistent across failure, cancellation and asynchronous work; prevent stale work from overwriting newer state.

### Avoid

- Singletons, module/static service instances or configuration, global accessors, service locators and global configure/reset lifecycles.
- Hidden construction through default dependencies or property injection, and passing a general dependency container inward.
- Reading configuration in behavior code or at module import time. The entry point reads and validates its supplied environment/files once into typed immutable configuration, then passes only the needed settings inward.
- Copying an existing global-state pattern into new code. Removing existing state is separate work unless requested or necessary for the task.

Immutable constants, stateless functions and deterministic value construction are allowed; service instances and runtime configuration are not constants. If a change would require new static application state, explain the missing construction boundary instead of adding a stopgap.

Tests construct units with in-memory configuration and fakes. Independent instances must coexist without interference. Exercise meaningful state transitions through behavior; do not supply dependencies by patching modules, changing the environment or resetting globals.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*

## Test timeouts

Use short, explicit limits so slow or stalled work fails promptly. Run local builds and tests one at a time across agents, with one test worker; wait for any test run you control to finish before starting another.

- Set budgets for tests, setup/teardown, driver waits, suites and CI jobs. Use an outer watchdog when the framework cannot express the required limit. In-memory unit tests should take well under a second; UI waits should match an acceptable user response time.
- A timeout stops the stalled work and reports the phase, elapsed time, limit and observed state.
- Calibrate against measured timings on the slowest environment, usually a busy CI agent, with a proportionate margin. Investigate unexpected slowness rather than masking it.
- Increasing any limit requires the user's approval. Give the measured timings, proposed limit and user impact; record the approved exception beside that operation. Keep shared defaults unchanged.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*

## Review before commit

Have significant work independently reviewed by an agent before committing. This includes behavior, refactors, tests, configuration and tooling; trivial wording, formatting and task-file edits need no review.

- Use an appropriate project reviewer, or a general reviewer. Give it the success criteria, file list/revision range and the actual diff.
- Ask for substantive problems with evidence: bugs, broken contracts, missed requirements, rule violations and ineffective tests. Skip style preferences and nits.
- Resolve each finding or explain why it is incorrect before committing. Report the review result and how findings were handled.

Passing tests do not replace review, and agent review does not replace any required user approval.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*

## Git

Keep history linear and protect other agents' work. The shared checkout stays on its default branch; parallel work uses worktrees.

- Update the shared checkout with `git pull --ff-only`. If branches have diverged, use `git pull --rebase`. Rebase worktrees onto the default branch and resolve conflicts commit by commit.
- Use `git merge --ff-only` to land work that is already rebased. Do not create merge commits or replace a failed rebase with a merge.
- Do not stash, discard or commit someone else's changes. If their work blocks an operation, use a worktree, wait or report the blocker.
- Commit and push scoped, verified work after independent review without asking again, unless the user requests otherwise for the task.
- Do not force-push the default branch. Use `--force-with-lease` only for your own branch after rebasing it.

### Worktrees

Use a worktree when the checkout contains others' changes or the work needs more than one commit. Otherwise work directly on the default branch and stage only your files.

Create worktrees under `.claude/worktrees/<name>`. Use `EnterWorktree`/agent isolation in Claude Code, or `git worktree add -b wt/<name> .claude/worktrees/<name> <default-branch>`. Do not switch branches in the shared checkout. A project instruction to work on main refers to that shared checkout.

Build, test and commit inside the worktree. A subagent commits there and returns the result; its parent lands the work.

### Landing

1. Commit the worktree's changes.
2. Confirm the shared checkout is on the default branch; otherwise stop and report it. Update it with `git pull --ff-only`.
3. Rebase the worktree onto the updated default branch, then land it from the shared checkout with `git merge --ff-only <worktree-branch>`. Rebase again if the default branch moved.
4. Leave and remove the worktree, then delete its branch. Remove only worktrees you created, once their work has landed or been deliberately dropped; report other apparently stale worktrees without removing them.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*
