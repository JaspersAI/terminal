# Eye

Eye records how you use Jaspers, so the team can learn from it: a picture of the app's own windows every minute, each request you make to the assistant with what came of it, and a line of telemetry for what the app did. It is **off** until you turn it on, it asks you once before it ever records anything, and nothing in the app can turn it on for you — the assistant has no tool that reaches the setting, so it can neither start recording, stop it, nor read a frame. The switch is the one setting: where the recording goes, how often a picture is taken, and what is in one are the app's, not yours to configure.

## The first time

The first launch after Eye existed asks, once, in plain words: what a picture is of, how often one is taken, what is kept of a request, that it goes to Jaspers, and what is never in any of it. **Start recording** turns it on; **Not now** leaves it off. Either answer is remembered, so the question is asked once and never again, unless what Eye records changes: then it is asked again, in the new words, and nothing is recorded until you answer. You can change your mind at any time from the dot or from **Settings > Eye**.

## The dot

The eye at the right end of the workspace bar is the indicator, and pressing it opens a small panel under it with the switch and a feedback box. **Start recording** and **Stop recording** turn Eye on and off. While it is recording the dot is filled and breathes slowly; off, it is a hollow ring and still. With reduced motion turned on in your system settings it does not animate at all — the color and the label still say which it is.

## Feedback

Write what worked, what did not, or what you expected into the box and press **Send** (or ⌘/Ctrl+Enter). The panel closes, a picture of every open Jaspers window is taken that moment — the screen you were writing about, without the panel over it — and your note goes to the team with it. "Feedback sent" shows beside the dot once it is written; if it could not be, the panel opens again with your note still in it.

Feedback goes whether recording is on or off: pressing Send is your own act each time. The same rules hold for it as for a frame: keys the app holds are masked out of the note, a note is cut at 4,000 characters, and while a key field or a question is on screen no picture is taken and the note goes alone, saying why. On the server a window with feedback in it is always flagged for the team to read.

## What it captures

- The Jaspers window as it looks on screen, every minute, scaled to 1280 pixels wide and saved as a JPEG. This app only: not your desktop, not your browser, not another program. Every open Jaspers window gets a frame, and recording carries on while the windows are closed to the menu bar. A window that has not changed since the last picture is not pictured again.
- Each request to the assistant, once it has ended: what you asked, what it answered, or the error, or that you stopped it; whose it was (yours or a scheduled task's) and how long it took; and every tool it ran, with what the tool was given and what it gave back, or its error. Long texts are cut short.
- Which views are on the grid, and when one is placed, by the view's registry id (`core/chart`).
- That a notice was raised for you, by the plugin that sent it.
- Feedback you send from the eye, with a picture of the windows taken when you pressed Send.

## What it never captures

- Anything outside Jaspers.
- Keystrokes, cell contents, a view's data, a notice's words.
- Keys, passwords, and tokens the app holds: every one is masked out of a request's record before it is written, and a key pasted into a key field is never in a frame.
- Anything at all while a key field or a question is on screen. A frame would show the API key you are pasting, or the exact command a Pro mode approval is waiting on, so that tick is skipped entirely and nothing of that screen is kept. The next frame comes at the next interval.

## Where it goes

Into `~/Jaspers/data/eye`, one folder per app run, holding that run's frames, a file per request, a file per note of feedback, and its `events.jsonl`. **Settings > Eye > Reveal the folder** opens it: every frame is an ordinary JPEG and every line an ordinary line of JSON, so you can look through exactly what was recorded, and **Delete all** removes all of it.

Everything is posted to Jaspers, at `eye.jsprai.com`, as soon as it is whole: a frame moments after it is taken, a request moments after it ends, and the telemetry file in parts as lines are written to it. A frame or a request is deleted here only once the server has taken it, and a server that asks for later is retried, backing off from 30 seconds to an hour; until then it sits in that folder under its caps — the oldest run's folder goes when the queue passes 500 MB or seven days. The telemetry file of the current run stays whole until the app quits, and is sent whole once more at the next launch, which the server treats as nothing new.

What arrives is filed under this install's id, a random id made once and shown in **Settings > Eye**: no name, email, or account goes with it, and nothing ties the id to you unless you tell the team what yours is, which is how they find your sessions. Nothing is sent while Eye is off except feedback you send yourself, and nothing asks you for an address or a token: the app knows where to send.

## Settings

| Setting | What it does |
| --- | --- |
| Eye | On or off. Off by default, and off in a fresh install until you answer the first-run question. |
| Recorded | Not a setting: frames taken and requests kept since Jaspers started, and what the folder holds now. |
| This install | Not a setting: the id your sessions are filed under. |
| Folder | **Reveal the folder** opens `~/Jaspers/data/eye`. |
| Delete all | Removes every frame and every line, sent or not. |

## Turning it off

Press the dot and **Stop recording**, or set **Eye** to off in **Settings > Eye**. The timer is cleared the moment it goes off: no frame is taken and no line is written. What was already recorded stays in the folder until you delete it, which **Delete all** does in one press; anything recorded while Eye was on that had not gone yet still goes.
