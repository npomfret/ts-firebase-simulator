---
name: scripting
description: >-
  The required rules for every script this project keeps: shell, Python, Node
  or anything else run from a command line by a person, an agent or CI. Load
  this before writing, changing or reviewing a script, a .sh file, a package.json
  script entry, a Makefile target or a CI step that runs one. Covers choosing
  shell or a real language, where scripts live and how they are found, one
  interface (--help, usage, exit codes 0/1/2, long flags, no prompts, --dry-run
  and --yes), a console limited to progress and a summary while the detail goes
  to a log file, strict shell (set -euo pipefail, shellcheck, shfmt, bash 3.2),
  atomic writes, timeouts, secrets kept out of arguments, and tests.
---

## Scripting

This standard covers every script a project keeps: shell, Python, Node or anything else run from a command line, whether a person, an agent or CI runs it. A script is a small program with a user interface, and it gets the same care as the product: one shape for its interface, a log file for its detail, and a console that says only what a person watching needs to know.

### Choose the language first

- Shell is for glue: a script under about 50 lines that runs other programs in sequence. It parses no JSON, keeps no data structures beyond a list of arguments, and makes no decisions more involved than "did that step fail".
- Anything bigger is written in the project's own language, or Python's standard library where the project has none. That script can use the project's logger, carry types and be tested, which a shell script cannot.
- A shell script that has grown past glue is rewritten, not extended. A second `jq` pipeline, an associative array or a nested loop over parsed output is the sign.
- A project keeps one scripting language besides shell. A new script follows the one already there.

### Where scripts live and how they are found

- Scripts live in the project's `scripts/` folder, or in a `scripts/` folder beside the part of the project they serve.
- Every script a person or an agent is meant to run has one named entry in the project's command list, such as `package.json` scripts or a `Makefile`, and `AGENTS.md` names the ones agents use. Nobody discovers a script by listing a folder.
- A script runs from any working directory. It finds the project root from its own location, never from the current directory:

  ```bash
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  ```

- A script never needs to be approved by name before it runs. If an agent cannot run a committed script, the agent's configuration is wrong, not the script.

### One interface

- `--help` prints a usage message to stdout and exits 0. Usage is: one line saying what the script does, the synopsis, every option with its default, and one example.
- A missing or unknown argument prints the usage message to stderr and exits 2.
- Exit codes mean one thing everywhere: 0 succeeded, 1 failed, 2 was called wrongly. A script that checks something exits 1 when the check finds a problem.
- Options are long flags (`--dry-run`, `--since 2026-10-01`). Short aliases only for the few used by hand all day. Positional arguments only for the one thing the script acts on, such as a file.
- A script never prompts. Agents and CI cannot answer, and a prompt waits forever. Everything it needs comes from flags, the environment or a config file.
- A script that deletes, overwrites, spends money, sends anything outside the machine or takes longer than a few minutes has `--dry-run`, which does everything except that, and states what it would have done. Where the consequence is destructive, it refuses to run without `--yes`.
- Running a script twice does no harm. A second run finds the work already done and says so, or carries on from where the first stopped.

### Console and log file

The console is for a person watching. The record is the log file.

- Console output is limited to: the usage message, the path of the log file, short progress lines, warnings a person must act on, and a final summary.
- The first line a long-running script prints is the path of its log file, so the detail can be found while it runs and after it fails.
- Progress lines say where the work has reached, not what each item contained: `songs 1200/5400`, not one line per song. A line every few seconds at most.
- The final summary says what happened, how long it took, the counts that matter, and the log path again. A failure summary says what failed and where in the log to look.
- Everything else goes to the log file through the project's logger: each item processed, each request and response status, each decision, each retry, each stack trace. The auditing standard says what a log line looks like and what it may never contain; a script follows it exactly as application code does.
- The output of a program the script runs is detail. It goes to the log file, not the console, and a failure points at it.
- Errors go to stderr. A script never prints colour or cursor codes when its output is not a terminal.
- A flag such as `--verbose` never moves the log onto the console. Read the log file instead.

### When a step fails

A failed build must say why it failed, from what the build server keeps. A script that runs other programs, such as a build, a test stage or a deploy, makes every failure explain itself.

- Log each stage as it starts and ends, with its command, duration and exit status.
- When a stage fails, the summary names the stage and the command, and says how it ended:
  - it exited non-zero, with its exit status;
  - the script's own time limit expired, with the limit and the elapsed time;
  - something outside killed it, with the signal.
- Those three are different failures. Never report them as one, and never as a bare "failed".
- Keep the evidence with the failure: the program's error output, the end of its log, and the original error with its stack and cause. A summary never replaces them.
- Never quieten a failing check to get past it. A warning treated as an error is fixed, not suppressed.

### Shell scripts

- Every shell script starts with:

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  ```

- `shellcheck` and `shfmt` pass with no warnings. shfmt follows the project's `.editorconfig`, or `-i 2 -ci` where it has none. The scripting plugin's hook formats and checks every shell script an agent edits. A disabled check carries a `# shellcheck disable=SCxxxx` directive on the line, with the reason beside it.
- Quote every expansion: `"$var"`, `"$@"`, `"$(command)"`. Use arrays for argument lists, never a string split on spaces.
- No `eval`, and no building a command line out of strings.
- Scripts run on macOS and on Linux build agents. Write for bash 3.2, the version macOS ships: no associative arrays, no `mapfile`, no `${var,,}`. Where BSD and GNU tools differ, such as `sed -i`, `date` and `readlink -f`, use a form both accept or do the work in the project's scripting language.
- Temporary files and folders come from `mktemp` inside the project's `tmp/` folder, and a `trap … EXIT` removes them.
- Use functions, with `local` variables. A `main "$@"` at the end calls them.

### Files, time and the outside world

- Write files atomically: write a temporary file in the same folder, then move it into place. A script killed halfway leaves the old file or the new one, never half of one.
- Output that is generated goes under a path the project ignores. A script never writes into the source tree unless writing source is its job.
- Every network call has a timeout. Retries are a named policy, with a limit and a backoff, and every retry is logged.
- A script that writes shared state, such as a dataset or a build folder, holds a lock for the length of the write, because other agents run in the same checkout.

### Secrets

- Secrets come from the environment or the project's `.env` loader. Never from a command-line argument, which every process on the machine can read, and never from a value written in the script.
- A secret is passed to another program on stdin or in its environment, never as an argument.
- Secrets never reach the console or the log file. The auditing standard's redaction applies.

### Tests

- Logic in a script has tests, like logic anywhere else. A script whose decisions matter, such as a check, a parser or a migration, either has unit tests over the functions it is made of or a `--selftest` mode that runs known cases and exits non-zero when one fails.
- A check that a project relies on is tested against an example that should fail it, so a check that has stopped finding anything is noticed.

### Finishing

- The language suits the size of the job.
- The script has its entry in the command list, `--help`, the exit codes and no prompts.
- The console shows only the log path, progress and the summary. The detail is in the log file.
- A shell script passes `shellcheck` and `shfmt`.
- Anything destructive or costly has `--dry-run`, and needs `--yes` where it destroys.

*Generated from `npomfret/agent-standards`. Edit the standard there, not this copy.*
