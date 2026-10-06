# Writing a plugin

A plugin adds views and data sources to Jaspers Terminal.

- A **view** is a React component that lives in a grid element. The assistant places it, changes what it shows by writing its state, and reads back what it shows.
- A **source** is a named data call, usually one tool on an MCP server. Views and the assistant both run sources.

[`plugin-screener-mcp`](https://github.com/JaspersAI/plugin-screener-mcp) is the full example, every one of [Jaspers' own plugins](../README.md#plugins-on-jaspers-hub) is a template for one, and [`docs/templates/`](templates/README.md) holds four small ones to copy: a feed, a feed with a table, a document producer, and a connection. [How it works](architecture.md#how-a-plugin-connects-to-the-app) explains how a plugin is wired into the app. This page builds a smaller one from scratch. When it is done, see [Publishing a plugin](publishing-a-plugin.md) to share it and the [SDK reference](sdk-reference.md) for everything a plugin can declare.

The plugin here is a watchlist, with each part a plugin can have: its own MCP server, a connection that runs it, a source on that connection, and a view the assistant places and drives. It needs nothing else installed. The server answers from a few sample rows; swapping in a real data API is the last step.

A plugin is a folder in `~/Jaspers/plugins/`, named for the plugin's id. The app picks it up while running and rebuilds it on every save.

```
~/Jaspers/plugins/watchlist/
  plugin.tsx          what the plugin offers
  server.ts           its MCP server
  WatchlistView.tsx   the view
  styles.css
  package.json  tsconfig.json
```

Set the folder up:

```sh
mkdir -p ~/Jaspers/plugins/watchlist && cd ~/Jaspers/plugins/watchlist
npm init -y
npm pkg set type=module
npm install @modelcontextprotocol/sdk zod
npm install --save-dev @jaspers-ai/sdk react typescript @types/react @types/node
```

`npm init` writes `"type": "commonjs"`; `module` is what the files below and Node's test runner expect. The server runs on its own, so the packages it imports are `dependencies`. The app provides `@jaspers-ai/sdk`, `react`, and `zod` to the plugin and its views, so for those the installs are for types.

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "strict": true,
    "noUncheckedSideEffectImports": false,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "skipLibCheck": true
  },
  "exclude": ["node_modules", "build"]
}
```

`noUncheckedSideEffectImports` is off because TypeScript 7 otherwise refuses `import "./styles.css"`, which only the app's build understands: it serves the CSS beside the view.

## The server

`server.ts` is an MCP server with one tool, written with the MCP SDK:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Sample rows, so the plugin works with nothing else set up. A real server calls a data API here.
const COMPANIES = [
  { ticker: "AAPL", name: "Apple", price: 231.4, change: 0.012 },
  { ticker: "MSFT", name: "Microsoft", price: 498.2, change: -0.004 },
  { ticker: "NVDA", name: "Nvidia", price: 176.9, change: 0.021 },
  { ticker: "AMZN", name: "Amazon", price: 219.8, change: 0.003 },
  { ticker: "GOOGL", name: "Alphabet", price: 203.5, change: -0.009 },
];

const server = new McpServer({ name: "watchlist", version: "1.0.0" });

server.registerTool(
  "quotes",
  {
    description: "Quotes for ticker symbols: name, price, and the day's change as a fraction.",
    inputSchema: {
      tickers: z.array(z.string()).max(50).describe("Ticker symbols, like AAPL."),
    },
  },
  async ({ tickers }) => {
    const wanted = new Set(tickers.map((ticker) => ticker.toUpperCase()));
    const rows = COMPANIES.filter((company) => wanted.has(company.ticker));
    return {
      // What the assistant reads.
      content: [
        {
          type: "text",
          text: rows.map((r) => `${r.ticker} ${r.name}: ${r.price}`).join("\n") || "No matches.",
        },
      ],
      // What views read: the app keeps the array under `rows` as the run's rows.
      structuredContent: { rows },
    };
  },
);

await server.connect(new StdioServerTransport());
```

