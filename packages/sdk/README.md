# @jaspers-ai/sdk

TypeScript SDK ([`LICENSE`](LICENSE)) for [Jaspers Terminal](https://jsprai.com/terminal) ([`JaspersAI/terminal`](https://github.com/JaspersAI/terminal)): plugin definitions (`definePlugin`, `defineConnection`, `defineSource`, `defineView`), React hooks (`usePanelState`, `useData`, `usePublish`, `usePublishText`, `useDictation`, `useBridge`, `usePanel`), capability-gated backend context (`BackendContext`), and [Agent Skills](https://agentskills.io) helpers (`skillsPrompt`, `skillTools`, `runSkillTool`).

## Host runtime module resolution (`jaspers-host://runtime/`)

Jaspers Terminal provides `@jaspers-ai/sdk`, `react`, `react-dom`, and `zod` to plugins at runtime through `jaspers-host://runtime/` (built from `src/host-runtime/runtime.ts` by `scripts/build-host-runtime.mjs`):

- **Runtime import mapping:** Each `jaspers-plugin://<id>` view iframe maps bare imports (`@jaspers-ai/sdk`, `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, and `zod`) to the `jaspers-host://runtime/` bundle so the plugin view and the SDK hooks share a single React instance. Plugins that import only those modules do not require a `node_modules` directory at runtime.
- **Development installation:** Install `@jaspers-ai/sdk` in `devDependencies` for local editor completions, `tsc --noEmit`, and unit tests:

```sh
npm install --save-dev @jaspers-ai/sdk react zod typescript @types/react
```

## Quick example

```tsx
import { definePlugin, defineView, usePanelState, usePublish, type PanelRef } from '@jaspers-ai/sdk'
import { z } from 'zod'

function Hello({ panel }: { panel: PanelRef }) {
  const [name, setName] = usePanelState(panel, 'name', 'world')
  usePublish(panel, { greeting: `Hello, ${name}` })
  return (
    <button type="button" onClick={() => setName('market')}>
      Hello, {name}
    </button>
  )
}

export default definePlugin({
  id: 'hello',
  views: {
    hello: defineView(Hello, {
      title: 'Hello',
      state: z.object({ name: z.string().optional() }),
      output: z.object({ greeting: z.string() }),
    }),
  },
})
```

## React hooks

Views run inside network-isolated `jaspers-plugin://<id>` iframes and communicate with the main process and the assistant through these hooks:

| Hook | Purpose |
| --- | --- |
| `usePanelState(panel, key, init)` | Returns `[value, set]` for one key of `panel.state`. Writes are validated in main against the view's Zod `state` schema and pushed back to the view, so user interactions and assistant `place_view` / `set` calls update the same state object. |
| `useData(source, args)` | Runs an MCP or function source (`<plugin>/<source>`) through main whenever `args` change by value (`stableStringify`), retrying if the connection or source finishes starting up and re-running when the panel is refreshed. Returns `{ data, text, loading, error, datasetId, meta, refetch }`. |
| `useData(path)` | Subscribes to a path in the app state tree, such as `workspaces/<workspaceId>/panels/<id>/state` or `live/<key>`. Returns `undefined` until the first value arrives. |
| `usePublish(panel, output)` | Publishes structured JSON describing what the view is showing (debounced 100 ms, skipped when unchanged by value, validated against the view's Zod `output` schema, and bounded to 4 KB). |
| `usePublishText(panel, text)` | Publishes up to 200,000 characters of text (such as a filing or transcript) at `panels/<id>/text` for paginated reading (`get`) and `[^id]` citations. Pass `null` to clear. |
| `useBridge()` / `usePanel()` | Access the iframe host bridge (`openLink(url)` for external `https://` links, `copyText(text)` for the clipboard) and the current `PanelRef` (`{ id, workspaceId }`). |

## Agent Skills helpers (`@jaspers-ai/sdk` & `@jaspers-ai/sdk/skills`)

A plugin can include skill definitions in a `skills/<name>/SKILL.md` folder beside `plugin.tsx`. In addition, a plugin with a model loop of its own (`capabilities: ['llm', 'skills']`) can load [Agent Skills](https://agentskills.io) the same way the Terminal's assistant does: put `skillsPrompt(skills)` in the system prompt, offer the two skill tools from `skillTools(names)` (`activate_skill` and `read_skill_file`), and answer them with `runSkillTool`:

```ts
import { runSkillTool, skillsPrompt, skillTools } from '@jaspers-ai/sdk'

// in run(args, ctx) or a job, with capabilities: ['llm', 'skills']
const skills = await ctx.skills.catalog()
const system = [base, skillsPrompt(skills)].filter(Boolean).join('\n\n')
const tools = [...mine, ...skillTools(skills.map((s) => s.name))]
// for each tool call the model makes:
const result = (await runSkillTool(ctx.skills, call, turns)) ?? (await runMine(call))
```

Lower-level helpers (`wrapSkill`, `expandArguments`, `skillLoaded`, `alreadyLoaded`, `isSkillScript`, `ACTIVATE_SKILL`, `READ_SKILL_FILE`) are also exported for custom skill pipelines.

## Package entries

Plugins import the package root (`@jaspers-ai/sdk`). The subpath entries — `@jaspers-ai/sdk/define` (definitions without React), `@jaspers-ai/sdk/skills` (Agent Skills helpers alone), and `@jaspers-ai/sdk/host` (the iframe bridge used by `src/host-runtime/boot.tsx`) — are used by the Terminal application, which resolves `./src/*.ts` via the `jaspers-source` export condition.

## Documentation & examples

- [Writing a plugin](../../docs/writing-a-plugin.md) — Tutorial building a watchlist plugin.
- [SDK reference](../../docs/sdk-reference.md) — API reference (also imported via `?raw` into the Terminal's `build_plugin` coding agent).
- [Plugin templates](../../docs/templates/README.md) — Four starter plugins (`feed`, `feed-table`, `document`, `connection`) verified by the test suite.
- [Skills](../../docs/skills.md) — Agent Skills (`SKILL.md`), NYSE market-calendar scheduled tasks, and SQLite delta watches.
- [Publishing a plugin](../../docs/publishing-a-plugin.md) — Sharing plugins and skills on [Jaspers Hub](https://hub.jsprai.com).
- Official plugins on GitHub: [`JaspersAI/plugin-screener-mcp`](https://github.com/JaspersAI/plugin-screener-mcp), `plugin-research`, `plugin-tradingview`, `plugin-fmp`, `plugin-earningscall`, `plugin-markdown`, `plugin-yfinance`.

## License

MIT ([`LICENSE`](LICENSE)). Jaspers Terminal is licensed under the [Business Source License 1.1](../../LICENSE), which does not apply to plugins built with `@jaspers-ai/sdk` — plugins written or generated with the SDK may be distributed under any license.
