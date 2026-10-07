# Publishing a plugin

## To Jaspers Hub

A plugin of your own, one in `~/Jaspers/plugins` that you wrote or the assistant built for you, publishes from its page in Settings > Plugins: **Publish to Hub**. A skill of your own publishes the same way from its page in Settings > Skills, or by asking the assistant: it shows the skill's name, version, and where it will be listed, and sends it when you press **Publish**. Nothing installed from elsewhere is offered. Publishing needs the sign-in with Jaspers; without it the button signs you in.

The first time, Hub has no handle for you, and the app asks for one: lower-case letters, digits, and hyphens, starting with a letter or a digit, at most 39. It is claimed once, and what you publish is listed under it, at `https://hub.jsprai.com/<handle>/<name>`. A handle someone has, or one Hub keeps back, is refused in Hub's words.

The app packs the folder as a `.tar.gz` with one top folder named for the item. It leaves out anything whose name starts with a dot: `.git`, the app's own records of the folder, a `.env`, `node_modules/.bin`. `node_modules` goes with it, less the packages `package.json` lists only in `devDependencies`: installing never runs npm, so a plugin builds from the packages its archive carries. Hub takes at most 50 MB in one upload. A folder holding a link is refused, so nothing outside it is sent. Hub reads the item's name and version from `package.json`, or from a skill's SKILL.md `name` and `metadata.version`. A version has to sort above every one published before it, so raise it to publish again. Hub takes 20 versions a day from one account.

A new version waits for Hub's review, and the directory lists it once it is approved. **Your Hub items**, under the plugins in Settings > Plugins, shows each item you published, each version's state (pending review, approved, rejected with the reviewer's note, or withdrawn), and where Hub's analysis of it stands.

A plugin that imports only React, React DOM, zod, and `@jaspers-ai/sdk` needs no `node_modules`: the app provides those. Keep them, the type packages, and your tooling in `devDependencies`, and they stay behind when you publish.

## As an archive

An installable plugin is an archive holding one plugin folder, at the top or inside one folder:

```
watchlist/
  plugin.tsx
  package.json
  node_modules/      only if the plugin imports packages the app does not provide
  skills/            only if the plugin brings skills, one folder per skill
```

A plugin's `skills/` folder ships as it is. `package.json` needs `name`, the plugin id (the same as `definePlugin({ id })`), and `version` (`1.0.0`). `description` is shown when someone installs it, and `jaspers.sdk` records the SDK version the plugin was written against (`"jaspers": { "sdk": "0.2.0" }`). Packages the plugin runs with go in `dependencies`; the SDK, `react`, `zod`, and the type packages stay in `devDependencies`.

The app never runs npm, so the archive carries the packages the plugin imports. Build it from a copy, leaving out tests, tooling, and dev dependencies, so your own folder keeps them:

```bash
mkdir -p /tmp/watchlist-release
rsync -a --delete --exclude .git --exclude node_modules --exclude '*.test.ts' --exclude tsconfig.json \
  ~/Jaspers/plugins/watchlist /tmp/watchlist-release/
cd /tmp/watchlist-release/watchlist
npm install --omit=dev --ignore-scripts
cd .. && zip -r watchlist-1.0.0.zip watchlist
```

`--ignore-scripts` keeps a package's install script from running on your machine. (`npm pack` leaves `node_modules` out unless the packages are listed in `bundleDependencies`.) A plugin that imports only `react`, `react-dom`, `zod`, and `@jaspers-ai/sdk` needs no `node_modules` at all.

Attach the archive to a GitHub release, and the repo's link installs it; Update in Settings picks up each new release. The official plugin repos automate this: `scripts/package.mjs` builds `build/<id>-<version>.zip`, and pushing a tag (`npm version patch && git push --follow-tags`) runs a workflow that checks the plugin and attaches the archive.
