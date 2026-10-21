# Getting started

Download Jaspers Terminal for macOS or Windows at [jsprai.com/terminal](https://jsprai.com/terminal), or run it from source as below and package your own copy (see [Packaging](#packaging)).

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

Jaspers Terminal is built so you can **own your inference**: local and open-weight models are first-class setup options alongside **Jaspers One** (the one-step Jaspers sign-in) and direct cloud API keys. Because the Terminal offloads raw market data and filing prose to a local SQLite database (`~/Jaspers/data/jaspers.db`) and bounds view outputs to 4 KB of structured JSON (see [How it works](architecture.md)), local and open-weight models run reliably without overflowing their context windows.

On first launch, choose how you want to run inference, or change it at any time in **Settings > Language model** (under **Jaspers Terminal** on macOS with `⌘,`, or **File** on Windows with `Ctrl+,`):

### Option 1: Local and open-weight models (Ollama, vLLM, llama.cpp, LM Studio, OpenRouter, Groq)

Open **Other providers** during setup (or **Settings > Language model**) to connect a local inference engine or an open-weight model router:

| Provider | Default Base URL | Default Model | API Key | Best for |
| --- | --- | --- | --- | --- |
| **Ollama** (`ollama`) | `http://localhost:11434/v1` | `llama3.2` | Not required | Zero-configuration local models on macOS or Windows |
| **Custom** (`custom`) | *(enter your server URL)* | *(enter model ID)* | Optional | **vLLM**, **llama.cpp** (`llama-server`), **LM Studio**, or any self-hosted OpenAI-compatible endpoint |
| **OpenRouter** (`openrouter`) | `https://openrouter.ai/api/v1` | `anthropic/claude-opus-5.5` | Required (`sk-or-…`) | Hosted open-weight models (Qwen, DeepSeek, Llama, Mistral) and frontier models under one key |
| **Groq** (`groq`) | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | Required (`gsk_…`) | High-throughput open-weight inference for interactive grid work and scheduled tasks |

- **Ollama:** Install [Ollama](https://ollama.com), pull a tool-capable open-weight model (`ollama pull llama3.2` or `ollama pull qwen2.5-coder:32b`), and select **Ollama**. The base URL `http://localhost:11434/v1` and default model `llama3.2` are pre-filled, and no API key is needed.
- **vLLM:** Start your vLLM server (`vllm serve Qwen/Qwen2.5-Coder-32B-Instruct --enable-auto-tool-choice --tool-call-parser hermes`), pick **Custom**, set the base URL to `http://localhost:8000/v1`, and enter the served model name.
- **llama.cpp (`llama-server`):** Run `llama-server -m model.gguf --port 8080 --jinja`, pick **Custom**, set the base URL to `http://localhost:8080/v1`, and enter the model alias.
- **LM Studio:** Start the local server in LM Studio, pick **Custom**, set the base URL to `http://localhost:1234/v1`, and enter the loaded model identifier.
- **Local voice endpoints:** Voice is optional. In addition to **ElevenLabs** (`https://api.elevenlabs.io`, `scribe_v2`), **OpenAI** (`https://api.openai.com/v1`, `gpt-4o-mini-transcribe`), **Deepgram** (`https://api.deepgram.com/v1`, `nova-3`), and **Cartesia** (`https://api.cartesia.ai`, `ink-whisper`), you can choose **Custom** in **Settings > Voice** to point speech-to-text at any local or self-hosted OpenAI-compatible audio endpoint (default model `whisper-1`, no API key required).

### Option 2: Jaspers One (one-step sign-in)

Sign in with **Jaspers** if you have an account: it opens your browser, and one sign-in sets up the language model (`anthropic/claude-opus-5.5`), voice transcription (`openai/gpt-4o-mini-transcribe`), and web search at once. Setup then advances to plugins, where the **Jaspers Screener** (`jaspers/screener-mcp`, publicly called Jaspers Discover) and **Jaspers Research** (`jaspers/research`) install automatically from [Jaspers Hub](https://hub.jsprai.com); the Screener connects with the same sign-in.

While you are signed in with Jaspers, **Account**, at the head of Settings' list, opens your account's page in the browser: what the account has used and what is left, the apps connected to it, and its password; **Sign out**, under it, signs out of the app. Credits are bought there too: when the account runs out, the request fails saying so, and the account page's address in that message opens it. Picking Jaspers as a provider in **Settings > Language model** while signed out leads to signing in, and the provider's Account row says who is signed in and offers Sign out. Signing in from anywhere in Settings sets Jaspers up only where you have no provider yet, and never replaces one you already chose. Jaspers follows your computer's light or dark mode; **Settings > Appearance** fixes it to one.

### Option 3: Direct cloud provider keys

Under **Other providers** (or **Settings > Language model**), you can also bring your own API keys for cloud providers. API keys are sealed in your OS keychain:

| Provider | Default Base URL | Default Model | Key Prefix |
| --- | --- | --- | --- |
| **Anthropic** (`anthropic`) | `https://api.anthropic.com` | `claude-opus-5` | `sk-ant-` |
| **Amazon Bedrock** (`bedrock`) | `https://bedrock-mantle.us-east-1.api.aws/anthropic` | `anthropic.claude-opus-4-8` | AWS Bedrock key |
| **OpenAI** (`openai`) | `https://api.openai.com/v1` | `gpt-5.4` | `sk-` |
| **Google** (`google`) | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.8-flash` | `AIza` |
| **xAI** (`xai`) | `https://api.x.ai/v1` | `grok-4.6` | `xai-` |

The **Amazon Bedrock** provider serves the same Messages API as Anthropic, so it needs only three things: the base URL `https://bedrock-mantle.<region>.api.aws/anthropic` with the region edited in place, an `anthropic.` model id such as the default `anthropic.claude-opus-4-8`, and a Bedrock API key from the AWS console under **Bedrock > API keys**. A model your account has no access to is answered with a 403 naming it.

Bedrock can also be the web search provider (**Settings > Language model > Web search**), on the same key (or you can use **Brave Search** at `https://api.search.brave.com/res/v1`). Bedrock's Web Search tool runs on the Responses API with an OpenAI model: the base URL is `https://bedrock-mantle.<region>.api.aws/openai/v1`, in a US region, and the model is one that has the tool, such as the default `openai.gpt-5.6-luna`. The key's IAM identity needs `bedrock-websearch:InvokeSearch` as well as access to that model; without it the search is answered with a 401 saying so. A search takes twelve to eighteen seconds, since a model runs it and writes out what it found, and it stays on Amazon's own index of the web.

### Plugins and welcome

The last step of setup is the plugin directory **Settings > Plugins** shows, which is [Jaspers Hub](https://hub.jsprai.com)'s: the plugins Hub features first, in its order, then every other plugin on Hub, most starred first, with **More** for the next page. Each shows who published it, marked official when it is Jaspers' own, its version, and whether Hub reviewed it. Nothing installs until you press its **Install**, which downloads it from Hub, checks that it is the archive Hub described, and asks first. The one exception is the Jaspers Screener and Jaspers Research when signing in with Jaspers during setup, which install by themselves when Hub has Jaspers' own reviewed versions and you do not have them yet; the step shows them installing. Finishing with none installed is fine. When Hub cannot be reached, the step says so, with **Retry**, and installing from a link still works. Install more later in **Settings > Plugins**, which also searches Hub, or [write your own](writing-a-plugin.md).

Finish, answer the question about [Eye](eye.md), and the assistant welcomes you in the chat: who it is, what the terminal is, and one example of something to ask for with what you installed, a few seconds apart, with the field to answer in under them. The example is the model's, written from your plugins, so it costs one short request. The welcome stays in the conversation, so "do that" works as a first reply.

## Pinning local models to workspaces and scheduled tasks

You do not have to run every workflow on the same model. Jaspers Terminal lets you switch models across workspace conversations without losing context and pin specific models to scheduled tasks:

- **Switching models in a workspace with portable history (`portable`):** Each workspace chat and each numbered Grid Loop (`loop_1`, `loop_2`, …) stores its conversation thread in `~/Jaspers/data/jaspers.db` keyed by the active `[providerId, baseUrl, model]`. When you switch from a cloud model to a local Ollama, vLLM, llama.cpp, or LM Studio model in **Settings > Language model** (or by asking the assistant, which asks you to confirm before switching), the thread is converted in place (`portable` in `src/shared/agent/history.ts`): provider-specific replay blocks (such as Anthropic thinking blocks or OpenAI reasoning items) are stripped while every user prompt, assistant message, and tool call is preserved. This lets you use a large cloud or coding model to synthesize a new plugin (`build_plugin`) or lay out a complex workspace, and then switch the workspace to a fast local model for day-to-day updates and grid refinement.
- **Pinning a model to a scheduled task:** Every scheduled task belongs to a workspace and accepts an optional `model` override on the active provider (`schedule_task` / `update_task`). When you ask the assistant to schedule recurring work — for example, *"every weekday at 9:30am on llama3.2, check my watchlist for 5% movers"* or *"every 15 minutes on llama-3.3-70b-versatile, summarize new 8-K filings"* — the task pins that `model` name and runs its background turns on the cheaper or smaller local model while your interactive workspace chat stays on your primary analysis model. Leaving `model` blank uses whichever model the workspace is currently configured with.
- **Zero-token SQLite delta watches:** For high-frequency monitoring on local or cloud setups, tasks can specify a direct source `call` with `speak: "changed"`. The Terminal runs the source on schedule and compares the returned rows against the previous run in SQLite without calling any LLM at all, waking the pinned model only when the data actually changes (see [Skills](skills.md)).

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

Jaspers checks for a newer version after it starts and every few hours, downloads it in the background, and installs it when you quit. It never restarts on its own, since a task may be running: a notice says an update is ready, and Restart to update stays at the right end of the workspace bar until you restart; the tray menu and Settings > About offer it too. Settings > About also shows which version you have and checks on demand. A Mac app that macOS will not update, such as one installed before Jaspers was signed, does not update itself: Settings > About says so and links the current DMG, which you install over it once.

Plugins are not part of the package. The ones picked during setup download then; the rest install from Settings > Plugins once the app is running.
