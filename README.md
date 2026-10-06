<p align="center">
  <img src="docs/assets/logo.png" alt="Jaspers Terminal" width="160">
</p>

<h1 align="center">Jaspers Terminal</h1>

<p align="center">
  An open source, extensible desktop terminal for financial research.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-black"></a>
  <a href="https://www.npmjs.com/package/@jaspers-ai/sdk"><img alt="@jaspers-ai/sdk on npm" src="https://img.shields.io/npm/v/@jaspers-ai/sdk?label=%40jaspers-ai%2Fsdk&color=black"></a>
  <img alt="Node 24" src="https://img.shields.io/badge/node-24-black">
  <img alt="macOS" src="https://img.shields.io/badge/platform-macOS-black">
</p>

---

Ask for what you want to see, by voice or by typing. An AI assistant lays views out on a grid, fills them with data from MCP servers, and keeps adjusting them as you refine the request. Everything on screen comes from plugins.

> **Early stage.** Features land one at a time. There is no prebuilt download yet: run it from source or package your own copy.

<!-- Screenshot: replace with a capture of a workspace once one is ready.
<p align="center">
  <img src="docs/assets/screenshot.png" alt="A Jaspers Terminal workspace" width="800">
</p>
-->

## Features

- **Workspaces.** Each workspace is a grid filling the window, 16 × 12 cells to start and up to 100 × 100 from Settings > Appearance, with columns lettered and rows numbered like a spreadsheet. Switch between workspaces from the bar at the top; Settings is in the menu bar: under Jaspers Terminal on a Mac (⌘,), under File on Windows (Ctrl+,). A workspace can spread over several windows, each with a grid of its own: open one from the same menu, and drag a view from one window into another by its bar.
- **All your screens.** Screens > Use All Screens gives the workspace one window per monitor, each filling its own screen, and the assistant does it too — "spread this across both my screens". Screens > Back to One Screen moves everything into the main window's grid and closes the rest; it says what is in the way rather than dropping anything. Unplug a screen and the window that was on it comes back onto one that is still there. See [Several screens](docs/getting-started.md#several-screens).
- **Cells you can type in.** The cells no element sits on are a light spreadsheet: click one and type a number, a label, or a formula starting with `=`. References are the cell names already on screen (`A1`, `A1:B9`), with Excel's arithmetic and about forty-five of its functions: the aggregates and `SUMIF`, `INDEX`, `MATCH` and `VLOOKUP`, the text ones, and `NPV`, `IRR`, `PMT`, `FV` and `PV`, since this is a research terminal. What you type is part of the workspace, so it is still there when you come back. The assistant can fill cells too — "put last quarter's revenue in B2 and the growth beside it" — and read back what they come to.
- **An assistant that lays out the screen.** Type a request, or hold the orb or the space bar and talk. The assistant places, moves, resizes, maximizes, and re-tiles elements, and answers in a box above the composer. The chat keeps the whole conversation: scroll up to read back through it. You can also drag elements around by hand: drop one on another to swap them, drag an edge to resize, double-click the bar to maximize. The composer floats at the bottom and tucks itself away when nothing needs it; Dock puts the chat and its command line on the grid instead, as an element that stays where you put it and moves and resizes with the rest, and Undock brings the floating one back. Voice stays with the floating composer.
- **Loops it can drive.** A piece of work has one tile on the grid, and every view it shows is laid out inside that tile: a chart, a table, and the figures beside them are one tile, which you move, resize, minimize, and maximize as one. Inside it, drag the edge between two views to resize one. The assistant changes what a view shows by writing its state, and reads back what it is showing. A piece of work is a loop, named by its number as it is made: loop_1, loop_2. At the top of its tile is its command line: type there, or press Cmd-K on the focused tile to put the caret in it, and the request goes to an assistant working on that loop, with a conversation of its own, so "log scale" or "add the 200-day average" needs no explaining which one you mean. The box stays folded to that line: a small label in the tile's bar says how the loop stands (working, with what it is doing now, done, or failed), and pressing it opens the steps and the reply, or for a deep research loop its whole conversation. Its questions are asked on the line. It changes only its own views and lays them out when you ask. Closing a loop keeps it, views and conversation: Settings > View loops lists every loop of the workspace and reopens a closed one. The bar names the loop. Docked chat remains the global conversation.
- **Scheduled tasks.** "Refresh this every 30 seconds." "Every morning at nine, screen for software companies growing fast." A refresh runs on its own; a request runs through the assistant and speaks in the chat only when it has something to tell you, marked as the task's, so you can ask about it after. Tasks belong to a workspace, show in Settings, and survive a restart.
- **Runs in the background.** Closing the window keeps Jaspers in the menu bar, so tasks keep running until you quit. Notices reach your system notifications while the window is away.
- **Data from MCP servers.** Add one in Settings with a URL or a command, or let a plugin declare it. When one needs an API key, the assistant asks for it in a secure field, and the key is sealed in your OS keychain.
- **Everything it fetches, kept.** Every source run is filed in one SQLite file under `~/Jaspers/data/`, with what was asked and when. The assistant reads across all of it with SQL, so it can compare two providers or look further back than the last call, and full-text search finds a phrase in a filing it pulled last week. Nothing expires and nothing leaves the machine; open the file with sqlite3, DuckDB, or pandas while Jaspers runs.
- **The web, when nothing installed answers.** With a search provider set in Settings > Language model (Brave Search on your own key, or Amazon Bedrock's Web Search on your AWS account; signing in with Jaspers brings one), the assistant looks a question up, reads the page behind a result, and links what it used. Paste an address and it reads that page. It reads only pages a search returned or you gave it, never an address of its own making.
- **Tables, charts, and figures for anything.** Built-in views render any source or any query, so a server needs no view of its own: a sortable table, a chart (line, area, bar, scatter, pie, candlestick, heatmap), or one big number.
- **A server's own views.** A server that ships a view for a tool's answer (MCP Apps) has it shown on the grid when the assistant calls the tool. It runs sandboxed, apart from the app, and each connection asks once before its first view is shown.
- **Plugins.** Views and data sources come from plugin folders that rebuild as you save them. Install someone else's from [Jaspers Hub](https://hub.jsprai.com), a GitHub release, a link, or a file; the app shows where it came from and asks before any of its code runs. Publish your own to Hub from Settings. Plugin views run in sandboxed iframes.
- **Skills.** Write down how you want a kind of work done, and the assistant follows it when a request calls for it, or when you type `/name`. Skills use the [Agent Skills](https://agentskills.io) format: write them in Settings or ask the assistant to, install them from GitHub, or upload them. Plugins bring skills too, and their own models can load them.
- **Pro mode.** Off by default: turn it on in Settings and the assistant can ask to run shell scripts — a whole multi-step workflow in one, shown to you in full to approve or deny. macOS confines every command to Jaspers's own folder — it cannot read your documents or write anywhere else — and what it leaves there you open from Settings. See [Pro mode](docs/pro-mode.md).
- **Eye.** Off by default, and it asks you once before it records anything: turn it on from the eye in the workspace bar and Jaspers keeps a picture of its own windows every few minutes, plus a line for what the app did — which views were placed, which tools ran, how long they took. Never your desktop, never what you type, and never a frame while a key field or an approval is on screen. It goes to Jaspers as it is recorded, filed under an id this install made and nothing more, and Delete all empties what is still on your machine. The same eye takes feedback: write a note, press Send, and it goes to the team with a picture of the windows as they were. See [Eye](docs/eye.md).
- **Bring your own model, or sign in with Jaspers.** Anthropic, OpenAI, Google, OpenRouter, Groq, xAI, Ollama, or any OpenAI-compatible endpoint. Voice through ElevenLabs, OpenAI, Deepgram, or Cartesia. Or sign in with Jaspers in your browser, and the model, voice, web search, and the Jaspers Screener are set up in one step. Nothing needs an account: without one, the app is yours with your own providers.

## Quick start

Requires [Node 24](.nvmrc) (`nvm use`). Developed on macOS.

```sh
git clone https://github.com/JaspersAI/terminal.git
cd terminal
npm install
npm run dev
```

On first launch, sign in with Jaspers, or pick a language model provider and paste its key. A voice provider is optional. The last step is the plugin directory, which is Jaspers Hub's: the featured plugins first, then the rest of Hub. Signing in with Jaspers installs the Jaspers Screener and Jaspers Research by themselves; nothing else installs until you press its Install, and Settings > Plugins keeps the same list, with a search. Finish, and the assistant welcomes you in the chat, with an example of something to ask for with what you installed.

See [Getting started](docs/getting-started.md) for the commands, packaging, and how to reset.

## Plugins on Jaspers Hub

The app ships no plugins. Its plugin directory, in setup's last step and in Settings > Plugins, is [Jaspers Hub](https://hub.jsprai.com)'s: the plugins Hub features first, in Hub's order, then every other plugin there, most starred first. Jaspers' own are published there as `jaspers` and marked official, with the Jaspers Screener and Jaspers Research featured. Each of them also lives in its own repo under [JaspersAI](https://github.com/JaspersAI), and those repos are the examples to read when writing your own.

A plugin or a skill of your own goes to Hub from Settings, and is listed once Hub has reviewed it: see [Publishing a plugin](docs/publishing-a-plugin.md).

## Documentation

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | Run it, first launch, commands, packaging a macOS app |
| [How it works](docs/architecture.md) | The processes, the state tree, how a plugin is wired in, project layout |
| [Writing a plugin](docs/writing-a-plugin.md) | Build a watchlist plugin from scratch: an MCP server, a source, and a view |
| [SDK reference](docs/sdk-reference.md) | `definePlugin`, `defineSource`, `defineView`, `ctx`, the hooks, connections and secrets |
| [Installing plugins](docs/installing-plugins.md) | From Jaspers Hub, a GitHub release, a link, or a file, and what to trust |
| [Skills](docs/skills.md) | Writing, installing, and using skills, and skills in a plugin |
| [Connections and data](docs/connections-and-data.md) | Adding an MCP server, the built-in views, a server's own views, and the file everything is kept in |
| [Publishing a plugin](docs/publishing-a-plugin.md) | To Jaspers Hub from Settings, or as an archive on a GitHub release |
| [Roadmap](docs/roadmap.md) | What would matter most next |

Contributor commands and architectural rules are in [CLAUDE.md](CLAUDE.md); implementation constraints are in [Development](docs/development.md).

## Principles

- One feature at a time. Scope follows use, not a spec.
- Add nothing ahead of need. Small, readable code over abstraction.
- Extension APIs come from real extension points, not guesses.

## License

[MIT](LICENSE)
