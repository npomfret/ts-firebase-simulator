# ts-firebase-simulator

A published npm package: TypeScript-first, in-memory Firebase stubs for unit
testing (Firestore, Cloud Storage, Cloud Tasks and Auth). It provides interfaces
that mirror Firebase's API (`IFirestoreDatabase`, `ICloudTasksClient`,
`IStorage`, `IAuth`), stub implementations of them, and factories that adapt the
real Firebase clients to the same interfaces.

Tech: TypeScript, tsup, vitest, dprint; integration tests also use the Firebase
emulator and real Firebase.
Lifecycle: published on npm (0.16.0, tag `v0.16.0`). Consumers beyond the owner's
other projects are not evidenced.

- Other projects depend on this one, so its exported surface is a contract. A
  change to an exported name, type or behaviour is a breaking change: say so
  rather than absorbing it quietly.
- The stubs exist to behave like the real services. Integration tests run the
  same suite against the stub, the Firebase emulator and real Firebase — see
  `CONTRIBUTING.md`. Where a stub and the real service disagree, the defect is
  in the stub, not in the test.
- Never publish. `release:patch`, `release:minor` and `release:major` each run
  `npm publish`, and those are the user's to run. See `RELEASING.md`.
- `examples/` is documentation that compiles. A change to the API it
  demonstrates changes it too.

## Canonical Commands

- Build and typecheck: `npm run build`
- Unit tests: `npm run test:unit`
- Integration tests against the emulator: `npm run test:with-emulator`
- Integration tests (stub, plus real Firebase if a service account exists): `npm run test:integration`
- Format check: `npm run format:check`; format: `npm run format`
- Build status on the server: `npm run tc:status`

<!-- agent-standards:begin -->
## Shared agent guidance

Before starting work, read [Scope](.agents/agent-standards/guidance/scope.md), [Running commands](.agents/agent-standards/guidance/commands.md), [Git](.agents/agent-standards/guidance/git.md), [Review before commit](.agents/agent-standards/guidance/review.md).
Before code changes: [State and dependencies](.agents/agent-standards/guidance/dependencies.md); Before tests or timeout changes: [Test timeouts](.agents/agent-standards/guidance/test-timeouts.md).
Keep the shared checkout on its default branch. Use detached worktrees. Agents commit, fast-forward land and push their verified, reviewed work.
In Codex, use native skills and specialists for equivalent Claude invocations; referenced `.claude/` files remain canonical project knowledge.

*Managed by `npomfret/agent-standards`; edit the shared sources there.*
<!-- agent-standards:end -->
