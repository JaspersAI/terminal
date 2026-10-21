# Plugin templates

Four complete, working plugins — one for each plugin archetype in Jaspers Terminal (`feed`, `feed-table`, `document`, and `connection`). These four folders serve two roles at once:

1. **Developer scaffolding:** Copy any template folder into `~/Jaspers/plugins/<id>`, rename the folder and the `id` in `plugin.tsx` and `package.json` to match, and the running Terminal builds and hot-reloads it immediately. Because the Terminal supplies `react`, `react-dom`, `zod`, and [`@jaspers-ai/sdk`](../../packages/sdk/README.md) at runtime via `jaspers-host://runtime/`, templates that use only those libraries run with zero `node_modules`.
2. **Coding-agent reference fixtures (`build_plugin`):** `src/main/agent/build/reference.ts` imports every file in these four folders via Vite `?raw` into `REFERENCE.templates`, which `builderSystem` (`src/shared/agent/build/prompt.ts`) embeds verbatim into the built-in coding agent's system prompt when it [builds a plugin](../asking-for-a-plugin.md). Local/open-weight models and cloud models alike start by copying the matching template's exact structure rather than guessing SDK imports or boilerplate.

## The four starter templates

| Folder | Files | Archetype & what it demonstrates |
| --- | --- | --- |
| `feed/` | `plugin.tsx`, `package.json` | **Keyless data feed:** One function source (`defineSource`) that fetches a JSON API (`hosts: ['api.frankfurter.dev']`) with `ctx.fetch`, validates arguments with Zod (`input`), and returns flat JSON rows (`date`, `base`, `currency`, `rate`). Needs no custom view — the built-in `core/table`, `core/chart`, and `core/metric` views render its rows automatically. |
| `feed-table/` | `plugin.tsx`, `SeriesTable.tsx`, `styles.css`, `package.json` | **Keyed data feed + custom React view:** A function source (`hosts: ['api.stlouisfed.org']`) that declares `secrets: { apikey: { label: 'FRED API key' } }`, injects `'${secret:apikey}'` in single quotes into the query string, and pairs with a custom React view (`defineView(SeriesTable, { title, state, output, instructions, renders, summarize })`) using `useData`, `usePublish`, and theme CSS variables (`--jaspers-*`) in `styles.css`. |
| `document/` | `plugin.tsx`, `package.json` | **Document producer:** A function source declaring `capabilities: ['files']` that writes a generated report into the plugin's data folder (`~/Jaspers/<id>/reports/<name>.md`) with `ctx.files.write(path, content)` and opens it in the operating system's default application with `ctx.files.open(path)`. |
| `connection/` | `plugin.tsx`, `package.json` | **MCP server connection:** An HTTP MCP server declared with `defineConnection({ url: 'https://mcp.example.com/mcp', auth: 'bearer', headers: { Authorization: 'Bearer ${secret:token}' } })` and a tool exposed as a source via `defineSource({ mcp: 'server', tool: 'search', description })`. |

## Quick copy for local development

```sh
cp -R docs/templates/feed-table ~/Jaspers/plugins/my-series
```

Then update `"name": "my-series"` in `~/Jaspers/plugins/my-series/package.json` and `id: 'my-series'` (plus the source path in `useData('my-series/series', ...)`) in `plugin.tsx` and `SeriesTable.tsx`. The app detects the folder and builds it on save.

## Verified by the test suite (`templates.test.ts` & `typecheck`)

Because a broken template would teach both developers and the `build_plugin` coding agent broken code, every template is verified continuously by the repository's checks:

- **Typechecking (`npm run typecheck`):** Root `tsconfig.json` includes `"docs/templates"`, checking every template's TypeScript types against `packages/sdk/src` on every build.
- **Bundling & sandboxed evaluation (`src/main/agent/build/templates.test.ts`):** `npm test` runs the real plugin pipeline (`bundlePlugin` in `src/main/plugins/bundle.ts` and `evaluatePlugin` in `src/main/plugins/plugin-eval.ts`) over all four template directories:
  - Asserts that the template list equals `['connection', 'document', 'feed', 'feed-table']`.
  - Bundles each template with esbuild into a browser bundle (`bundle.js`, plus `bundle.css` for `feed-table`) and evaluates its definition inside the zero-privilege Node `vm` sandbox.
  - Verifies that `plugin.id` matches the folder name, every template registers at least one source in `plugin.sources`, `feed-table` registers `views.table` with `renders: [series]`, and imports outside a plugin's folder are rejected.

## Further reading

- [Asking the assistant for a plugin](../asking-for-a-plugin.md) — How `build_plugin` stages a template in `~/Jaspers/.build/<id>`, prompts for `.jaspers-build.json` envelope approval, and self-repairs.
- [Writing a plugin](../writing-a-plugin.md) — Step-by-step tutorial building a full watchlist plugin with an MCP server, source, and React view.
- [SDK reference](../sdk-reference.md) — Complete reference for `definePlugin`, `defineSource`, `defineView`, `defineConnection`, `ctx` capabilities, hooks, and secrets.
- [Publishing a plugin](../publishing-a-plugin.md) — Sharing your finished plugin on [Jaspers Hub](https://hub.jsprai.com) or via GitHub releases.
