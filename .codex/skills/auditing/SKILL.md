---
name: auditing
description: >-
  The required rules for everything this project records about itself:
  audit tables, audit events, loggers, telemetry and every call that writes a
  line anywhere. Load this before adding or changing any logging or audit
  call, before writing a script that reports progress, before designing a
  table that records what happened, when handling or reporting an error, and
  whenever asked why something that happened cannot be explained afterwards.
  Covers auditing actions and state changes rather than parameterised
  strings, the stable event label with structured fields, separating a
  durable audit trail from short-lived telemetry, what a record carries, the
  events and runs shapes, where the audit lives, why it can never be turned
  off, one logger and no stray console, recording an error once at its
  boundary, and what must never appear in a record.
---

## Auditing

**Never log. Only audit.** What is recorded is **actions and state changes** —
never a parameterised string. A project does not narrate itself in prose; it
records what it did and what changed, as data a machine can filter, group and
count.

This is one rule for every project, whatever it is written in and wherever it
runs: a browser, a server, a worker, a CLI, a phone, a game loop. The medium a
record lands in differs and is settled further down; the shape of the record does
not differ at all.

The archetype of the thing this standard removes is `sync-fixtures: starting`. It
is a sentence, it says only that something began, nothing can query it, and it is
gone the moment its buffer is. Three costs, in increasing order:

1. **It does not survive.** A server's output goes with the container a deploy
   replaces; a browser's goes with the tab; a device's rolls out of a ring buffer
   or was never persisted at that level to begin with. A diagnosis can destroy the
   very lines describing the failure.
2. **It cannot be asked a question.** "Does this offset ever find anything", "how
   often does the provider serve a team twice", "when did this last actually
   change" are questions about accumulated facts. Prose answers none of them
   without grepping a window of text that may no longer exist.
3. **It records the wrong thing.** `…: starting` is an event in the process, not a
   change in the world. What matters is what was read, what it said, what changed
   as a result, and what did not.

### Not a parameterised string

A message with a value interpolated into it is the defect this standard names
first. It holds for every record a project emits, audit or telemetry, in every
language and on every side of the wire — a browser, a server, a worker, a CLI, a
Swift or Python process. The syntax differs; the rule does not.

```
log.debug("found \(count) items")          no
log.debug("items found", count: count)     yes

logger.debug(`found ${count} items`)       no
logger.debug('items found', { count })     yes

log.debug(f"found {count} items")          no
log.debug("items found", count=count)      yes
```

A parameterised string cannot be filtered on — the message differs every time it
is written — cannot be grouped or counted, and cannot be queried without parsing
prose. It reads like data and is text. The moment a value is inside the message,
the record has stopped being a fact and become a sentence about one.

- The first argument is a **stable event slug** — `draft.attachment.reserved`,
  `page_job_started`, `items found` — chosen so it can be filtered on without
  matching prose that may get reworded later. It is a name, not a sentence
  template, and it never carries a runtime value.
- Runtime values go in the structured object, under **reused field names**, so one
  query spans the whole trace. A second name for the same thing is a second query.
- One record is one line of JSON. No multi-line dumps, no banners, no box drawing,
  no timestamps hand-written into the text.
- Where the language can enforce it, enforce it. A `StaticString` message
  parameter makes `notice("weekends → \(count)")` fail to compile, which is worth
  more than a rule anyone can forget.
- Give a domain type one conversion — `LogRepresentable`, a `toLogValue`, a
  serializer — rather than picking its fields apart at each call site. Values reach
  a record through a conversion somebody wrote deliberately.
- Names go out in the vocabulary of the data, not the user's language. A record
  must match the fixture that produced it and read the same on a device in another
  locale.

### Two records, two lifetimes

These are separate systems, and mixing them destroys both.

| | Mechanism | Lifetime | Answers |
| --- | --- | --- | --- |
| **Audit** | typed, append-only records in durable storage | long | what happened, what changed, who did it |
| **Telemetry** | structured JSON to stdout or stderr | short | why is this process unhealthy right now |

- An audit record is a **fact about the world or about an action this system
  took**. It is kept because someone will ask a question of it later.
- Telemetry is the running process talking about itself: startup, configuration,
  a crash, a retry, a connection pool. It may legitimately stay on a stream and
  disappear with the container.
- Do not route audit records into the telemetry stream and call the job done. If
  the only copy of "this changed" is in stdout, it is not audited.
- If a record's disappearance would lose the answer to a real question, it is an
  audit record. If it would lose nothing, it is probably not a record at all —
  delete it rather than promote it.

### What an audit record carries

Enough to answer the question without reproducing the work. Every record carries:

- **when** — an absolute instant in UTC, never a formatted string or a local
  wall-clock time. In Postgres that is `timestamptz`; elsewhere it is whatever
  that store or format calls the same thing;
- **what** — the stable action or event name;
- **who** — the actor: a user, a service, a job, a scheduled run. "The system" is
  not an actor; name the process;
- **on what** — the resource, by its real identity, not a label;
- **outcome** — succeeded, failed, refused, no-op. A record that omits the outcome
  cannot answer whether the thing worked;
- **correlation** — the request, job or run id that ties it to what a user or
  worker was doing. Propagate it through context (`AsyncLocalStorage`, a child
  logger, a run id threaded through), never by passing it hand to hand;
