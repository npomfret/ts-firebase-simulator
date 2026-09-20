---
name: auditing
description: >-
  The required rules for everything this project records about itself:
  audit records, loggers, log files, telemetry and every call that writes a
  line anywhere. Load this before adding or changing any logging or audit
  call, before writing a script that reports progress, before choosing where
  a record of what happened is kept, when handling or reporting an error, and
  whenever asked why something that happened cannot be explained afterwards.
  Covers auditing actions and state changes rather than parameterised
  strings, the stable event label with structured fields, records that a
  machine and a person can both read, separating a durable audit trail from
  short-lived telemetry, what a record carries, what the medium has to do and
  why a database is not the default one, why an audit can never be turned
  off, one logger and no stray console, recording an error once at its
  boundary, and what must never appear in a record.
---

## Auditing

**Never log. Only audit.** What is recorded is **actions and state changes** —
never a parameterised string. A project does not narrate itself in prose; it
records what it did and what changed, as data a machine can filter, group and
count, and a person can read without reaching for a tool.

This is one rule for every project, whatever it is written in and wherever it
runs: a browser, a server, a worker, a CLI, a phone, a game loop. The medium a
record lands in is the project's own decision, taken from its stack and its
constraints; what a record has to be does not differ at all. This standard is
the second thing. It does not say where to put the bytes.

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
- Where the language can enforce it, enforce it. A message parameter the compiler
  refuses to let a value into — Swift's `StaticString` is one — makes
  `notice("weekends → \(count)")` fail to build, which is worth more than a rule
  anyone can forget.
- Give a domain type one conversion — a `toLogValue`, a serializer, whatever the
  language calls it — rather than picking its fields apart at each call site.
  Values reach a record through a conversion somebody wrote deliberately.
- Names go out in the vocabulary of the data, not the user's language. A record
  must match the fixture that produced it and read the same on a device in another
  locale.

### Readable by a machine and by a person

Both, in the same record. They are not in tension and a format that sacrifices
one is the wrong format.

- **A machine has to be able to filter, group and count it** without parsing
  prose. That is what the stable slug and the named fields are for.
- **A person has to be able to read it** in the raw, in the place it lands, with
  no viewer, no query and no pretty-printer in the pipe. Someone will read these
  at three in the morning with whatever is to hand.
- One record is one line, and the line says when, what, and to what, in that
  order, before it says anything else. Whoever is scanning is looking for those
  three things.
- No multi-line dumps, no banners, no box drawing, no timestamps hand-written
  into the text, and nothing so wide that the fact scrolls off the edge. Bound a
  value that can be unbounded — a long string, a large array — to a length and a
  sample.
- The project picks the syntax that satisfies both. Its stack, its tooling and
  whatever already reads its output decide that, not this standard.

### Two records, two lifetimes

These are separate systems, and mixing them destroys both.

| | Kept | Lifetime | Answers |
| --- | --- | --- | --- |
| **Audit** | because a question will be asked of it | long, append-only | what happened, what changed, who did it |
| **Telemetry** | because something is unhealthy now | short, discardable | why is this process misbehaving |

- An audit record is a **fact about the world or about an action this system
  took**. It is kept because someone will ask a question of it later.
- Telemetry is the running process talking about itself: startup, configuration,
  a crash, a retry, a connection pool. It may legitimately live somewhere that
  vanishes with the process.
- Do not route audit records into the telemetry stream and call the job done. If
  the only copy of "this changed" is in output that a restart or a deploy throws
  away, it is not audited.
- If a record's disappearance would lose the answer to a real question, it is an
  audit record. If it would lose nothing, it is probably not a record at all —
  delete it rather than promote it.

### What an audit record carries

Enough to answer the question without reproducing the work. Every record carries:

- **when** — an absolute instant in UTC, held as an instant rather than as a
  formatted local wall-clock time;
- **what** — the stable action or event name;
- **who** — the actor: a user, a service, a job, a scheduled run. "The system" is
  not an actor; name the process;