- A tool answers with `content`, the text the assistant reads, and can add `structuredContent`. An array under `rows` (or `items`, `results`, `data`, `companies`), or an array on its own, becomes the run's rows, which views read.
- The input schema is what the assistant is told the tool takes, and what the view passes.
- `node server.ts` runs it by hand; it speaks JSON-RPC on stdin and stdout.

## The plugin

`plugin.tsx` declares what the plugin offers:

```tsx
import { defineConnection, definePlugin, defineSource, defineView } from "@jaspers-ai/sdk";
import { z } from "zod";
import { WatchlistView } from "./WatchlistView";

// The server beside this file, which the app starts over stdio. `node` is the app's own Node, and
// it runs TypeScript as is.
const server = defineConnection({ command: ["node", "server.ts"] });

// One tool on that connection. Its parameters are the tool's own input schema.
const quotes = defineSource({ mcp: "server", tool: "quotes" });

export default definePlugin({
  id: "watchlist",
  connections: { server },
  sources: { quotes },
  views: {
    watchlist: defineView(WatchlistView, {
      title: "Watchlist",
      // What the assistant may set. Every write is checked against this, whole.
      state: z.object({ tickers: z.array(z.string()).max(50).default([]) }),
      // What the view publishes about itself, for the assistant to read.
      output: z.object({ tickers: z.array(z.string()), count: z.number() }),
      instructions:
        "A list of companies to watch. Set state.tickers to the ticker symbols, up to 50. output.tickers is what the list shows.",
      renders: [quotes],
      summarize: (state, output) =>
        `Watchlist: ${output.count} of ${state.tickers?.length ?? 0} tickers`,
    }),
  },
});
```