- **the values that make it meaningful** — what was read, what it said, what
  changed, and what did not. A record that says a sync ran, without saying what it
  found, has recorded the wrong thing.

Record the negative. "Checked and nothing had changed" is the answer to "does this
offset ever find anything", and it only exists if something wrote it down.

### Events and runs

Two shapes, and the distinction is worth keeping:

- **`*_events`** — a change in the world. A fixture rescheduled, a score changed, a
  price moved, a state transitioned. Immutable, append-only, with a uniqueness key
  so the same change observed twice is one row.
- **`*_runs`** — an action this system took. A sync, a sweep, a forecast, a
  backfill. One row per run, carrying what it read, how much, how long, and what it
  decided.

A third, smaller shape earns its place where a process has no HTTP surface:
**`*_heartbeats`**, one row per service replaced on each boot, so a restart shows
as a moving `boot_at` rather than as silence.

### Where the audit lives

- **Where the project has a database, the audit is a table.** It is the only
  medium that survives a deploy and answers a query. It is append-only: the
  application's database role has no `UPDATE` or `DELETE` on it, and a correction
  is a new row, never an edit.
- Index it for the questions it exists to answer, and decide retention when the
  table is created. "A season is a few thousand rows" does not transfer to a table
  written once per entity per sync. Say in the migration what prunes it, or say
  why nothing does.
- **Where the project has no database** — a CLI, a client, a script, a game — the
  audit is a durable stream instead: JSON records on stderr so stdout stays pure
  data, or a repo-local log file the run owns. The rules about shape, fields and
  redaction are unchanged; only the medium is.
- **Do not audit a subsystem with itself.** A table written by the executor it
  audits audits its own writes, and the recursion is not academic — it is why a
  query-timing record goes to the application's logger and not to a row. Where the
  two would close a loop, the record leaves through the layer above.
- One destination, passed inward as a capability. A module owns the measurement
  and not the place it goes, and a caller that wants no records says so explicitly
  and is visible as the one that said so.

### An audit that can be turned down is not one

- Audit records are emitted whatever the log level is set to, in every
  environment, always on. A level filters telemetry; it does not decide whether a
  fact about the world was recorded.
- Where a record has a lifetime — a platform log store, a level that persists and
  a level that does not — a state change gets the one that survives. A line that
  evaporates has scored an experiment wrongly more than once.
- For anything that mutates something outside this process, write `start` **before
  the request leaves**, then `ok` or `error`. If a run dies mid-write, or the
  connection fails so nobody can tell whether the change landed, that ambiguity is
  the thing most worth having a record of.
- Coverage is structural, not remembered. Route the records at the single place
  every write funnels through — the transport, the pool wrapper, the repository
  base — so a call written next year is audited because of what it is, not because
  somebody remembered.
- A field passed by a caller cannot overwrite the record's own statement about
  itself. `timestamp`, `level`, `event`, `audit` and `phase` are written beside a
  colliding field, never over it.

### One logger, and nothing beside it

- Exactly one module constructs the logger, and it is the only thing in the
  project that writes to an output stream. Whatever the language's direct write
  is called — `console`, `print`, `println`, `echo`, `System.out`, `NSLog`, a bare
  `Logger` — nothing else calls it: not in application code, not in scripts, and
  not left behind after debugging.
- Put it under mechanical control. A check that the direct write appears nowhere
  but the logger module belongs in the project's `check`; a rule nobody can run is
  advisory.
- Scripts log through the same shared logger. The console shows progress while the
  command runs; the file keeps the same audit trail for later. Verbose output goes
  to a repo-local log file, never to the caller's terminal or to `/tmp`.
- Test a record by asserting a fragment of its structured form, never its prose.

### Errors are recorded once

- Never try / catch / log / throw. Catching an exception to log it and rethrow it
  adds a line and no information, and the same failure then appears at every layer
  it passes through.
- Let errors bubble to the boundary responsible for reporting, handling or
  terminating, and record them there, once, with the error object preserved —
  name, message, stack, cause — not stringified into the message.
- A failure record is an audit record when it says something failed to happen in
  the world. An unhandled crash is telemetry.

### What never goes in a record

- Secrets, full API keys, passwords, tokens, cookies, credential-bearing or signed
  URLs, `.env` values, raw request and response bodies.
- Personal data and private identities beyond what the record needs. Use a hashed
  or truncated identifier where the identity is the point and the value is not.
- **Redact by name, and scrub by value.** A field list catches the fields somebody
  anticipated; scrubbing a known secret's value out of every string catches the
  one interpolated into a URL. Do both.
- A project's own privacy rule applies to records exactly as it applies to
  storage. If a grouping, address or wallet must not be exposed, it must not be in
  a record either.

### Related standards

Two standards already own a piece of this; follow them there rather than
restating them here.

- **Slow queries and database instrumentation** belong to the database standard:
  what a slow-query record carries, where the timing is taken, and counting
  queries per unit of work.
- **Browser code** belongs to the web-factoring standard: one logger module, no
  stray `console`, and one module that records user actions as named events.

### Finishing

- The summary says which action or state change is now recorded, where the record
  lives, and what question it can be asked.
- A new audit table lands with its indexes and its retention decision in the same
  migration as the table.
- A change that adds a record path does not also add a direct write beside it.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*