- **on what** — the resource, by its real identity, not a label;
- **outcome** — succeeded, failed, refused, no-op. A record that omits the outcome
  cannot answer whether the thing worked;
- **correlation** — the request, job or run id that ties it to what a user or
  worker was doing. Propagate it through the project's own context mechanism,
  never by passing it hand to hand;
- **the values that make it meaningful** — what was read, what it said, what
  changed, and what did not. A record that says a sync ran, without saying what it
  found, has recorded the wrong thing.

Record the negative. "Checked and nothing had changed" is the answer to "does this
offset ever find anything", and it only exists if something wrote it down.

### Two things worth telling apart

- **A change in the world.** A fixture rescheduled, a score changed, a price
  moved, a state transitioned. It happened whether or not this system was
  watching, so the same change observed twice is one fact, not two: give it a
  key that says so.
- **An action this system took.** A sync, a sweep, a forecast, a backfill. One
  record per run, carrying what it read, how much, how long, and what it decided.

A third earns its place where a process has no surface anyone can poll: something
that says "still alive, last did real work at", so a restart shows as movement
rather than as silence.

### Where the audit lives

The medium is the project's decision and the project's stack settles it: a log
file the run owns, a table, a platform log store, an append-only object, a
stream something else drains. What is **not** the project's decision is what that
medium has to do.

- **It outlives the process that wrote it.** Longer than a container, a tab, a
  deploy or a crash. This is the whole reason the record exists.
- **It can be asked a question.** Filtered, grouped and counted over a useful
  window, by whatever the project already has.
- **It can be read by a person**, in the raw, where it lands.
- **It is not the thing it audits.** Do not audit a subsystem with itself: a
  store written by the executor it audits audits its own writes, and the
  recursion is not academic — it is why a query-timing record goes to the
  application's logger and not to a row. Where the two would close a loop, the
  record leaves through the layer above.
- **There is one destination**, passed inward as a capability. A module owns the
  measurement and not the place it goes, and a caller that wants no records says
  so explicitly and is visible as the one that said so.

A database is not the default answer, and the presence of one is not a reason.
Storage is right when the records are part of the product — something the
application itself reads, joins, serves or reconciles against — and that is a
product decision, made deliberately, not a consequence of this standard.
Operational history, which is most of what a project records, belongs wherever
the project already keeps durable output; a log file that survives a restart is
a complete answer to it.

Whatever the medium: it is append-only, a correction is a new record rather than
an edit, and retention is decided when the record is introduced rather than when
the volume becomes a problem. Say what prunes it, or say why nothing needs to.
"A season is a few thousand" does not transfer to something written once per
entity per sync.

### An audit that can be turned down is not one

- Audit records are emitted whatever the log level is set to, in every
  environment, always on. A level filters telemetry; it does not decide whether a
  fact about the world was recorded.
- Where a record has a lifetime — a level that persists and a level that does
  not, a store that is swept and one that is not — a state change gets the one
  that survives. A record that evaporates has scored an experiment wrongly more
  than once.
- For anything that mutates something outside this process, write `start` **before
  the request leaves**, then `ok` or `error`. If a run dies mid-write, or the
  connection fails so nobody can tell whether the change landed, that ambiguity is
  the thing most worth having a record of.
- Coverage is structural, not remembered. Route the records at the single place
  every write funnels through — the transport, the pool wrapper, the repository
  base — so a call written next year is audited because of what it is, not because
  somebody remembered.
- A field passed by a caller cannot overwrite the record's own statement about
  itself. The name, the time, the level and the outcome are written beside a
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
  command runs; the durable copy keeps the same trail for later. Verbose output
  goes to a repo-local log file, never to the caller's terminal or to `/tmp`.
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
- A new kind of record arrives with its retention decision already made, in the
  same change that introduces it.
- A change that adds a record path does not also add a direct write beside it.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*
