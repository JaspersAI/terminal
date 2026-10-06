# @jaspers-ai/sdk

What [Jaspers Terminal](https://github.com/JaspersAI) plugins are written against: `definePlugin`, `defineSource`, `defineView`, `defineConnection`, and the hooks a view reaches the app through (`usePanelState`, `usePublish`, `usePublishText`, `useData`).

The app provides this module to every plugin at run time, so a plugin never bundles it. Install it for types and tests:

```sh
npm install --save-dev @jaspers-ai/sdk react zod typescript @types/react
```

```tsx
import { definePlugin, defineView, usePanelState, type PanelRef } from '@jaspers-ai/sdk'
import { z } from 'zod'

function Hello({ panel }: { panel: PanelRef }) {
  const [name] = usePanelState(panel, 'name', 'world')
  return <p>Hello, {name}</p>
}

export default definePlugin({
  id: 'hello',
  views: { hello: defineView(Hello, { title: 'Hello', state: z.object({ name: z.string().optional() }), output: z.object({}) }) },
})
```

A plugin with a model loop of its own loads [skills](https://agentskills.io) the way the app's assistant does: declare `skills`, put the catalog in the system prompt, offer the two skill tools, and answer them with `runSkillTool`:

```ts
import { runSkillTool, skillsPrompt, skillTools } from '@jaspers-ai/sdk'

// in run(args, ctx) or a job, with capabilities: ['llm', 'skills']
const skills = await ctx.skills.catalog()
const system = [base, skillsPrompt(skills)].filter(Boolean).join('\n\n')
const tools = [...mine, ...skillTools(skills.map((s) => s.name))]
// for each tool call the model makes:
const result = (await runSkillTool(ctx.skills, call, turns)) ?? (await runMine(call))
```

Plugins import the package root. `@jaspers-ai/sdk/define` (the definitions without React), `@jaspers-ai/sdk/skills` (the skills helpers alone), and `@jaspers-ai/sdk/host` (the iframe bridge) are for the app itself.

The official plugins are examples: `JaspersAI/plugin-screener-mcp`, `plugin-research`, `plugin-tradingview`, `plugin-fmp`, `plugin-earningscall`, `plugin-markdown`, `plugin-yfinance`.

MIT licensed.
