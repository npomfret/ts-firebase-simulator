---
name: auditing
description: >-
  The required rules for every logger call, log file and line this project
  writes about what it is doing. Load this before adding or changing any
  logging call, before writing a script that reports progress, when handling
  or reporting an error, and whenever something that happened cannot be
  explained afterwards. 'Auditing' is this project's word for a strict form
  of logging: one logger writing to a log file, each line a fixed label
  followed by a JSON blob of data, never a templated or concatenated string,
  the normal debug/info/warn/error levels, stack traces never hidden, and
  events, actions and state changes recorded as data a person and a machine
  can both read.
---

## Auditing

**Auditing is logging done strictly.** There is still a logger, still a log file and
still the usual levels. The word "logging" invites sloppy habits: prose messages,
values spliced into strings, swallowed stack traces, lines that say "starting". The
word "auditing" is there to keep those habits out.

The result is a log file that a person can read top to bottom and a machine can
filter, group and count, without either one needing a special tool.

The idea is not tied to a language or a platform. Every stack has a logger that can
take a message and structured data; build this on top of it.

### Every line is a label and a JSON blob

```
logger.info('expense-created', { expenseId, amount, currency })       yes
logger.info(`created expense ${expenseId} for ${amount}`)             no
logger.info('created expense ' + expenseId)                           no

log.info("expense-created", expense_id=expense_id, amount=amount)     yes
log.info(f"created expense {expense_id}")                             no

log.info("expense-created", ["expenseId": id, "amount": amount])      yes
log.info("created expense \(id)")                                     no
```

- **The label is a fixed string.** It names what happened, as in `expense-created` or
  `sync-finished` or `payment-rejected`. It is the same every time that line runs,
  so you can search for it, filter on it and count it.
  Whether it is a slug (`expense-created`) or a short phrase (`API error occurred`)
  is the project's style; what matters is that it never changes.
- **Templated and concatenated strings are never used, anywhere, for any reason.** A
  runtime value goes in the JSON blob under a field name. It never goes in the label.
- **Reuse field names.** Call the same thing by the same name everywhere
  (`expenseId`, not `id` in one place and `expense` in another), so a single search
  finds every line about it.
- **The output is one line per call**, with the timestamp and level written by the
  logger and the label followed by its JSON. It is readable in the raw file with no
  pretty-printer.
- Where the language can enforce a fixed label, make it: a `StaticString` parameter,
  a string-literal type, or a lint rule that rejects a template literal or a `+` in
  the first argument.

### What gets audited

Record **events, actions and state changes**, with the data that makes each one
meaningful:

- **State changes:** a record was written, a status moved, a value changed. Include
  the before and after when they matter.
- **Actions the system took:** a sync, a job, an import, a message sent. Say what it
  did and what it found, including "checked, nothing changed".
- **Events from outside:** a webhook arrived, a user did something, a request was
  refused.
- **Problems:** anything that went wrong or nearly did.

Do not write lines that carry no fact. "About to do X", "loaded Y" and "starting"
tell you nothing. Record X once it has happened, and say what came of it.

### Levels are used as normal

`debug`, `info`, `warn` and `error` mean what they always mean:

- **debug** is detail that is useful while working on the code.
- **info** is a meaningful event or state change.
- **warn** is something unexpected that was handled.
- **error** is a failure.

Pick the level on its merits. Being "an audit" does not bump a line to `info` or
exempt it from the level setting.

### Errors keep their stack

- **Never hide a stack trace** unless the failure is 100% expected: for example, a
  validation rejection that the code exists to produce. Those are logged at `warn`
  with the reason as data.
- Log the error object itself, not its message pasted into a string. Keep its name,
  message, stack, cause and any extra properties, such as a code or a path.
- Record an error once, where it is handled. Do not catch an exception just to log
  it and throw it again, because the same failure then shows up at every layer it
  passes through. Let it bubble to the boundary that deals with it, and log it
  there.

### One strongly typed logger

Code never talks to the raw output. It goes through a strongly typed logger that the
project owns, and that logger is built so a developer cannot easily get it wrong.

- **One module creates the logger, and every line goes through it.** Nothing else
  calls `console.*`, `print`, `println`, `echo`, `System.out` or `NSLog`. That covers
  application code, scripts, and debugging lines left behind.
- **Its types do the enforcing.** The label parameter accepts only a fixed string,
  the data parameter accepts only a structured object, and error calls take the
  error object itself. Where the compiler can reject a mistake, it should, so the
  wrong call does not build.
- **Child loggers carry shared fields.** A child logger inherits its parent's fields
  and adds its own, so a request, job or entity sets its context once and every line
  beneath it includes that context. Do not repeat those fields at each call.
- **Allowed fields are the project's call.** Some projects standardise the field
  names, with a typed context listing the fields a line may carry. Others leave the
  names open. Either way, the logger's types enforce whatever the project chose.
- Scripts use the same logger and write to the same kind of log file. The terminal
  can show progress, but the file keeps the record.
- Where the project has a `check`, it fails if a direct output call appears outside
  the logger module.
- Tests assert on the label and the fields, not on the formatted text.

### What never goes in the data

- Secrets, API keys, passwords, tokens, cookies, signed or credential-bearing URLs,
  `.env` values.
- Whole raw request or response bodies.
- Personal data beyond what the line needs. Use an id, not an email address.

Redact by field name in the logger. Also scrub known secret values from string
fields, in case one arrives inside a URL.

### Finishing

- Every new or changed log call has a fixed label and its values in the JSON blob.
- No templated or concatenated string was added to a log call.
- Every caught error that is logged carries its stack, unless the failure was
  genuinely expected.
- No direct output call was added outside the logger module, and nothing bypasses
  the logger's types.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*
