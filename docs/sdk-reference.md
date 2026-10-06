# SDK reference

[`@jaspers-ai/sdk`](https://www.npmjs.com/package/@jaspers-ai/sdk) is what a plugin is written against. It lives in `packages/sdk` of this repo, an npm workspace the app itself imports by the same name.

```sh
npm install --save-dev @jaspers-ai/sdk react zod typescript @types/react @types/node
```

The app provides the SDK, `react`, `react-dom`, and `zod` at runtime, so the install is for types.

## `definePlugin`

`definePlugin({ id, secrets, connections, sources, views })`. The `id` must equal the folder name. Ids and names use lower-case letters, digits, and dashes.

### `frames`

`frames` lists the sites a plugin's views may show in an iframe, as exact https origins: `definePlugin({ id, views, frames: ["https://www.tradingview-widget.com"] })`. Only those sites load, and the view still has no network of its own. The plugin's view frames get an origin of their own, `jaspers-plugin://<id>`, instead of an opaque one, since a framed site cannot work without one. The site talks to the view by `postMessage`, so check `event.origin` and `event.source` before trusting a message. [`plugin-tradingview`](https://github.com/JaspersAI/plugin-tradingview) is the example.

## `defineSource`

`defineSource` has two forms:

```ts
// One tool on one connection. Parameters are the server's input schema.
defineSource({
  mcp: "server",
  tool: "quotes",
  description: "What it is for",
  ttlMs: 60_000,
});

// A call the plugin makes itself.
defineSource({
  description: "Latest rate for a currency pair",
  input: z.object({ pair: z.string() }),
  hosts: ["api.example.com"],
  run: async (args, ctx) => {
    const { pair } = args as { pair: string };
    const response = await ctx.fetch(`https://api.example.com/rates/${pair}`);
    return response.json();
  },
});
```

- `input` is parsed with zod before `run`. An optional `output` schema checks the result.
- `run` executes in the plugin's own process, with JavaScript's built-ins plus timers, `AbortController`, `URL`, `TextEncoder`, `structuredClone`, `atob`, and `btoa`. There is no `process`, file system, or network except through `ctx`.
- `ctx.fetch` reaches only the hosts in `hosts`.
- An API that takes its key as HTTP Basic auth, like `curl -u KEY:`, gets it as the address's user: `ctx.fetch('https://${secret:apikey}:@api.example.com/v1/rates')` sends it as an `Authorization: Basic` header and the address without it.
- `internal: true` keeps a source for the plugin's own views; the assistant is not offered it.
- Return an array of objects, or an object with the array under `rows`, `companies`, `items`, `results`, or `data`. Those become the rows and the rest becomes `meta`. Anything else comes back as text.
- An object's `citations`, each `{ id, title, url?, quote? }`, are sources the assistant can cite in the chat as `[^id]`: see [Citations in the chat](connections-and-data.md#citations-in-the-chat).

## `defineView`

`defineView(Component, { title, state, output, instructions, renders, summarize })`. `title`, `state`, and `output` are required. `state` and `output` are zod schemas. `summarize` infers both argument types from those schemas, including optional fields.

The [tutorial](writing-a-plugin.md#the-plugin) walks through each field.

## Backend code and `ctx`

A function source's `run(args, ctx)`, whose `args` are typed from the source's own `input` schema, so it reads them by name and `definePlugin({ start(ctx) })`, which runs each time the plugin's process starts, reach the app through `ctx`. What a plugin uses beyond `fetch`, `live`, `jobs`, and `notify` it declares in `definePlugin({ capabilities: ["llm", "files", "skills"] })`; an undeclared one throws.

A plugin with `start` gets its process when it loads. One without gets it on its first source run, and loses it after five minutes with no run, job, file watch, or live value, so keep anything that has to outlast a run in `ctx.files`.

| `ctx`         | Needs          | What it does                                                                                                                                     |
| ------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fetch`       |                | `fetch`, only to the source's `hosts`. `${secret:KEY}` in the address or a header value is filled in from the plugin's declared secrets before the request goes out; a key not set fails the call and names `set_secret` |
| `llm`         | `llm`          | `complete({ system, turns, tools, model, maxTokens, signal })` on the app's model; the key never reaches the plugin                              |
| `tools`       | `tools`        | `connections()`, `list()`, and `call(id, args)` for the tools on the app's MCP connections                                                       |
| `files`       | `files`        | `read`, `write`, `list`, `remove`, `watch`, `open`, `reveal`: plain paths in `~/Jaspers/<plugin id>/`, `plugin:` paths in the plugin's folder, read only |
| `state`       | `state`        | `get(path)`: the app's state, read only, by the paths `useData` takes                                                                            |
| `skills`      | `skills`       | `catalog()`, `activate(name)`, `read(name, path)`: the skills the assistant may load, for the plugin's own model; see [Skills](skills.md#skills-in-a-plugin) |
| `live`        |                | `set(key, value)`: JSON the plugin's views read with `useData('live/<key>')`, held in memory; `delete(key)` takes it away                       |
| `jobs`        |                | `start(key, run)`: work that outlives the call, its `run(signal)` aborted when the process stops or by `abort(key)`; `running()` lists the keys |
| `notify`      |                | `notify(text)`: a line for the user, labelled with the plugin: kept in the inbox, and a system notification while the app is not in front; never shown over the app                            |
| `workspace`   |                | the workspace the call came from, or `null` in `start`                                                                                          |

