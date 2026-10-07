<p align="center">
  <img src="docs/assets/logo.png" alt="Jaspers Terminal" width="160">
</p>

<h1 align="center">Jaspers Terminal</h1>

<p align="center">
  The agentic terminal for public markets.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-black"></a>
  <a href="https://www.npmjs.com/package/@jaspers-ai/sdk"><img alt="@jaspers-ai/sdk on npm" src="https://img.shields.io/npm/v/@jaspers-ai/sdk?label=%40jaspers-ai%2Fsdk&color=black"></a>
  <img alt="Node 24" src="https://img.shields.io/badge/node-24-black">
  <img alt="macOS and Windows" src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows-black">
</p>

---

Say what you want to see, by voice or by typing. ChatGPT and Claude answer in a thread; markets happen on a screen. In Jaspers, the assistant works the screen itself: it puts the right view on the grid, fills it with market and alternative data from MCP servers, reads what every view shows, and changes it as you ask. When nothing installed has the data, its coding agent writes the plugin that does. Everything on screen comes from plugins.

<!-- Screenshot: replace with a capture of a workspace once one is ready.
<p align="center">
  <img src="docs/assets/screenshot.png" alt="A Jaspers Terminal workspace" width="800">
</p>
-->

## What it is

We are Jaspers, a team of quants, engineers, and investment professionals. We have built v0 of Jaspers Terminal, an open-source, free harness for agents to work with public markets.

Today, traders and researchers face a fragmented research process, starting with discovering the right data, and continuing with integrating different interfaces, APIs, and formats.

General-purpose harnesses cram context and interactions into a chat thread, making it difficult to build and monitor strategies. Traders and researchers juggle data platforms, spreadsheets, local files, and scripts. They move information between tools and rebuild context at every step.

Jaspers Terminal's integrated coding agent researches and implements the data connectors, visualizations, and data-processing plugins your work requires. It writes the code, installs the plugin, and runs your workflow directly in the Terminal.

Developers can build plugins with the Terminal SDK while users can use coding agent to do the same. Plugins can define data sources, views, and connections, and read and publish panel state through the app's hooks. Backends declare their capabilities and call the user's model, tools, files, skills, and sandbox without holding credentials or opening their own network connections.

You and your superagent arrange the Terminal's dynamic grid to fit your work, construct dashboards, monitor live data, and run complex scheduled and recurring tasks. You control the layout and the execution loops that keep your strategies running.

