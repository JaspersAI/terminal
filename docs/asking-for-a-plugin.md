# Asking the assistant for a plugin

When nothing installed does what you ask, the assistant first searches [Jaspers Hub](installing-plugins.md), the library of published plugins. When Hub has one that does it, the assistant names it and installs it when you say so, asking you first with what it downloaded in front of you, and builds one only if you would rather. When Hub has none, or cannot be reached, the assistant can build a plugin for it: a data feed from a service's API, a table or chart of its own, something that writes a document, a connection to an MCP server. Ask for the thing, not the plugin: "chart the 10-year Treasury yield from FRED", "make me a PDF of this memo", "connect me to my firm's research server at this address". The assistant hands the request to its builder, a second model loop with the [SDK documentation](sdk-reference.md) and four [templates](templates/README.md) in front of it, which finds the API's documentation, writes the files, and asks you before anything of them runs.

## What you are asked

One question, in the answer box, before the plugin lands:

```
Build the plugin fred? It is written to ~/Jaspers/plugins/fred and runs in the app. The app holds it to what is listed below, and the builder may go on writing its files after you approve.

fred — FRED economic series, for charts of any series id

Reaches:       api.stlouisfed.org
Capabilities:  none
Keys asked:    apikey (FRED API key)
Connections:   none
Packages:      none
Frames:        none
Files:         plugin.tsx 2.1 KB · package.json 0.2 KB

--- plugin.tsx ---
…
```

The lines above the files are the plugin's **envelope**: every host its code may fetch, every capability it may use, every key it may ask you for, every server it may connect to, every npm package it brings in. The files follow, whole, in the scrolling box. For all but the smallest plugin they are its shell: each file with its sources and functions named and nothing behind them yet. The builder fills them in after your yes, and the app holds every line of that to the envelope. **Build it** writes the folder and the app builds it; **No**, closing the question, or leaving it are all no, and the assistant stops.

A built plugin reaches MCP servers over https only, never by running a command of its own, and its code can import only its own files and the packages in its folder.

The envelope is enforced, not just shown. The app holds every build of that plugin to it: an edit that fetches a new host, declares a new capability, or adds a package fails to build until you are asked again, and that question shows only what is new. Edits within the envelope rebuild without asking, which is what lets the builder fix its mistakes.

A key the plugin asks for is never typed into the chat or written into the code: the plugin declares it, and the first time a source needs it the app opens its secure field, as it does for any plugin.

## What the builder does

It reads how to reach the service: a plugin it built before for the same service when there is one (it can read the files of the plugins it built, never those of your own or installed ones), and the service's API documentation (with `search_web` when a search provider is set in **Settings > Language model > Web search**, otherwise from addresses it knows or asks you for). It writes the plugin's shell from the template that fits, installs it with your approval, and then fills it in a piece at a time: the app builds each piece as it is written, the builder reads the errors and fixes them, runs each source with a real argument once it is whole, and reports back to the assistant what the plugin now offers. The assistant then does what you asked: places the view, runs the source. The status line shows each step as it happens, the builder's as well as the assistant's. A step that takes a while to write, the request handed to the builder or one of the plugin's files, says so and for how long, and so does each package it fetches and the wait for the app to build the plugin. Stop stops it.

A build that ends before the plugin is finished keeps what it wrote and where it was, whatever ended it: Stop, the model's provider failing, the app closing, your No. Ask again and it carries on from there rather than starting over. Since the plugin is installed as a shell, one left unfinished is already in **Settings > Plugins**, and a source of it that is not written yet says so when it is run.

A plugin that needs a package (a PDF library, a spreadsheet writer) gets it from the npm registry, fetched by the app itself: nothing to install on your computer. No package's install script ever runs, and packages with platform binaries are left out.

## Afterwards

The plugin is an ordinary folder in `~/Jaspers/plugins/<id>`, with a `.jaspers-build.json` beside its files recording what you approved. **Settings > Plugins** shows it as built by the assistant, with its purpose and the date, and **Remove** puts the folder in the Trash. Edit it by hand like any plugin; ask the assistant to change it and the builder works in the same folder. A plugin you wrote or installed is never edited by the builder.
