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

## Running commands

How you run commands, and what you ask the user to run. Writing a script that stays in the project is the `scripting` skill's subject; load it before writing one.

### Never hand the user a long command

- Run commands yourself. Ask the user to run something only when it needs them: a login, a password, `sudo`, a device in their hand, an install.
- Never ask the user to type or paste a long command: anything over one line, any chain of `&&`, `;` or `|`, a heredoc, or more than about 80 characters.
- Write it instead to a new executable script in the project's `tmp/` folder, named for what it does (`tmp/install-shellcheck.sh`). Give it `#!/usr/bin/env bash`, `set -euo pipefail` and a comment saying what it does and why. Have it log its detail to a file under `tmp/logs/` and print that path.
- Show the user the script, then ask them to run it with `! tmp/<name>.sh`, so its output lands in the conversation. Read its log afterwards rather than asking what happened.
- One short command, such as `! brew install shfmt`, is given as it is.

### Keep verbose output out of the console

- A command whose output may run past a screen, such as a build, a test suite, an install or a data run, writes to a log file under `tmp/logs/` and you read the parts you need with `tail`, `grep` or a line range. Never let thousands of lines into the conversation.
- Never add a verbose or debug flag just to watch. Read the log file.
- When reporting a run, quote the lines that matter and give the log path. Never paste the log.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*

## State and dependencies

Static application state is not allowed. Code never obtains its dependencies or configuration from singletons, globals, static accessors or the environment. At startup, one composition root validates the configuration, constructs every dependency, and passes each consumer exactly what it needs, normally through required constructor parameters. This rule has no exceptions, and passing tests do not excuse a breach.

### Forbidden

- An exported, preconstructed instance (`export const store = new Store()`), a lazy `getInstance()`, a global accessor (`getLogger()`, `getRuntimeSecrets()`), or a global `configure()`/`reset()` lifecycle. Wrapping global access in a helper does not make the dependency explicit.
- Mutable state in module variables (`let`, `var`), static properties, shared instances or global caches.
- Configuration or a service instance exposed through a static field, a global object or a module-level export, even when it is immutable.
- Obtaining a collaborator from a service locator, registry, application delegate or other global.
- Passing a general container or a bag of dependencies inward. Each consumer receives the specific things it uses.
- A constructor default that creates a production dependency (`constructor(api = apiClient)` or `= new HttpClient()`), property injection after construction, or hidden initialisation. A constructed object is ready to use.

### Required

- Classes take their collaborators as required constructor parameters and keep them on the instance. Functions take them as explicit parameters. Per-call data goes in method arguments.
- The composition root (`main`, the server bootstrap, the app's root component) builds dependencies before their consumers. Manual wiring is enough; a DI framework is not needed.
- External capabilities are injected as narrow, application-owned interfaces: network, database, filesystem, time, randomness, IDs, scheduling, notifications, analytics, configuration. Platform global state that cannot be avoided sits behind an injected adapter.
- One instance owned by the runtime may be passed to several consumers. That is shared ownership with a defined lifetime, not a singleton. Something that must be created later from request or session data comes from a narrow factory injected at startup.
- Immutable constants, stateless functions and cheap, deterministic, side-effect-free value construction are allowed. Configuration and service instances are not constants, however immutable.

### Environment variables and configuration

- Environment variables, `.env` files and equivalent configuration sources are allowed. The source is supplied explicitly to the program's entry point, which reads and validates it immediately at startup into typed, immutable configuration objects.
- Those objects are passed to the code that depends on them, normally through required constructor parameters. Each consumer gets the settings it needs, not the whole application config.
- Configuration is never accessed statically. Never load a `.env` file into global state for consumers to read later, and never read `process.env`, `os.environ`, a dotenv load or a discovered config file in behaviour code or at module import time.
- Tests construct configuration in memory. They never edit environment variables or depend on a developer's `.env`.

### Immutable by default

- Make fields immutable wherever possible: set them during construction and use `readonly`, `final`, `let` or the language's equivalent. Injected collaborators and configuration never change for the life of the instance.
- Prefer immutable values, and return a new value when data changes.
- A non-reassignable reference does not make what it points to immutable. Protect owned data from mutation through aliases, constructor inputs, returned collections and nested objects, with immutable representations, defensive copies or read-only views as the contract needs. A read-only view does not stop another holder of the underlying object from changing it.
- Mutable state needs a concrete behavioural reason. Keep it minimal and private, with one owner and a defined lifetime; derive values rather than store state that can drift.
- Change it only through intent-based operations that preserve its invariants, never public fields or general setters. Keep multi-field updates consistent through failure, cancellation and partial completion, and never expose an intermediate invalid state.
- Control concurrent and asynchronous access. Recheck invariants across suspension points, and never let stale work overwrite newer state.
- Never add mutability for convenient wiring, later initialisation, test setup, or a cache without a stated need and invalidation policy. For every mutable field, be able to say why it must change, who may change it and how validity is kept.
- None of this relaxes the ban on static application state.

### Tests

- A test constructs the unit directly with in-memory configuration and fakes, and calls it without booting the application.
- Two instances with different configuration and fakes must coexist in one process without interfering.
- Mutable state is tested through its meaningful transitions, failure paths and concurrency risks, observed through behaviour, with independent instances per test.
- Tests never patch modules, reset singletons, call static setters or change the environment to supply dependencies. If a test needs to, fix the production construction instead of adding test machinery.

### Existing code is not a precedent

- Where a project already has static state or reads the environment deep in its code, do not copy it, extend it or add to it, however much of it there is. New code takes its dependencies as parameters even when the code around it imports globals.
- Removing existing static state is a change of its own. Do it when asked; otherwise name it in one line at the end of the report.
- If a change cannot be made without new static state, for instance because there is no composition root to create the new object in, stop and say so. Never add the global as a stopgap.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*

## Test timeouts

The application must be fast, and the tests are where slowness shows. Every test timeout and every asynchronous wait is short, so a slow response fails a test instead of hiding inside a generous limit.

### Short by default

- Set the limits explicitly: for each test case, its setup and teardown, drivers and page objects, and every framework wait (`waitFor`, `waitForExistence`, `expect.poll`, `.timeLimit` and the like). Never inherit a framework's generous default, and never allow an unlimited wait.
- Unit tests are very fast. Each project sets a short budget per test type; as a guide, an in-memory unit test needs well under a second.
- A wait in an integration, UI or end-to-end test is tied to how long a user would expect that response to take. Being an end-to-end test does not justify a long one.
- Add outer limits too: per suite and per CI job, sized to the suite's real runtime, so a hang the test runner cannot interrupt still fails promptly.
- A timeout fails the check and stops the stalled work. Its failure says which test or phase timed out, the elapsed time, the limit, and what state it observed.

### Raising a limit needs the user

- Never introduce a longer default, add a longer override, or increase an existing timeout without the user's explicit approval first.
- When asking, name the specific operation, the evidence for how long it really takes, the limit you propose, and what that delay means for users.
- An approved exception covers only that operation. Record it beside the limit, and never relax a shared default to accommodate it.
- When something is unexpectedly slow, investigate the slowness. Raising the timeout is not a fix.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*
