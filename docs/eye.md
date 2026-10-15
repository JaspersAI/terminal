# Eye

Eye records how you use Jaspers, so the team can learn from it: a picture of the app's own windows every minute, what you do in the app, each request you make to the assistant with every step it took, and how the app performs. It is **off** until you turn it on, it asks you once before it ever records anything, and nothing in the app can turn it on for you — the assistant has no tool that reaches the setting, so it can neither start recording, stop it, nor read a frame. The switch is the one setting: where the recording goes, how often a picture is taken, and what is in one are the app's, not yours to configure.

## The first time

The first launch after Eye existed asks, once, in plain words: what a picture is of, how often one is taken, what is kept of a request, that it goes to Jaspers, and what is never in any of it. **Start recording** turns it on; **Not now** leaves it off. Either answer is remembered, so the question is asked once and never again, unless what Eye records changes: then it is asked again, in the new words, and nothing is recorded until you answer. You can change your mind at any time from the dot or from **Settings > Eye**.

## The dot

The eye at the right end of the workspace bar is the indicator, and pressing it opens a small panel under it with the switch and a feedback box. **Start recording** and **Stop recording** turn Eye on and off. While it is recording the dot is filled and breathes slowly; off, it is a hollow ring and still. With reduced motion turned on in your system settings it does not animate at all — the color and the label still say which it is.

## Feedback

Write what worked, what did not, or what you expected into the box and press **Send** (or ⌘/Ctrl+Enter). The panel closes, a picture of every open Jaspers window is taken that moment — the screen you were writing about, without the panel over it — and your note goes to the team with it. "Feedback sent" shows beside the dot once it is written; if it could not be, the panel opens again with your note still in it.

Feedback goes whether recording is on or off: pressing Send is your own act each time. The same rules hold for it as for a frame: keys the app holds are masked out of the note, a note is cut at 4,000 characters, and while a key field or a question is on screen no picture is taken and the note goes alone, saying why. On the server a window with feedback in it is always flagged for the team to read.

## What it captures

- The Jaspers window as it looks on screen, every minute, scaled to 1280 pixels wide and saved as a JPEG. This app only: not your desktop, not your browser, not another program. Every open Jaspers window gets a frame, and recording carries on while the windows are closed to the menu bar. A window that has not changed since the last picture is not pictured again.
- What you do in the app: each thing you ask of it (placing, moving, or closing a view, switching workspace, answering a question, changing a setting), the buttons and menu items you click by their labels, and how many characters you type into which field.
- What the app looks like as you use it: when recording starts, the whole state of the workspaces (the views on each grid and how each is set, the loops, the questions and notices on screen, the plugins and connections installed), and from then on every change to it, with what caused it. That is what lets a session be read back as it happened.
- Each request to the assistant, step by step as it happens: every call to the model with how long it took and how many tokens it used or the error it met, every tool it ran with what the tool was given and what it gave back, what the model said between steps, and how the request ended, with what you asked, its answer, its error, or that you stopped it. What you asked, and anything you added while it worked, is written as the request ends, so a key you pasted into it and the assistant saved is masked out. Long texts are cut short.
- What went wrong: notices the app raised for you with what they said, errors in a window or a view, a window that stopped answering, a plugin's process that stopped.
- How the app performs, once a minute: the memory and processor time its processes use, and how long the app took to respond.
- Your windows: when one is focused, shown, hidden, moved, or closed.
- Feedback you send from the eye, with a picture of the windows taken when you pressed Send.

## What it never captures

- Anything outside Jaspers.
- The characters you type, other than what you send the assistant and how you set a view: only how many, and into which field. A password field is not even counted.
- What is written in cells and notes: that a cell or a note holds something, never what. A note's words are masked wherever they would appear, as a key is, and the assistant's tools that read and write cells are kept without what they read or wrote. What the assistant says about them in its own words is part of its answer.
- Keys, passwords, and tokens the app holds, and the email you sign in with: every one is masked out of everything Eye writes. A key pasted into a key field is never in a frame. Your home folder's name is written as `~`.
- What a view draws inside its own frame, beyond how it is set.
- Anything at all while a key field or a question is on screen. A frame would show the API key you are pasting, or the exact command a Pro mode approval is waiting on, so that tick is skipped entirely and nothing of that screen is kept. The next frame comes at the next interval.

## Where it goes

Into `~/Jaspers/data/eye`, one folder per app run, holding that run's frames, a file per note of feedback, and its `events.jsonl`, one line of JSON for each thing that happened. **Settings > Eye > Reveal the folder** opens it: every frame is an ordinary JPEG and every line an ordinary line of JSON, so you can look through exactly what was recorded, and **Delete all** removes all of it.

Everything is posted to Jaspers, at `eye.jsprai.com`, as soon as it is whole: a frame moments after it is taken, and the telemetry file in parts as lines are written to it. A frame is deleted here only once the server has taken it, and a server that asks for later is retried, backing off from 30 seconds to an hour; until then it sits in that folder under its caps — the oldest run's folder goes when the queue passes 500 MB or seven days. The telemetry file of the current run stays whole until the app quits, and is sent whole once more at the next launch, which the server treats as nothing new.

What arrives is filed under this install's id, a random id made once and shown in **Settings > Eye**: no name, email, or account goes with it, and nothing ties the id to you unless you tell the team what yours is, which is how they find your sessions. Nothing is sent while Eye is off except feedback you send yourself, and nothing asks you for an address or a token: the app knows where to send.

## Settings

| Setting | What it does |
| --- | --- |
| Eye | On or off. Off by default, and off in a fresh install until you answer the first-run question. |
| Recorded | Not a setting: frames taken and requests kept since Jaspers started, and what the folder holds now. |
| This install | Not a setting: the id your sessions are filed under. |
| Folder | **Reveal the folder** opens `~/Jaspers/data/eye`. |
| Delete all | Removes every frame and every line, sent or not. While recording, what is recorded after it is a session of its own. |

## Turning it off

Press the dot and **Stop recording**, or set **Eye** to off in **Settings > Eye**. The timer is cleared the moment it goes off: no frame is taken and no line is written. What was already recorded stays in the folder until you delete it, which **Delete all** does in one press; anything recorded while Eye was on that had not gone yet still goes.
