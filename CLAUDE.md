# Contributor guidance

Jaspers Terminal is an open source Electron desktop terminal for financial research. The app owns the workspace and orchestrator; plugins supply views and data sources. Start with [README.md](README.md), [How it works](docs/architecture.md), and [Development](docs/development.md).

## Commands

Use Node 24 (`nvm use`) before running commands.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Electron with hot reload |
| `npm run build` | Build main, preload, renderer, and the plugin view runtime into `out/` |
| `npm start` | Run the existing build; run `npm run build` first |
| `npm run typecheck` | Typecheck, including unused locals and parameters |
| `npm test` | Node's test runner over `src/**/*.test.ts` |
| `npm run format` | Format code with Prettier |
| `npm run format:check` | Check formatting without writing |
| `npm run sdk:build` | Build the SDK and its declarations for publishing |
| `npm run dist` | Build and package for this platform: a macOS arm64 app, signed with the Developer ID if the keychain has it, or a Windows installer |
| `npm run test:packaged` | Open and use a packaged app with Playwright: `INSTALLER=<exe>` on Windows, `APP_BINARY=<executable>` elsewhere |

Vite strips types without checking them. Before finishing code changes, run typecheck, relevant tests, and format checking. Build when changing entry points or process boundaries; build the SDK when changing its public types. Exercise UI changes in the app.

For app verification, use both `--user-data-dir=<sandbox>/app` and `JASPERS_HOME=<sandbox>/home`. This isolates state, workspaces, plugins, memory, and the store from the user's data.

## Releasing

A pushed tag `v<version>` is a release: `release.yml` builds, signs, and uploads the Windows installer and the notarized Mac DMG and zip, each platform with the update feed its installed apps check. The tag must equal `version` in package.json, so bump it and commit first, then `git tag v<version>` and `git push origin main v<version>`, and read the run's summary for the links. Re-run a failed run in place with `gh run rerun <id> --failed`; never re-tag. Run workflow by hand on a branch for a dry run that uploads nothing. The procedure, the secrets, and what each one is are in [Development](docs/development.md#releasing-and-updates).

## Architectural rules

- Main owns one state tree. `src/main/state.ts:update` is its only write path. The tree's own files (`state.ts`, `actions.ts`, `persist.ts`, `secrets.ts`, `home.ts`) and the entry point stay at the root of `src/main/`; everything else is in a folder per area, named as `src/shared/`'s are. The renderer dispatches named actions and receives the public tree by push; it never changes that tree itself.
- Runtime inputs are untrusted. Validate IPC in main and keep domain rules in shared pure functions. Model-specific coercion belongs at the tool boundary. Malformed clock rules must fail rather than become daily schedules.
- `src/shared/` contains types and pure logic without Node or DOM imports, in a folder per area: `agent/`, `llm/`, `grid/`, `tasks/`, `plugins/`, `data/`, `skills/`, `hub/`, and `app/`. What every area reads stays at its root: `state.ts`, `paths.ts`, `rpc.ts`, and `abort.ts`. Its tests run directly in Node 24; runtime relative imports reachable from a test use `.ts` extensions.
- The SDK imports nothing from the app. The app resolves its source through the `jaspers-source` condition; published plugins resolve the built package. Keep both paths working.
- Plugin views use SDK hooks and the bridge, never `window.app` or their own network. Main holds credentials. Plugin backends run in utility processes with declared capabilities.
- A server's own page (MCP Apps) is the server's code. It runs on `jaspers-app://`, sandboxed, with the policy it declared, and reaches only its own connection's tools, through main. Check what it asks in main against the panel it is drawn in, and never put a server's string into a policy unchecked.
- Plugin hosts and VM evaluation contain faults, not malicious code. Install confirmation is required before evaluation; the installs without a prompt are what setup's Jaspers sign-in comes with, the Jaspers Screener and Jaspers Research, which the sign-in's own consent covers and `default-install.ts` holds to Jaspers' own reviewed versions from Hub. Preserve path confinement, capability checks, and message-source checks when refactoring.
- An element's id is unique across its workspace's windows. Resolve the owning grid instead of assuming the main window. Scheduled work uses its captured workspace, not whichever one is on screen.
- Every element on a grid but the docked chat is a tile of a loop: a piece of work with its own agent and conversation, named by the number in its id: f3 is loop_3 (`loopName`). A loop has one frame on a window's cells, and the views it shows are tiles laid out inside the frame (`parent`), on the frame's own cells: change one layout at a time (`layoutOf`, `withLayout`), never a grid's elements all together. A loop is made with its frame and closed with it, in `placeChecked`, `createLoop`, and `removeChecked` and nowhere else; closing keeps the record, the frame's tiles, and the conversation (`Loops.closed`) for View loops to reopen (`reopenLoop`), and only `deleteLoop` forgets one. A loop's agent changes only its own tiles, says what it found in its conversation rather than on the grid, and what its run asks is asked in its frame.
- Provider-specific assistant payloads must be replayed intact through the request they were written in. A thread is kept whole and sent in part (`src/shared/agent/aside.ts`): the request at work as it is, an earlier request as its words and calls with a note where a long answer was, and this request's own answers as notes once they pass what it keeps whole. Never delete an answer from a thread to save tokens; `read_again` gives back what a note stands for. Threads belong to a chat (a workspace's, one of its loops', or a plugin's unfinished build) and a model, and persist across sessions. A thread is kept as each turn joins it, and a run that ends early stays in it, closed off in a shape the provider takes back. Changing provider, base URL, or model starts a different conversation.

