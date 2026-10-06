# Installing plugins

Settings > Plugins > **Add a plugin** installs a plugin someone else wrote: press **Install** on one the directory lists, which is [Jaspers Hub](https://hub.jsprai.com)'s, or under **From a link** paste one of these, or press **Choose file…**:

- an item's page on Jaspers Hub (`https://hub.jsprai.com/<handle>/<name>`), or its archive on Hub's API, which installs as the directory's Install does;
- a GitHub repo (`https://github.com/owner/repo`): the app takes the first `.zip` or `.tar.gz` attached to its latest release;
- an https link to a `.zip` or `.tar.gz`;
- a file on your computer.

A repo's latest release is looked up over GitHub's API, which allows a network that signs in with nothing only 60 lookups an hour — an office behind one address can use them up. When the API refuses for that reason, the app finds the same release without it: `/releases/latest` redirects to the page of the tag it is of, and that tag's source archive (the **Source code (tar.gz)** of every release page, served by codeload, which has no such limit) is installed instead of the attached archive. It holds the same `plugin.tsx` and `package.json`, along with whatever else the repo keeps at that tag, so the plugin is the one the release is of. When GitHub refuses for any other reason — no release, or a private repo — the error says so, and an archive link pasted under **From a link** never touches the API at all.

The app downloads and unpacks the archive, refusing anything that could land outside its folder, and reads the plugin's `package.json`. Nothing of the plugin runs yet. It then shows the plugin's name, version, where it came from, and the archive's SHA-256, and asks.

**A plugin runs code on your computer with your permissions.** Jaspers runs a plugin's code in its own process to contain crashes, not to stop harmful code. Install only plugins from people you trust.

Once installed, the plugin lands in `~/Jaspers/plugins/<id>` and loads like any other. Pick it in Settings > Plugins to see where it came from, with **Update** (from Hub, a repo, or a link; every new version asks again) and **Remove** (the folder goes to the Trash and its keys are deleted; its own files in `~/Jaspers/<id>` stay). The app never overwrites or removes a folder you put in `~/Jaspers/plugins` yourself.

You can also ask the assistant: "install github.com/owner/repo", or "install jaspers/screener-mcp" for one Jaspers Hub lists. It goes through the same download and checks, then asks you in the conversation, with the plugin's name, version, where it came from, and the archive's SHA-256. Nothing of it runs until you press **Install**; **Cancel**, closing the question, or stopping the run means no. A scheduled task's run cannot install anything.

## From Jaspers Hub

The directory, in setup's last step and in Settings > Plugins, lists what Jaspers Hub lists: the plugins Hub features, in Hub's order, then every other plugin there, most starred first, with **More** for the next page. Settings also searches Hub. Each entry shows who published it, marked official when it is Jaspers' own, the version Hub shows, and whether Hub reviewed that version. When Hub cannot be reached, each part of the list says so, with **Retry**, and **From a link** still works.

An install from Hub downloads the version Hub shows and refuses it, before anything is unpacked, unless its SHA-256 is the one Hub sent with it. Its `package.json` has to name the item and the version Hub served. The question then also says who published it, whether Hub reviewed this version, and links its page on Hub. An entry in the directory reads **Update** when the plugin of its name was installed from that very item and Hub shows another version.

Signing in with Jaspers during setup installs the Jaspers Screener and Jaspers Research from Hub without asking, one after the other, since the sign-in says they come with it. It does so only for those two (`jaspers/screener-mcp` and `jaspers/research`), each only as Jaspers' own, in a version Hub reviewed, with the hash Hub sent, and only when no plugin of its name is installed yet, from Hub or anywhere else. A failure is a notice that names the plugin, which then installs from the list like any other, and the other one still installs. Signing in later, from Settings, installs nothing.

Jaspers' own plugins are on Hub as `jaspers`, and each also installs from its GitHub repo (see [Plugins on Jaspers Hub](../README.md#plugins-on-jaspers-hub)).
