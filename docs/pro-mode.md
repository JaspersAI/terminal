# Pro mode (Shell Access for Full Control)

Pro mode (**Advantage #7: Shell Access for Full Control in Pro Mode**) lets the assistant run local multi-line shell, Python, R, and CLI scripts on your computer (`run_shell` in `src/main/agent/tools/shell.ts`, governed by `src/shared/app/pro-mode.ts`).

It is **off** by default (`PRO_MODE_OFF`) until you turn it on in **Settings > Pro mode**, and nothing in the app can turn it on for you: the assistant has no tool that reaches the setting (`change_setting` never touches Pro mode or [Eye](eye.md)), and while Pro mode is off the `run_shell` tool is omitted from the assistant's tool catalog altogether, so the model is never even told it could ask.

## Local Python, R, and CLI execution in `~/Jaspers/shell`

With Pro mode on, the assistant can ask to run a script inside Jaspers's dedicated workspace folder, `~/Jaspers/shell` (with read-only grants for `~/Desktop` and `~/Downloads`).

- **Whole-workflow scripts (`COMMAND_MAX = 10,000`):** A `run_shell` call is a complete script up to 10,000 characters, not a single line. Multi-line scripts, `cd`, `&&`, `set -e`, pipes, and inline Python/R heredocs (`python3 - <<'PY'`, `Rscript -e`, `duckdb`, `sqlite3`, `curl`, `jq`, `grep`, `awk`, `sed`, `diff`, `git`) all execute in one shell invocation (`${SHELL || '/bin/sh'} -c`). A twenty-step data pipeline, custom backtest, or `.xlsx`/PDF export is one script you read and approve once, rather than twenty separate prompts.
- **Full script inspection:** Every script is shown in full before it runs, in a scrollable monospaced box under the question, together with the working directory (`~/Jaspers/shell`) and the timeout ceiling (`timeoutSeconds`). Nothing is shortened or hidden.
- **Process-group lifecycle:** Each approved script runs in its own detached process group. If the script exceeds its timeout (`commandTimeout`, default `TIMEOUT_DEFAULT = 120` seconds, configurable from `TIMEOUT_MIN = 1` to `TIMEOUT_MAX = 600` seconds) or you press **Stop** in the composer, the app sends `SIGKILL` to the entire process group (`-child.pid`) so background child processes are terminated cleanly. Output returned to the model is capped at `outputMax` (`OUTPUT_DEFAULT = 100,000` characters, configurable from `OUTPUT_MIN = 1,000` to `OUTPUT_MAX = 1,000,000` characters via `capOutput`).

## Approval tiers (`always`, `once`, `session`, and `task`)

Every command requires explicit approval unless covered by a tier you selected (`readApproval` and `approvalChoices` in `src/shared/app/pro-mode.ts`) or `allowReadOnly` is enabled and the command passes `isReadOnlyCommand`. Closing the question, stopping the run, timing out, or typing free-form text in place of a button all evaluate to `denied`.

| Tier / Choice | Setting (`ApprovalMode`) | Scope and behavior |
| --- | --- | --- |
| **Allow once** (`ALLOW_ONCE`) / **Deny** (`DENY`) | `always` (*Every command*, default) | Runs (or refuses) the single `run_shell` call in front of you. |
| **Allow in this conversation** (`ALLOW_CONVERSATION`) | `once` (*Once per command in a conversation*) | Remembers the exact script string for the current conversation via `approvalKey(conversation, command)` (`${conversation}\u0000${command}`). No prefix matching, no wildcards, no normalization: one character different is a new command. Cleared on `/new`, thread reset (`forgetApprovals`), or app quit. |
| **Allow every command in this conversation** (`ALLOW_SESSION`) | `session` (*Once per conversation*) | Approves all subsequent `run_shell` commands in that conversation without prompting until `/new` or app quit. Designed for interactive sessions you are actively watching, not unattended runs. |
| **Allow for this task** (`ALLOW_TASK`) | Scheduled tasks (`TaskApprovalAt`: `'scheduling'` or `'run'`) | When the assistant schedules or updates a task with shell scripts (`commands`, up to `TASK_COMMANDS_MAX = 5`), `approveForTask` prompts you immediately (**Allow for this task** or **Deny**) while you are present. Denying any script aborts scheduling. Approved scripts are saved verbatim on the task (`task.commands`) and run unattended on schedule (`taskAllows`). If a task run ever requests a script not in `task.commands`, it prompts with **Allow once**, **Allow for this task**, or **Deny** (and an unanswered prompt after 10 minutes is a refusal). **Settings > Tasks** lists every script a task is allowed to run, and deleting the task revokes the allowance. |

## Deterministic read-only command filtering (`isReadOnlyCommand`)

When **Read-only commands** (`allowReadOnly`, off by default) is enabled in **Settings > Pro mode**, the assistant can run simple, single-command inspections without prompting if and only if `isReadOnlyCommand(command)` (`src/shared/app/pro-mode.ts`) returns `true`:

1. **No shell metacharacters or chaining (`SHELL_SYNTAX`):** The command must be a single line with zero occurrences of `|`, `&`, `;`, `<`, `>`, `` ` ``, `$`, `(`, `)`, `{`, `}`, `[`, `]`, `\n`, `\r`, `*`, `?`, `~`, or `\`. Pipes (`cat x | sh`), redirects (`> file`), command substitution (`$(...)`), globs, and multi-line scripts always require approval.
2. **Closed allowlist of programs (`READ_ONLY_PROGRAMS`):** The first word must be one of:
   `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `file`, `stat`, `du`, `df`, `pwd`, `echo`, `which`, `whoami`, `date`, `diff`, `sort`, `uniq`, `cut`, `basename`, `dirname`, `sw_vers`, `uname`, or `git`.
3. **Strict subcommand and flag checks:**
   - If the program is `git`, the immediately following argument (`rest[0]`) must be in `READ_ONLY_GIT`: `status`, `log`, `diff`, `show`, `blame`, `describe`, `ls-files`, or `rev-parse` (so `git -C repo diff` or `git push` are never treated as read-only).
   - If the program is `find`, none of its arguments may match `-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)`.
   - If the program is `tail` or `head`, `-f` is rejected so an unprompted read never hangs indefinitely.

Anything outside these rules falls back to the standard approval prompt.

## Kernel-enforced macOS sandbox (`sandboxProfile`) and folder grants

A command is confined by the operating system kernel via `/usr/bin/sandbox-exec`, not by inspecting the script text. On each run, `sandboxProfile(folder, onPath, readable)` (`src/shared/app/pro-mode.ts`) generates a Seatbelt profile:

```scheme
(version 1)
(allow default)
(deny file-write* (subpath "/"))
(allow file-write* (subpath "/Users/you/Jaspers/shell") (subpath "/private/var/folders") (subpath "/private/tmp") (subpath "/dev"))
(deny file-read* (subpath "/Users"))
(allow file-read* (subpath "/Users/you/Jaspers/shell") (subpath "/Users/you/Desktop") (subpath "/Users/you/Downloads") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/opt") (subpath "/etc") (subpath "/var") (subpath "/private") (subpath "/System") (subpath "/Library") (subpath "/Applications") ...)
```

- **Read and write inside `~/Jaspers/shell`:** Scripts can create subdirectories, write datasets, generate charts/workbooks, and use system temporary directories (`/private/var/folders`, `/private/tmp`, `/dev`).
- **Read-only folder grants (`readOnlyFolders`):** Scripts can read — and only read — `~/Desktop` and `~/Downloads`, so files you downloaded or placed on your Desktop can be inspected in place or copied into `~/Jaspers/shell`. Nothing in `~/Desktop` or `~/Downloads` can be modified or deleted. The first time a script reads either folder, macOS prompts for **System Settings > Privacy & Security > Files and Folders** permission.
- **System and `PATH` toolchains:** Scripts can read system directories (`/usr`, `/bin`, `/sbin`, `/opt`, `/etc`, `/var`, `/private`, `/System`, `/Library`, `/Applications`) and any `/Users/...` directories present on your `PATH` (so Homebrew, pyenv, uv, Conda, R, or nvm toolchains load their libraries).
- **Everything else under `/Users` is unreadable:** `~/.ssh`, `~/.aws`, `~/Documents`, browser profiles, and other repositories on disk are blocked by `(deny file-read* (subpath "/Users"))`.
- **Fail-closed outside macOS:** Where `/usr/bin/sandbox-exec` is unavailable (non-macOS platforms), `run_shell` refuses to execute any command rather than running unconfined.

## Sanitized environment (`commandEnv`)

Inside `~/Jaspers/shell`, a script can use your installed tools and reach the network, so always read a script before approving it, especially when the assistant is working with untrusted web pages or filings.

To prevent ambient credential leakage:
- Your login shell profile is not sourced (`-c`, not `-lc`; your login `PATH` is already resolved once at startup by `src/main/app/shell-path.ts`).
- `commandEnv` (`src/shared/app/pro-mode.ts`) strips the Electron process environment down to `ENV_KEPT` (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TMPDIR`, `TZ`) plus `TERM=dumb`. Any provider API keys or tokens in the app's launch environment never enter the shell process, and OS keychain secrets (`safeStorage`) remain in the main process.

## Settings

| Setting | What it does |
| --- | --- |
| Pro mode (`enabled`) | On or off. Off by default (`PRO_MODE_OFF`), and off in a fresh install. |
| Ask me (`approval`) | `always` (Every command, default), `once` (Once per command in a conversation), or `session` (Once per conversation). |
| Read-only commands (`allowReadOnly`) | Whether single-program read-only commands passing `isReadOnlyCommand` (`ls`, `cat`, `head`, `grep`, `wc`, `find`, `git status`, `git log`, … with no pipes, redirects, globs, `~`, `$(…)`, or second command) run without prompting. Off by default. |
| Folder | Not a setting: every command runs in `~/Jaspers/shell`. **Show folder** opens it in Finder so you can inspect, move, or delete files a script wrote. |
| Stop a command after (`timeoutSeconds`) | Seconds before the command and its process group are killed (`TIMEOUT_DEFAULT = 120`, min `1`, max `600`). Ceiling for any per-call `timeoutSeconds`. |
| Keep of the output (`outputMax`) | Maximum characters of stdout/stderr returned to the assistant (`OUTPUT_DEFAULT = 100,000`, min `1,000`, max `1,000,000`); excess output is truncated by `capOutput` with a notice. |

## Getting files in and out

`~/Jaspers/shell` is an ordinary folder on disk. A command can read files directly from `~/Desktop` or `~/Downloads`; for any other file, copy it into `~/Jaspers/shell`. Command writes are generally confined to `~/Jaspers/shell`, with exceptions for `/private/var/folders`, `/private/tmp`, and `/dev`. You can open `~/Jaspers/shell` at any time from **Settings > Pro mode > Show folder**.

## Audit log (`shell.jsonl`) and Eye telemetry exclusions

- **Local audit log (`~/Jaspers/data/shell.jsonl`):** Every command requested via `run_shell` or task scheduling is appended as one JSON line to `~/Jaspers/data/shell.jsonl`: timestamp (`at`), `command`, `folder`, your `answer` (`once`, `conversation`, `session`, `task`, `read-only`, `denied`, `task, when scheduled`, or `denied, when scheduled`), `timeout`, exit `code`, and duration (`ms`). Command stdout/stderr is never written to `shell.jsonl`.
- **Eye telemetry exclusions ([Eye](eye.md)):** While a Pro mode command approval question (or any key input field) is on screen, `captureBlocked` (`src/shared/app/eye.ts`) suppresses [Eye](eye.md) window screenshots on both periodic 1-minute ticks and one-shot user feedback submissions. The script waiting for your approval is never photographed into a telemetry frame, and `~/Jaspers/data/shell.jsonl` stays strictly on your machine.
