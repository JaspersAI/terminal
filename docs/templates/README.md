# Plugin templates

Four whole plugins, one per kind, for copying: the assistant starts from these when it [builds a plugin](../asking-for-a-plugin.md), and so can you. Copy a folder into `~/Jaspers/plugins/<id>`, rename the folder and the `id` in `plugin.tsx` and `package.json` to match, and the app builds it.

| Folder | What it is |
| --- | --- |
| `feed/` | One function source that fetches a JSON API without a key and answers rows. The built-in table, chart, and metric views show them. |
| `feed-table/` | A source with a key (`${secret:apikey}`) and a table view of its own. |
| `document/` | A source with the `files` capability that writes a report into the plugin's folder and opens it. |
| `connection/` | An MCP server over HTTP with a key in a header, and one of its tools as a source. |

Each builds with the app's own pipeline: `npm test` bundles and evaluates every folder here.
