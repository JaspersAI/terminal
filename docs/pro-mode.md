# Pro mode

Pro mode lets the assistant run shell commands on your computer. It is **off** until you turn it on in **Settings > Pro mode**, and nothing in the app can turn it on for you: the assistant has no tool that reaches the setting, and while it is off the shell tool is not in the assistant's list at all, so it is never even told it could ask.

## What it allows

With it on, the assistant can ask to run a shell script inside Jaspers's own folder (`~/Jaspers/shell`), which can also read your Desktop and Downloads. Every script is put in front of you first, exactly as it would run, in the monospaced box under the question, with the folder it would run in and how long it may take; you answer **Allow once**, one of the wider allowances when you have set *Ask me* to offer it, or **Deny**. Nothing runs until you allow it. Closing the question, stopping the run, and leaving it unanswered all mean no.

A call is a whole script, not a single line: several lines, `cd`, `&&`, `set -e`, and heredocs all work, because it goes to your shell as one string. That is deliberate — a twenty-step piece of work is one script you read once, rather than twenty questions to wave through — and it is why the box the script is shown in scrolls: what you are approving is the text in front of you, and none of it is shortened.

Two allowances go beyond the one command in front of you, and both are forgotten when the conversation is (`/new`, or quitting Jaspers):

- **Allow in this conversation** (*Ask me: once per command*) covers that exact text and nothing else — no prefixes, no wildcards.
- **Allow every command in this conversation** (*Ask me: once per conversation*) stops the asking altogether until the conversation ends: every command the assistant runs after it, whatever it is, inside the folder. It is for a long piece of work you are watching happen, not a setting to leave on.

## What it does not do

A command is confined by macOS, not by reading what it says. It runs under `sandbox-exec` with a profile that allows:

- reading and writing inside `~/Jaspers/shell`, and the system's temporary folder;
- reading, and only reading, `~/Desktop` and `~/Downloads`, so a file you saved or downloaded can be worked on where it is, or copied into the folder; nothing in them can be changed or deleted;
- reading the system itself, and the folders on your `PATH`, so a program you installed and its libraries can be found;
- nothing else under `/Users`: your documents, your keys, and your other projects are not readable.

The first time a command reads your Desktop or Downloads, macOS asks whether Jaspers Terminal may; until you allow it in that question, or later in System Settings > Privacy & Security > Files and Folders, those folders read as empty or refuse.

Where that confinement is not available — anything but macOS — no command runs at all, rather than running unconfined.

Inside that folder a script has the system's own tools: `curl` to download, `grep`, `awk`, `sed`, `diff`, `python3`, and whatever else you have installed and is on your `PATH`. It may make its own subfolders, and the network is open to it.

Inside the folder a command can do anything you could, including reaching the network, so what it may send out is what you have put in that folder. Your shell profile is not sourced (`-c`, not `-lc`), and the command is given only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TMPDIR` and `TZ` from the app's environment, so a key the app was launched with does not travel into it. A language model can also be talked into asking for the wrong thing by text it read along the way — a web page, a filing, a plugin's output — so read each command before you allow it.

A scheduled task runs with nobody there, so its commands are asked about when they are needed. When the assistant schedules work that needs a command, it names the exact script and you are asked then, while you are there: **Allow for this task** or **Deny**, and a denied script means no task. A script you allowed is kept with the task and runs at each of its runs without asking, to the letter: one character different is a different script. A run that reaches for a script you have not allowed asks at that moment, with **Allow once** on offer as well, and an unanswered question is a no, as everywhere. **Settings > Tasks** shows what each task may run, and removing the task ends the allowance. Unlike the conversation's allowances, this one outlives a restart, because the task does.

## Settings

| Setting | What it does |
| --- | --- |
| Pro mode | On or off. Off by default, and off in a fresh install. |
| Ask me | Every command, once per command in a conversation, or once per conversation. Every command by default. Once per conversation is the widest thing here: taking that allowance means nothing more is asked until the conversation ends. |
| Read-only commands | Whether a plain read runs without asking: one program from a fixed list (`ls`, `cat`, `head`, `grep`, `wc`, `find`, `git status`, `git log`, …), arguments only, and no pipe, redirection, glob, `~`, `$(…)`, or second command anywhere. Off by default, so everything asks. |
| Folder | Not a setting: every command runs in `~/Jaspers/shell`. **Show folder** in the pane opens it, and what a command leaves there is yours to open, move, or delete. |
| Stop a command after | Seconds before the command and anything it started are killed, and the ceiling for any one call: the assistant may ask for longer than usual for a download or a long pass over a file, never for longer than this. 120 by default, 600 at most. |
| Keep of the output | How much of what a command printed the assistant is given; the rest is cut, and the assistant is told it was cut. 100,000 characters by default. |

Your Stop in the composer kills a running command, along with whatever it started.

## Getting files in and out

The folder is an ordinary folder. A command can read a file on your Desktop or in Downloads where it is; anything else, put in the folder to let a command work on it. What a command writes goes only into the folder: open it from **Settings > Pro mode > Show folder**. That is the only way out.

## The record

Every command asked for is appended to `~/Jaspers/data/shell.jsonl`, one line of JSON each: when it was asked, the command, the folder, what you answered, how long it was allowed to run, the exit code, and how long it took. The command's output is never written there.