The table names what there is. What each method takes and answers is in the SDK's types: `BackendContext`, and `Files`, `Jobs`, `Llm`, and the others it is made of, all exported from `@jaspers-ai/sdk`.

## Hooks

From `@jaspers-ai/sdk`:

| Hook                              | What it does                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `useData(source, args)`           | Runs a source, and again whenever `args` change. Returns `{ data, text, loading, error, datasetId, meta, refetch }`.            |
| `useData(path)`                   | Subscribes to a path in the app state, such as `workspaces/<workspaceId>/panels/<id>/state`. `undefined` until the first value. |
| `usePanelState(panel, key, init)` | `[value, set]` for one key of the panel's state. `set` goes through main's schema check.                                        |
| `usePublish(panel, output)`       | Publishes what the view shows. Debounced 100 ms, skipped while unchanged.                                                       |
| `usePublishText(panel, text)`     | Publishes the whole of what the view shows as text, at `panels/<id>/text`, for models to read a part at a time and quote. Start it with a line naming what it is. `null` clears it. Cut past 200,000 characters. A quote that came with a [citation](connections-and-data.md#citations-in-the-chat) can carry its `[^id]` beside it, and the assistant cites it in the chat. |

## Skills helpers

From `@jaspers-ai/sdk`, for a plugin's own model loop:

| Helper | What it does |
| --- | --- |
| `skillsPrompt(skills)` | The catalog for a system prompt: how to load a skill, then each one's name and description. Empty when there are none. |
| `skillTools(names)` | The `activate_skill` and `read_skill_file` tool definitions, their names limited to the ones given. |
| `runSkillTool(ctx.skills, call, turns)` | Answers one of those two calls through the capability, or `null` for any other call. A skill already in `turns` is not sent again. |
| `wrapSkill`, `expandArguments`, `skillLoaded` | The pieces those are made of: the `<skill_content>` wrapping, argument substitution, and the check for a skill already loaded. |

[Skills](skills.md#skills-in-a-plugin) has a whole loop. A plugin's own skills are a `skills/` folder, not a field of `definePlugin`.

## Imports

`@jaspers-ai/sdk`, `react`, `react-dom`, and `zod` come from the app. The plugin's own files, CSS, and npm packages installed in its folder are bundled in. Import the SDK by its root name only: `@jaspers-ai/sdk/define` and `@jaspers-ai/sdk/host` are the app's own entries, and a plugin that imports them bundles a second copy of the SDK.

## Inside a view

There is no network and no `window.app`; everything goes through the hooks and sources. `useBridge().openLink(url)` opens an https link in the browser and `useBridge().copyText(text)` writes the clipboard, since the view's sandboxed frame can do neither. A `<form>` never submits in that frame, so read Enter in `onKeyDown`. Errors thrown while mounting are shown in the frame.

## Theme

The page a view runs in links the app's theme first, so a view's CSS can use its variables and look like the app in light and in dark. Which set is showing follows Settings > Appearance.

| Variable | For |
| --- | --- |
| `--jaspers-background`, `--jaspers-foreground` | The page and its text |
| `--jaspers-muted`, `--jaspers-muted-foreground` | A quiet fill (a hovered row, a code block) and secondary text |
| `--jaspers-border` | Rules and outlines |
| `--jaspers-primary`, `--jaspers-primary-foreground` | The strong fill and the text on it: a pressed tab, a chosen option |
| `--jaspers-destructive` | Errors, and anything that deletes |
| `--jaspers-positive`, `--jaspers-negative` | A number's sign: a gain and a loss |
| `--jaspers-font-sans`, `--jaspers-font-mono`, `--jaspers-font-prose` | The interface, figures and code, and reading text |

The page's body already uses the background, foreground, and sans face. Give each variable a fallback, as in `color: var(--jaspers-muted-foreground, #737373)`, so the view still looks right in an app from before the theme. A color of the view's own gets its dark value under `@media (prefers-color-scheme: dark)`. Code that needs to know, such as a widget with a theme option, reads `matchMedia('(prefers-color-scheme: dark)')` and listens for its `change`.

## Connections and secrets

A plugin declares the MCP servers it reaches and the keys they need:

```ts
export default definePlugin({
  id: "my-plugin",
  secrets: { token: { label: "My server API key" } },
  connections: {
    server: defineConnection({
      url: "https://example.com/mcp", // or command: ["node", "server.js"] for a stdio server, run in the plugin's folder
      auth: "bearer", // none, bearer, or oauth
      headers: { Authorization: "Bearer ${secret:token}" }, // single quotes or double: never a template literal
      tools: ["search", "fetch"], // optional: offer only these of the server's tools
    }),
  },
  sources: { search: defineSource({ mcp: "server", tool: "search" }) },
});
```

A source's `mcp` names one of the plugin's own connections, or another plugin's as `<plugin>/<name>`. The first time something needs the key, the assistant asks for it in a secure field; Settings > Plugins takes it too. The key is sealed with the OS keychain and never reaches the plugin, the assistant, or the logs. An `oauth` connection to a server that signs its users in through Jaspers (its protected resource metadata names `https://account.jsprai.com`) takes the app's sign-in with Jaspers as its bearer, with nothing for the plugin to declare; any other `oauth` server is authorized from Settings under Plugins.

## Debugging

`plugins.<id>` in the app state holds the build status and first error, and the assistant's prompt carries the same line. Main's terminal prints `plugins: watchlist ready (v2)` on each build, or the error.
