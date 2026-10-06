# Connections and data

Jaspers reaches data through MCP servers, keeps everything they answer, and shows it without your writing any code.

## Adding a connection

Settings > Connections > Add a connection. It takes:

- **A name.** Lower case letters, digits, and hyphens. The server reads as `name/server`.
- **A URL**, for a server reached over the network (streamable HTTP), **or a command**, for one that runs on this machine. A command is looked up on your own `PATH`, so `uvx`, `npx`, and anything you have installed work; quote a path that has spaces.
- **How it signs in:** nothing, a key, or the browser. A key is asked for on the connection's page and sealed in your OS keychain. The browser is OAuth, and it is for a URL, not a command. A server that signs its users in through Jaspers, as the Jaspers Screener does, uses your sign-in with Jaspers instead of a browser flow of its own: Sign in with Jaspers on the connection's page, and it connects.

What this writes is an ordinary plugin folder, `~/Jaspers/plugins/<name>/plugin.tsx`, with one connection in it. There is nothing else to it: the app builds that folder the way it builds any other, and you can open the file, read it, and edit it. Adding sources and views to it is [writing a plugin](writing-a-plugin.md).

The server's tools go to the assistant, so it can call them, and its data goes to any view.

You can also ask the assistant to add one: give it the server's address or the command its documentation names. It fills in the same form and asks you first, with the address or the whole command in front of you; nothing is written until you press **Add connection**. A key is never typed into the chat: once the connection is added, the assistant opens the secure field for it.

Remove, on a connection's page, moves the folder to the trash. It only offers this for a connection added here: a plugin you wrote yourself is never removed by that button.

## Connections on Jaspers Hub

A server often comes as a plugin someone has written already, with its connection, its sources, and its views. Settings > Plugins lists the ones on [Jaspers Hub](https://hub.jsprai.com) and installs one with the same checks and the same question as any other install (see [Installing plugins](installing-plugins.md)).

A connection added here is a plugin of your own, so its page in Settings > Plugins has **Publish to Hub**, which shares it with everyone who uses the directory once Hub has reviewed it. Its key is not part of what is sent: keys stay sealed on this machine. See [Publishing a plugin](publishing-a-plugin.md).

## Seeing the data

Three built-in views render whatever a source or a query answers, so a server needs no view of its own. Ask for what you want and the assistant places one:

- **Table** — the rows, with sortable columns. The whole table is readable by the assistant, so it can quote a cell back to you without fetching again.
- **Chart** — line, area, bar, horizontal bar, scatter, pie, candlestick, or heatmap, with stacking, a log scale, and a zoom bar for a long series. Each axis can be written plain, grouped, compact (391B), or as a percent; a column of years reads 2015, not 2,015, in charts and tables alike.
- **Metric** — one number, large.

Each takes either a source and its arguments, or SQL over the store.

## A server's own views

Some servers ship a view of their own for a tool's answer: a run as it goes, results laid out to be read. This is the MCP Apps extension, and it works with any connection.

When the assistant calls such a tool, the server's view appears on the grid with the answer in it. It is an element like any other: move it, resize it, maximize it, minimize it, or take it off the grid from its menu. Calling the tool again updates the view that is already there. After a restart it shows the same answer without calling the tool; refreshing it calls again.

The first time a connection would show a view, the element asks. The view is the server's own page, so it runs apart from the app. It can use that server's tools and open https links, and it reaches the network only where the server declared it needs to. It cannot reach your other connections, your keys, or the rest of the app, and it cannot type into the chat for you, download files, or use the camera or microphone. Your answer is kept for that connection, and asked for again if the connection is pointed at another server.

For a server's author:

- A tool names its view with `_meta.ui.resourceUri`, a `ui://` resource of type `text/html;profile=mcp-app`.
- A tool with `_meta.ui.visibility: ["app"]` is the view's alone: the assistant is never offered it.
- The resource's `_meta.ui.csp` says where the page may connect and load from. Each entry is an origin, like `https://api.example.com`; anything else is left out.
- The view is sent the tool's arguments and then its result. It may call the server's tools, open a link, ask for fullscreen, and update the model context, which the assistant reads as the view's text.

## Citations in the chat

A server that has quotes to stand behind can have the assistant cite them. It puts `citations` at the top of a tool result's `structuredContent`, beside whatever else it answers:

```json
{
  "citations": [
    {
      "id": "c7f3a2b1",
      "title": "AAPL 10-K · Item 1A Risk Factors · filed 2025-10-31",
      "url": "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm",
      "quote": "We depend on a single supplier"
    }
  ],
  "results": []
}
```

- `id` and `title` are required. `url` is optional and https only; `quote` is optional, for a source that is a passage rather than a figure. Anything else a citation carries is the server's own and is ignored.
- An id is up to 64 letters, digits, `.`, `_`, `:`, and `-`, starting with a letter or a digit. Give the same quote the same id in every call, a hash of it for one: a workspace keeps the newest citation under each id.
- The ids belong in the text the assistant reads too, beside the quotes they name, since that is where it learns them.

The assistant cites by writing `[^id]` after a claim. It writes the id and never the quote, so what the chat shows is the server's own words: a numbered mark in the reply, and under the reply its sources, each with its title, its quote, and its link. An id no result gave shows as nothing. The sources a reply cites are kept with the conversation, so it reads the same after a restart, and a later reply can cite them again. The marks show in the chat only: in a document the assistant gives the quote with a link to its `url` instead.

A citation counts whoever ran the source, the assistant or a view. A view that shows quotes can publish them as text with `usePublishText`, each with its `[^id]` beside it, and the assistant cites them from there.

## What is kept

Every run of every source is filed in one SQLite file, `~/Jaspers/data/jaspers.db`: which source, what was asked, which workspace asked, when, the rows that came back, whatever the server said in prose, and the error if it failed.

This is what lets the assistant answer a question that spans two providers, or two days: it reads across all of it with SQL, and searches the prose by phrase, so a sentence in a filing pulled last week is findable today.

Nothing expires. Settings > Data shows the file's path, its size, and how much is in it, with a Compact button. The file is yours: open it with `sqlite3`, DuckDB, or pandas while Jaspers is running.

```sh
sqlite3 ~/Jaspers/data/jaspers.db \
  "select source, count(*) runs, max(datetime(fetched_at/1000,'unixepoch')) last from runs group by source"
```

`runs` is one row per call. `run_rows` is what came back, one row per row, with the data as JSON — reach into it with `json_extract(data, '$.field')`. `docs` is a full-text index over what a server said in prose.

Nothing in the store leaves the machine.