## Where code belongs

| Area | Entry points |
| --- | --- |
| State, mutations, persistence | `src/main/state.ts`, `actions.ts`, `persist.ts` |
| Grid rules and integration | `src/shared/grid/grid.ts`, `src/main/grid/grid.ts`, `windows.ts` |
| Orchestrator and conversations | `src/main/agent/agent.ts`, the agent loop, over `utils/`; `orchestrator.ts`, the global box's and a task's requests, and `loop.ts`, a piece of work's, both over `request.ts`; `router.ts`, the tools that start, hand to, and delete work; `threads.ts`, `thread-file.ts`, `memory.ts`; rules in `src/shared/agent/` |
| Tool families | `src/main/agent/tools.ts` composes `src/main/agent/tools/` |
| Builder and the web | `src/main/agent/build.ts` over `build/`; `web/` is the search client and the page fetch |
| Provider protocols | `src/main/llm/llm.ts` dispatches to the adapters beside it; `http.ts` is the wire, `voice.ts` speech to text; shared types and retry rules in `src/shared/llm/` |
| Loops | `src/shared/loops/loops.ts`, the rules and names, and `closed.ts`, closing, reopening, and the loop log; `src/main/loops/loops.ts`, the records in the tree; `src/main/agent/loop.ts`, the requests sent for a tile; `src/renderer/components/grid/LoopBox.tsx` over `box.ts` and `Progress.tsx`, the frame's box, and `Board.tsx`, the tiles inside it; `LoopMenu.tsx` over `src/shared/loops/menu.ts`, its menu; `status.ts` over `working.ts`, the bar's mark; `settings/LoopsDialog.tsx`, View loops |
| Scheduling | `src/main/tasks/tasks.ts`, `src/shared/tasks/tasks.ts`, `clock-rule.ts` |
| Plugins and connections | `src/main/plugins/`: `plugins.ts`, `plugin-host.ts`, `registry.ts`, `install.ts` over `install-stage.ts`, an install staged and committed, and `default-install.ts`, what a Jaspers sign-up comes with; `connections.ts`, `mcp.ts`, `capabilities/` |
| Jaspers Hub | `src/main/hub/`: `hub.ts`, Hub's listings and items and what is written to it as the account, over IPC in `hub-ipc.ts`; `publish.ts`, packing and publishing; the shapes and links in `src/shared/hub/hub.ts`; the directory in `src/renderer/lib/hub-directory.ts` and `settings/Directory.tsx`, publishing in `settings/HubPublish.tsx` |
| A server's own views | `src/shared/plugins/apps.ts`, the rules; `src/main/plugins/apps.ts` over `app-calls.ts`, `app-pages.ts`, `app-consent.ts`; `src/renderer/views/App.tsx` |
| Plugin processes and view runtime | `src/plugin-host/`, `src/host-runtime/` |
| Skills | `src/main/skills/`: `skills.ts` over `skill-registry.ts`, `skill-files.ts`, `skill-install.ts`; `skill-write.ts`, a skill the assistant writes, asked of the user first |
| App shell | `src/main/app/`: `background.ts`, `tray-icon.ts`, `shell-path.ts`, `notices.ts`, `theme.ts`, `loopback.ts`, the port a browser flow comes back to |
| Jaspers sign-in | `src/main/jaspers/`: `jaspers.ts` over `session.ts`, the flow with Account and the tokens, and the fetch that sends as the account; the rules in `src/shared/app/jaspers.ts`; `secrets.ts` gives the Jaspers provider that fetch, `plugins/mcp.ts` a server that signs in through Account, and `hub/hub-ipc.ts` Hub |
| Eye | `src/main/eye/eye.ts` records, `upload.ts` sends; the rules and the fixed endpoint in `src/shared/app/eye.ts` |
| Sources and store | `src/main/data/sources.ts`, `store.ts`, `src/store/` |
| Renderer bridge and state mirror | `src/preload/index.ts`, `src/renderer/lib/` |
| Composer | `Composer.tsx` composes `request.ts`, `conversation.ts`, `reveal.ts` in `src/renderer/components/composer/`; `Transcript.tsx` is the conversation itself and `dock.ts` the swap with the `core/chat` element (`views/Chat.tsx`) |
| SDK | `packages/sdk/src/`; public contracts in `define.ts`, `ctx` in `context.ts`, hooks in `hooks.ts` |

See [Development](docs/development.md) for process, security, packaging, and extension details. User-facing behavior belongs in [docs/](docs/README.md), not a duplicate module-by-module narrative here.

## Working style

- One feature at a time. No speculative abstractions, frameworks, or dependencies. Prefer small functions and explicit composition.
- Keep domain logic beside its feature; share a helper when it represents the same rule in multiple places.
- Prettier defines formatting: single quotes, no semicolons, 120-column target. No separate linter is required. Prefix intentionally unused parameters with `_`.
- Square corners are the house style: no `rounded-*` classes. The talk orb is the deliberate exception. Use the color, typography, and motion tokens in `src/renderer/styles.css`; its colors come from `src/host-runtime/theme.css`, which plugin views share, so give a new color a dark value too.
- Preserve comments that explain constraints and tradeoffs. Avoid narrating obvious operations or keeping obsolete behavior in comments.
- Update docs when commands, contracts, or architecture change. Keep implementation details out of user flows.
