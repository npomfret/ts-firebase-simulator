---
name: auditing
description: Project conventions for structured logs and error reporting. Read before changing log calls, diagnostic scripts or error handling, and when events cannot be explained from existing logs.
---

## Auditing

Use structured logs that explain events, actions and state changes to both people and machines.

### Log shape

- Each call has a fixed event label and structured fields: `logger.info('expense-created', { expenseId, amount, currency })`. Runtime values belong in fields, not interpolated or concatenated into the label.
- Emit one line per call, with timestamp, normal log level, label and JSON data. Use consistent field names and include before/after state when useful.
- Record outcomes, including meaningful no-change outcomes. Avoid empty narration such as "about to start".
- Use debug for diagnostic detail, info for meaningful events, warn for handled surprises, and error for failures.

### Logger and errors

- Construct the project-owned logger at the composition root and inject it. Its interface enforces fixed labels, structured fields and error objects where the language permits. Child loggers carry shared request/job context.
- Application events and script diagnostics use that logger and a log file. Direct console output is reserved for CLI usage, the log path, concise progress and the final summary described by the scripting standard.
- Log an error once where it is handled, preserving its type, stack, cause and other useful properties. Expected validation rejections may be warnings without a stack. Let unhandled errors reach the boundary that deals with them.
- Tests assert event labels and fields, not formatted output. Preserve checks that prevent application code bypassing the logger.

### Redaction

Keep secrets, credentials, cookies, signed URLs, environment values and whole raw request/response bodies out of logs. Include only necessary personal data, usually an ID rather than an email. Redact fields in the logger and scrub known secret values from strings, including URLs.

Verify that changed logs explain what happened and retain the evidence needed to diagnose failures.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*
