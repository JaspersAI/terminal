# AGENTS.md

Instructions for AI coding agents working in this repository. They are the same for every agent and live in [CLAUDE.md](CLAUDE.md): read it first, then [README.md](README.md), [How it works](docs/architecture.md), and [Development](docs/development.md).

The short version:

- Jaspers Terminal is a source-available Electron desktop terminal for financial research. The app owns the workspace and orchestrator; plugins supply views and data sources. Plugins are written against `@jaspers-ai/sdk` ([SDK reference](docs/sdk-reference.md)); skills follow the Agent Skills format ([Skills](docs/skills.md)).
- Use Node 24 (`nvm use`). Before finishing a code change, run `npm run typecheck`, the relevant `npm test`, and `npm run format:check`; build when changing entry points or process boundaries; exercise UI changes in the app.
- Verify the app with `--user-data-dir=<sandbox>/app` and `JASPERS_HOME=<sandbox>/home`, never against the user's own data.
- Everything the app fetches, and every key, stays on the user's machine. Do not add a path that sends either anywhere the user did not choose.

Jaspers' hosted MCP servers and the rest of what it offers agents are described at https://jsprai.com/agents.md.