**Download** Jaspers Terminal for macOS and Windows at [jsprai.com/terminal](https://jsprai.com/terminal/).

## Open source

MIT-licensed, and complete without a Jaspers subscription. Read how any source is queried, change any plugin, or write your own with `@jaspers-ai/sdk`, a small React API: define a source, define a view. The app uses open standards instead of inventing its own: the Model Context Protocol for data and interfaces, Agent Skills for workflows. Jaspers' own market data takes no private path: Jaspers Discover and Jaspers Research are plugins on [Jaspers Hub](https://hub.jsprai.com) like any other, hosted, metered, and optional.

## You own your data

Everything the Terminal fetches is kept in one SQLite file on your machine, `~/Jaspers/data/jaspers.db`, stamped with what was asked and when. Nothing expires and nothing leaves the machine. The assistant queries across all of it with SQL, so two vendors line up in one answer, and full-text search finds a phrase from last week's filing. Open the same file in sqlite3, DuckDB, or pandas while Jaspers runs. API keys are sealed in your OS keychain; plugin views run sandboxed with no network of their own, and plugin code gets only the capabilities it declares.

Bring your own model: Anthropic, OpenAI, Google, Amazon Bedrock, OpenRouter, Groq, xAI, any OpenAI-compatible endpoint, or a local model through Ollama, with voice through ElevenLabs, OpenAI, Deepgram, or Cartesia. Or sign in with Jaspers in your browser, and the model, voice, web search, and Jaspers Discover are ready in one step. Either way your keys, data, and history stay on your machine.

## Discover data and create connections on the fly

Jaspers connects to any data source with an API, because it writes the connection itself. Ask for the thing, not the plugin: "chart the 10-year Treasury yield from FRED", "connect me to my firm's research server at this address". The assistant first searches [Jaspers Hub](https://hub.jsprai.com), where plugins and skills are found, published, and shared, and offers to install one that does it. When Hub has none, it hands the request to its coding agent, which researches the service's API, writes the data source and the views, fixes its own build errors, and tests each source with a real call. Then the chart lands on your grid.

You approve before anything runs. One question shows the plugin's envelope, every host it may reach, every key it may ask for, every capability and npm package it uses, and the app holds every line written afterwards to that list. Keys are never typed into the chat or written into code. The result is an ordinary plugin folder, yours to edit, remove, or publish to Hub from Settings, where every version is reviewed before it is listed. Any MCP server plugs in the same way: add one in Settings with a URL or a command, or let a plugin declare it. See [Asking the assistant for a plugin](docs/asking-for-a-plugin.md).

## Build real-time dashboards of any kind

Your workspace is a grid, lettered and numbered like a spreadsheet and laid out like a trading screen, up to 100 × 100 cells and spread across every monitor you have. Built-in tables, charts (line, area, bar, scatter, pie, candlestick, heatmap), and metrics show whatever a source returns, so a server needs no view of its own; one that ships its own as an MCP App has it shown right on the grid. Every tile is a piece of work with its own agent and conversation, and they run side by side: refine one from its command line ("log scale", "add the 200-day average"), close it, and reopen it later with its views and conversation intact. The empty cells take Excel formulas, NPV and IRR included.

Keep it current in plain words: "refresh this every 30 seconds", "every morning at nine, screen for software companies growing fast". Tasks belong to a workspace, survive a restart, and keep running from the menu bar when the window is closed. In Pro mode the assistant can run shell scripts you approve, confined by macOS to a folder of its own.

## Quick start

Requires [Node 24](.nvmrc) (`nvm use`). Developed on macOS.

```sh
git clone https://github.com/JaspersAI/terminal.git
cd terminal
npm install
npm run dev
```

On first launch, sign in with Jaspers, or pick a language model provider and paste its key. A voice provider is optional. The last step is the plugin directory, which is Jaspers Hub's: the featured plugins first, then the rest of Hub. Signing in with Jaspers installs Jaspers Discover and Jaspers Research by themselves; nothing else installs until you press its Install, and Settings > Plugins keeps the same list, with a search. Finish, and the assistant welcomes you in the chat, with an example of something to ask for with what you installed.

See [Getting started](docs/getting-started.md) for the commands, packaging, and how to reset.

## Documentation

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | Run it, first launch, commands, packaging the app |
| [How it works](docs/architecture.md) | The processes, the state tree, how a plugin is wired in, project layout |
| [Asking the assistant for a plugin](docs/asking-for-a-plugin.md) | The coding agent, the one question it asks, and the envelope a built plugin is held to |
| [Writing a plugin](docs/writing-a-plugin.md) | Build a watchlist plugin from scratch: an MCP server, a source, and a view |
| [SDK reference](docs/sdk-reference.md) | `definePlugin`, `defineSource`, `defineView`, `ctx`, the hooks, connections and secrets |
| [Installing plugins](docs/installing-plugins.md) | From Jaspers Hub, a GitHub release, a link, or a file, and what to trust |
| [Skills](docs/skills.md) | Writing, installing, and using skills, and skills in a plugin |
| [Connections and data](docs/connections-and-data.md) | Adding an MCP server, the built-in views, a server's own views, and the file everything is kept in |
| [Publishing a plugin](docs/publishing-a-plugin.md) | To Jaspers Hub from Settings, or as an archive on a GitHub release |
| [Roadmap](docs/roadmap.md) | What would matter most next |

Contributor commands and architectural rules are in [CLAUDE.md](CLAUDE.md); implementation constraints are in [Development](docs/development.md).

## License

[MIT](LICENSE)
