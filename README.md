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

A plugin or a skill of your own goes to Hub from Settings, a skill also by asking the assistant, and is listed once Hub has reviewed it: see [Publishing a plugin](docs/publishing-a-plugin.md).

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
