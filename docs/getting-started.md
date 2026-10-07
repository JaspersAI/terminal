# Getting started

Download Jaspers Terminal for macOS or Windows at [jsprai.com/terminal](https://jsprai.com/terminal/), or run it from source as below and package your own copy (see [Packaging](#packaging)).

## Requirements

- **Node 24** (`nvm use` reads `.nvmrc`)
- **macOS** is where it is developed. Windows is packaged by the release workflow and run by testers, not developed on.

## Run it

```sh
git clone https://github.com/JaspersAI/terminal.git
cd terminal
npm install
npm run dev
```

The first run downloads the Electron binary.

## First launch

On first launch, sign in with Jaspers if you have an account: it opens your browser, and one sign-in sets up the language model, voice, and web search, so setup goes on to plugins, where the Jaspers Screener and Jaspers Research are already installing from Jaspers Hub; the Screener connects with the same sign-in. Otherwise open Other providers and set up a language model provider (Anthropic, Amazon Bedrock, OpenAI, Google, OpenRouter, Groq, xAI, Ollama, or any OpenAI-compatible endpoint). A voice provider (ElevenLabs, OpenAI, Deepgram, or Cartesia) is optional. API keys are sealed with your OS keychain. Change either later in Settings, which is in the menu bar: under Jaspers Terminal on a Mac (⌘,), under File on Windows (Ctrl+,). While you are signed in with Jaspers, Account, at the head of Settings' list, opens your account's page in the browser: what the account has used and what is left, the apps connected to it, and its password. Picking Jaspers as a provider in Settings > LLM while signed out leads to signing in, and the provider's Account row says who is signed in. Signing in from anywhere in Settings sets Jaspers up only where you have no provider yet, and never replaces one you chose. Jaspers follows your computer's light or dark mode; Settings > Appearance fixes it to one.

The Amazon Bedrock provider serves the same Messages API as Anthropic, so it needs only three things: the base URL `https://bedrock-mantle.<region>.api.aws/anthropic` with the region edited in place, an `anthropic.` model id such as the default `anthropic.claude-opus-4-8`, and a Bedrock API key from the AWS console under Bedrock > API keys. A model your account has no access to is answered with a 403 naming it.

Bedrock can also be the web search provider (Settings > Language model > Web search), on the same key. It is Bedrock's Web Search tool, which runs on the Responses API with an OpenAI model: the base URL is `https://bedrock-mantle.<region>.api.aws/openai/v1`, in a US region, and the model is one that has the tool, such as the default `openai.gpt-5.6-luna`. The key's IAM identity needs `bedrock-websearch:InvokeSearch` as well as access to that model; without it the search is answered with a 401 saying so. A search takes twelve to eighteen seconds, since a model runs it and writes out what it found, and it stays on Amazon's own index of the web.

The last step is the plugin directory Settings > Plugins shows, which is [Jaspers Hub](https://hub.jsprai.com)'s: the plugins Hub features first, in its order, then every other plugin on Hub, most starred first, with More for the next page. Each shows who published it, marked official when it is Jaspers' own, its version, and whether Hub reviewed it. Nothing installs until you press its Install, which downloads it from Hub, checks that it is the archive Hub described, and asks first. The one exception is the Jaspers Screener, which signing in with Jaspers installs by itself, as its box says, when Hub has Jaspers' own reviewed version and you have no Screener yet; the step shows it installing. Finish with none installed is fine. When Hub cannot be reached, the step says so, with Retry, and installing from a link still works. Install more later in Settings > Plugins, which also searches Hub, or [write your own](writing-a-plugin.md).

Finish, answer the question about [Eye](eye.md), and the assistant welcomes you in the chat: who it is, what the terminal is, and one example of something to ask for with what you installed, a few seconds apart, with the field to answer in under them. The example is the model's, written from your plugins, so it costs one short request. The welcome stays in the conversation, so "do that" works as a first reply.

## Several screens

A workspace is one grid per window, all the same size, with elements dragged between them, so using more than one screen is one window per screen.

- **Screens > Use All Screens** puts one window of the current workspace on every display, each filling that display. The window you are in keeps the screen it is on; the others are opened or moved onto the screens still free, up to eight windows in all. Windows already open are moved, never opened twice, so choosing it again changes nothing. With more windows open than screens, the ones left over stay open where they are and a notice names them: close them yourself, or use Back to One Screen, which moves what is in them into the main window first. The chat stays in the main window; the other windows show the grid.
- **Screens > Back to One Screen** brings everything into the main window: the other windows' elements move into its grid, keeping their size where it fits, and those windows close. If something cannot be moved it says so and nothing changes — an element that does not fit in the main grid, or a window with cells typed into it, since moving an element carries the element and not what is written in the cells. Clear those cells, or make room in the main window, and choose it again.
- **The assistant can do both**: "spread this across both my screens", "put it all back on one screen".
- **Screens coming and going.** Unplug a display, or change its resolution or arrangement, and a window left on no screen comes back onto the main window's screen at the size it had, out of full screen if it was. Plugging one in changes nothing by itself: ask for all the screens again when you want the new one filled.

## Start over

To become a new user again, quit the app and delete its data folder:

```sh
rm -rf ~/Library/Application\ Support/jaspers-terminal
```

## Commands

| Command             | What it does                                                   |
| ------------------- | -------------------------------------------------------------- |
| `npm run dev`       | Dev server with hot reload                                     |
| `npm run build`     | Build into `out/`, including the runtime plugin views load     |
| `npm start`         | Run the existing build (`npm run build` first)                                  |
| `npm run typecheck` | Type-check with `tsc`; the build strips types without checking |
| `npm run format` | Format source code with Prettier |
| `npm run format:check` | Check source formatting |
| `npm test`          | Unit tests for the pure code in `src/`                         |
| `npm run dist`      | Build, then package a macOS app into `dist/`                   |
| `npm run sdk:build` | Build `@jaspers-ai/sdk` for publishing, into `packages/sdk/dist` |

## Packaging

`npm run dist` packages the app with electron-builder (`electron-builder.yml`) for the platform it runs on. On a Mac: `dist/mac-arm64/Jaspers Terminal.app`, a `.dmg`, and a `.zip`, for Apple Silicon only, which the release workflow signs with Jaspers Inc.'s Developer ID and has Apple notarize (see [Development](development.md#releasing-and-updates)); a build on your own Mac, without that certificate in the keychain, is not signed, and opens there but on no other Mac. On Windows: a one-click installer, `dist/Jaspers-Terminal-Setup-<version>.exe`, which the release workflow builds and signs (see [Development](development.md#releasing-and-updates)); a build on your own machine fails to sign without its credentials.

## Updates

Jaspers checks for a newer version after it starts and every few hours, downloads it in the background, and installs it when you quit. It never restarts on its own, since a task may be running: a notice says an update is ready, and the tray menu and Settings > About offer the restart. Settings > About also shows which version you have and checks on demand. A Mac app installed before Jaspers was signed does not update itself: install the new DMG over it once.

Plugins are not part of the package. The ones picked during setup download then; the rest install from Settings > Plugins once the app is running.
