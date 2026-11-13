# Jaspers Terminal docs

Jaspers Terminal is an Electron desktop application and spreadsheet grid for public-market research, source-available under BSL 1.1. Built around an open-inference agent harness, it enables local, self-hosted, and open-weight language models (via Ollama, vLLM, `llama.cpp`, LM Studio, OpenRouter, Groq, or any OpenAI-compatible server) alongside cloud providers and Jaspers One to drive MCP servers, TypeScript plugins, and a local SQLite store.

## Core capabilities

- **Open-inference harness & model routing** — Run local and open-weight models via Ollama (`http://localhost:11434/v1`), vLLM, `llama.cpp`, LM Studio, OpenRouter, Groq, or any OpenAI-compatible endpoint alongside Jaspers One and cloud provider keys, with two-tier `model` + `fastModel` routing, portable conversation history (`portable`) across model switches, per-room (`create_room { model }`) and per-task (`schedule_task { model }`) model pinning, SQLite context offloading, and automatic recovery from context-window limits, mid-call output cutoffs, and duplicate tool calls ([Getting started](getting-started.md), [How it works](architecture.md)).
- **Built-in coding agent (`build_plugin`)** — Generate TypeScript plugins for data feeds, views, document generators, or MCP connections from four starter templates within a user-approved security envelope ([Asking the assistant for a plugin](asking-for-a-plugin.md), [Plugin templates](templates/README.md)).
- **Skills and scheduled workflows** — Use [Agent Skills](https://agentskills.io) (`SKILL.md`), NYSE market-calendar scheduled tasks, and SQLite delta watches (`speak: "changed"`) for recurring research tasks ([Skills](skills.md)).
- **Pro mode** — Run multi-line shell, PowerShell, Python, R, and CLI scripts in `~/Jaspers/shell` across macOS, Windows, and Linux, with configurable approval tiers, read-only command filtering, and macOS `sandbox-exec` confinement ([Pro mode](pro-mode.md)).

## Guides

| Guide | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Model configuration (Ollama, vLLM, llama.cpp, LM Studio, OpenRouter, Groq, cloud keys, Jaspers One), thinking and fast models, workspace model switching, per-room and per-task model pinning, commands, and packaging |
| [How it works](architecture.md) | Open-inference prompt and context bounds (Zod contracts and SQLite storage in `~/Jaspers/data/jaspers.db`), loop recovery, the `build_plugin` coding agent lifecycle, concurrent Grid Rooms, and project layout |
| [Asking the assistant for a plugin](asking-for-a-plugin.md) | The built-in coding agent (`build_plugin`), the one approval question it asks, and the `.jaspers-build.json` envelope a built plugin is held to |
| [Writing a plugin](writing-a-plugin.md) | Build a watchlist plugin from scratch with `@jaspers-ai/sdk`: an MCP server, a source, and a React view |
| [SDK reference](sdk-reference.md) | `definePlugin`, `defineSource`, `defineView`, `ctx`, React hooks, Agent Skills helpers, connections, and secrets |
| [Plugin templates](templates/README.md) | The four starter templates (`feed`, `feed-table`, `document`, `connection`) used for plugin scaffolding and coding-agent reference fixtures |
| [Installing plugins](installing-plugins.md) | Installing from [Jaspers Hub](https://hub.jsprai.com), a GitHub release, a link, or a file, and what to trust |
| [Skills](skills.md) | Writing, installing, and using Agent Skills (`SKILL.md`), NYSE market-calendar tasks, SQLite delta watches, and skills in a plugin |
| [Connections and data](connections-and-data.md) | Adding an MCP server, the built-in Table/Chart/Metric views, MCP Apps, citations, and `~/Jaspers/data/jaspers.db` |
| [Publishing a plugin](publishing-a-plugin.md) | Publishing plugins and skills to [Jaspers Hub](https://hub.jsprai.com) from Settings, or as an archive on a GitHub release |
| [Pro mode](pro-mode.md) | Letting the assistant run local shell, Python, R, and CLI scripts in `~/Jaspers/shell`, approval tiers, and `sandbox-exec` confinement |
| [Eye](eye.md) | Live feedback sharing, how the app is used: what is captured, what never is (including Pro mode and key prompts), and where it goes |
| [Development](development.md) | Process boundaries, invariants, testing, and packaging |
| [Roadmap](roadmap.md) | Implemented capabilities (analyst rooms, custom screeners, Excel export) and planned features |

`assets/` holds the images the docs use.
