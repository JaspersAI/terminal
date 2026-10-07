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

> **Early stage.** Features land one at a time.

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

## A coding agent, built in

Jaspers connects to any data source with an API, because it writes the connection itself. Ask for the thing, not the plugin: "chart the 10-year Treasury yield from FRED", "make me a PDF of this memo", "connect me to my firm's research server at this address". The assistant first searches [Jaspers Hub](https://hub.jsprai.com) for a published plugin that does it and offers to install that. When Hub has none, it hands the request to its builder, a second model loop with the SDK documentation and four plugin templates in front of it. The builder researches the service's API, writes the data source and the views, fixes its own build errors, and tests each source with a real call. Then the chart lands on your grid.

You approve before anything runs. One question in the answer box shows the plugin's envelope, every host it may reach, every key it may ask for, every capability and npm package it uses, with the files below it, and the app holds every line the builder writes afterwards to that list: an edit that reaches a new host or adds a package fails to build until you are asked again. Keys are never typed into the chat or written into code; the plugin declares one and the app asks for it in a secure field when a source first needs it. A build that stops partway, by Stop, a provider failing, or the app closing, keeps what it wrote and carries on when you ask again. The result is an ordinary plugin folder under `~/Jaspers/plugins/`, listed in Settings > Plugins as built by the assistant, yours to edit, remove, or publish to Hub. See [Asking the assistant for a plugin](docs/asking-for-a-plugin.md).

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

## Jaspers Hub

[Jaspers Hub](https://hub.jsprai.com) is where plugins and skills are found, published, and shared. The app ships no plugins: its plugin directory, in setup's last step and in Settings > Plugins, is Hub's, the plugins Hub features first, in Hub's order, then every other plugin there, most starred first. The assistant searches the same directory before it builds anything. Jaspers' own market data takes no private path: the Jaspers Screener and Jaspers Research are published there as `jaspers`, marked official, and install and run like any other plugin. Each of them also lives in its own repo under [JaspersAI](https://github.com/JaspersAI), and those repos are the examples to read when writing your own.

Publish your own from Settings, a plugin you wrote with the SDK, one the coding agent built for you, or a skill, which the assistant can also publish when you ask. Every version waits for Hub's review and is listed once approved; Settings shows where each one stands. See [Publishing a plugin](docs/publishing-a-plugin.md).

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

## Principles

- One feature at a time. Scope follows use, not a spec.
- Add nothing ahead of need. Small, readable code over abstraction.
- Extension APIs come from real extension points, not guesses.

## License

[MIT](LICENSE)
