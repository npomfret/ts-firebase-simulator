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

Do what was asked, and nothing more. Work that was invented rather than requested is why a task never reaches an end.

### Never invent work

- Never invent a requirement. If the request does not state it and the project does not already require it, it is not a requirement.
- Never widen the scope of a change. The request sets the boundary; a related file, a neighbouring function or a second caller is outside it unless the change cannot work without them.
- Never start adjacent work you thought of yourself: a refactor you noticed, a test you would like to exist, a rename, a tidy-up, a dependency bump, a doc you would have written differently. "While I was in there" is not a reason.
- Never invent edge cases or failure scenarios. Before adding special handling, a fallback or a test for one, cite evidence that it exists: observed data, an actual incident, or a reproducible failure. "It could happen" is not evidence.
- Never treat a suggestion the user has not answered as approval. Silence is not yes, and neither is a suggestion you made yourself.

### Suggest instead

- Noticing work is not permission to do it. Say what you noticed in one line, and stop.
- Put suggestions at the end of the report, after what was actually done, and keep them separate from it so the two are never confused.
- One line each. A suggestion that needs a paragraph is a proposal, and a proposal is asked about before it is written, not after.
- Ask when the request is ambiguous. Do not resolve an ambiguity by building both sides, by building the larger one, or by building the one you find more interesting.

### Finish what was asked

This is not licence to stop early, and scope discipline is not an excuse for leaving something broken.

- A change is finished when what was asked works and has been verified — not when nothing more can be thought of, and not when the first part of it compiles.
- Work the change makes necessary is inside the scope, not outside it: a caller the new signature breaks, a test the change invalidates, a migration the schema now needs. Doing that is finishing the job, not expanding it.
- If the requested change cannot be made without work that was not requested, say so and wait. Do not do it silently, and do not abandon the request because of it.
- Report what was done and what was verified. Do not report intentions, or work you decided against.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*