- `server` is a connection: a server over stdio (`command`, run in the plugin's folder) or streamable HTTP (`url`). It registers as `watchlist/server`, and Settings > Plugins shows its status and tools.
- `quotes` registers as the source `watchlist/quotes`. The assistant runs it with `run_source { source: "watchlist/quotes", input: { tickers: ["AAPL"] } }`. Its prompt names the arguments from the server's input schema, and `describe_source` returns the whole schema.
- `state` is the contract for writes. Main checks every write against it.
- `output` is what the view reports about itself, capped at 4 KB of JSON. A view whose content is long text, like a transcript, publishes that whole with `usePublishText` instead, and the assistant reads it by path.
- `instructions` is shown to the assistant while the element is focused.
- `renders` tells the assistant to place this view rather than call `quotes` itself.
- `summarize` is the element's one-line entry in the assistant's grid map. It runs in main on every publish, so keep it cheap and don't assume a key is present.

## The view

`WatchlistView.tsx` is the component:

```tsx
import { useData, usePublish, type PanelRef } from "@jaspers-ai/sdk";
import "./styles.css";

/** A row as the server sends it. Rows reach a view as plain records, so it says what it expects. */
interface Quote {
  ticker: string;
  name: string;
  price: number;
  change: number;
  [field: string]: unknown;
}

// The panel's state arrives a moment after the view mounts. Read it first, so the source's first
// run asks for the right tickers.
export function WatchlistView({ panel }: { panel: PanelRef }) {
  const state = useData(
    `workspaces/${panel.workspaceId}/panels/${panel.id}/state`,
  ) as { tickers?: string[] } | undefined;
  if (state === undefined) return <p className="wl-note">Loading…</p>;
  if (!state.tickers?.length) return <Empty panel={panel} />;
  return <List panel={panel} tickers={state.tickers} />;
}

function Empty({ panel }: { panel: PanelRef }) {
  usePublish(panel, { tickers: [], count: 0 });
  return <p className="wl-note">No tickers yet. Ask for some.</p>;
}

function List({ panel, tickers }: { panel: PanelRef; tickers: string[] }) {
  // Runs again whenever the arguments change by value, so a new tickers list is a new lookup.
  const { data, error } = useData("watchlist/quotes", { tickers });
  const rows = (data ?? []) as Quote[];
  usePublish(panel, {
    tickers: rows.map((row) => row.ticker),
    count: rows.length,
  });

  if (error) return <p className="wl-note wl-error">{error}</p>;
  if (!data) return <p className="wl-note">Loading…</p>;
  return (
    <table className="wl">
      <thead>
        <tr>
          <th>Ticker</th>
          <th>Name</th>
          <th>Price</th>
          <th>Change</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.ticker}>
            <td>{row.ticker}</td>
            <td>{row.name}</td>
            <td>{row.price.toFixed(2)}</td>
            <td className={row.change < 0 ? "wl-down" : "wl-up"}>
              {(row.change * 100).toFixed(1)}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- A view receives `panel`, its element's ids, and reaches the app only through the hooks.
- State arrives just after the frame mounts. The outer component reads it with `useData(path)` first, so the source's first run already has the tickers.
- `useData("watchlist/quotes", args)` runs the source through main and returns its rows.
- `usePublish` reports what is on screen, for the assistant to read.

`styles.css` is plain CSS, since there is no Tailwind inside the frame. Its colors are the app's [theme](sdk-reference.md#theme), so the view follows light and dark with the app:

```css
.wl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.wl th,
.wl td {
  padding: 4px 8px;
  border-bottom: 1px solid var(--jaspers-border, #e5e5e5);
  text-align: left;
  white-space: nowrap;
}
.wl th {
  color: var(--jaspers-muted-foreground, #737373);
  font-weight: 500;
}
/* Room at the right edge of the last column. */
.wl th:last-child,
.wl td:last-child {
  padding-right: 36px;
}
.wl-up {
  color: var(--jaspers-positive, #15803d);
}
.wl-down {
  color: var(--jaspers-negative, #b91c1c);
}
.wl-note {
  margin: 12px;
  color: var(--jaspers-muted-foreground, #737373);
  font-size: 13px;
}
.wl-error {
  color: var(--jaspers-destructive, #dc2626);
}
```

## Try it

`npx tsc` checks the plugin. With the app running, Settings > Plugins lists `watchlist` as `local · Ready`; pick it to see its `server` connection ready with one tool. Ask the assistant to "put a watchlist with Apple, Microsoft, and Nvidia on the left half".

## Real data and keys

Replace `COMPANIES` with a call to your data API. When the API needs a key, the plugin declares it, and the app hands the value to the server when it starts it; the plugin's own code never holds it:

```tsx
export default definePlugin({
  id: "watchlist",
  secrets: { apikey: { label: "Quotes API key" } },
  connections: {
    server: defineConnection({
      command: ["node", "server.ts"],
      env: { QUOTES_API_KEY: "${secret:apikey}" },
    }),
  },
  // sources and views as above
});
```

`server.ts` reads `process.env.QUOTES_API_KEY`. The first time the connection is needed, the app asks the user for the key in a secure field (Settings > Plugins takes it too), seals it in the OS keychain, and starts the server with it. An existing MCP server over HTTP is a `url` instead of a `command`, with the key in `headers` (see [Connections and secrets](sdk-reference.md#connections-and-secrets)). A plugin can also fetch data itself, without a server, with a function source (see [`defineSource`](sdk-reference.md#definesource)).

## Skills

A plugin can bring [skills](skills.md): a `skills/<name>/SKILL.md` folder beside `plugin.tsx`, named `<plugin>:<name>`. Use one to teach the assistant a workflow across your views and sources, the kind of thing a view's `instructions` cannot say, since those reach the assistant only once the view is focused. A plugin with a model of its own loads skills with the `skills` capability ([Skills in a plugin](skills.md#skills-in-a-plugin)).

## Debugging

`plugins.<id>` in the app state holds the build status and first error, and the assistant's prompt carries the same line. Main's terminal prints `plugins: watchlist ready (v2)` on each build, or the error.
