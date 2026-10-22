# Skills and workflows

Jaspers Terminal provides three mechanisms for reusable instructions and scheduled automation across local, open-weight, and cloud models:

1. **Agent Skills (`SKILL.md`):** Workflow instruction files stored in `~/Jaspers/skills/<name>/SKILL.md` or bundled inside a plugin's `skills/` directory in the [Agent Skills](https://agentskills.io) format.
2. **Scheduled NYSE market-calendar tasks (`market-calendar.ts` & `clock-rule.ts`):** Recurring prompts, `/skill` runs, or direct tool calls scheduled on fixed intervals or local-time clock rules with US equity market trading-day and holiday checks.
3. **SQLite delta watches (`delta.ts` & `watched`):** Scheduled source checks (`call` + `speak: "changed"`) that poll data sources and diff rows in `~/Jaspers/data/jaspers.db` on schedule, invoking the language model only when rows are added or removed.

---

## Agent Skills (`SKILL.md`)

A skill is written know-how the assistant picks up when a request calls for it: how you like a DCF laid out, what a morning brief covers, which views a credit review opens. Jaspers uses the [Agent Skills](https://agentskills.io) format, so a skill written for Claude Code, Codex, or another client works here, and one written here works there.

A skill is a folder with a `SKILL.md`: YAML frontmatter that names it and says when to use it, then instructions in Markdown. Other files beside it (references, templates) are read when the instructions point at them.

```markdown
---
name: morning-brief
description: A morning brief across the watchlist. Use when the user asks for a brief, a morning update, or what moved overnight.
argument-hint: [tickers]
---

# Morning brief

1. Place a watchlist with $ARGUMENTS, or the tickers on screen if none are given.
2. Put the biggest movers' news beside it.
3. Write a five-line summary in a document: what moved, why, what to watch today.
```

## How the assistant uses them

The assistant's prompt lists every skill's name and description, and nothing more, until one fits a request. Then it loads that skill's instructions into the conversation and follows them; a skill stays loaded for the next few requests, and the assistant loads it again when a later one needs it. The assistant has only the description to go on, so write it with the words a request would use.

Type `/name` in the text field to load a skill yourself, with what it works on after it: `/morning-brief AAPL MSFT`. A menu lists the skills as you type; Tab picks one. A scheduled task whose instructions start with `/name` loads the skill at every run.

Settings > Skills lists every skill; pick one to open it, with its On/Off switch. A skill that is off reads `off` in the list and is hidden from the assistant and the menu.

## Writing one

Settings > Skills > **Add a skill** > **New skill** asks for a name (lower-case letters, digits, and single hyphens) and opens the new `SKILL.md` in the editor. Its description starts empty, and the assistant does not see the skill until you write one. Save with Cmd+S. **New file** adds a file beside it, like `references/wacc.md`, which the instructions can name by that path.

Or ask the assistant: "make a skill for my morning brief: the watchlist, then the biggest movers' news, then five lines on what to watch". It drafts the skill and shows you the whole `SKILL.md` before anything is written. **Write it** saves it as a skill of your own, to edit like any other. **No** leaves nothing behind, and an answer typed instead, like "skip the news", goes back to the assistant to draft again. The assistant writes new skills only, never over one that exists, and never from a scheduled task.

Skills live in `~/Jaspers/skills/<name>/`, and the app picks up changes there as they are saved.

### Frontmatter

| Field | |
| --- | --- |
| `name` | Required. It should match the folder name, which is what the skill is called here. |
| `description` | Required, up to 1,024 characters. What it does and when to use it. |
| `when_to_use` | Appended to the description. |
| `argument-hint` | Shown in the `/` menu, like `[ticker]`. |
| `arguments` | Names for `$name` substitution, in order: `arguments: [ticker, peer]`. |
| `disable-model-invocation` | `true`: only `/name` loads it. The assistant never loads it on its own; once you have typed `/name`, it may read the skill's files and schedule a task that starts with `/name`. |
| `user-invocable` | `false`: the assistant may load it; `/name` does not. |
| `license`, `compatibility`, `metadata` | Shown, not acted on. `metadata.version` is shown as an installed skill's version. |
| `allowed-tools` | Shown, not enforced: Jaspers has no permission system to pre-approve anything. |

Other fields (`context`, `model`, `hooks`, `paths`, …) are ignored, and Settings says so.

### Arguments

`$ARGUMENTS` is everything after `/name` (or what the assistant passes), and `$ARGUMENTS[0]` its first word; quotes group words. A skill that declares `arguments` also gets `$0` to `$9` and `$name`. `$500`, `$5.2`, `$5,000`, `$5B`, and `$5%` are never read as arguments, and a skill that declares no `arguments` keeps `$5 billion` as written. Where a position could be meant, `\$` writes a dollar sign. Arguments no placeholder took are added at the end.

### What Jaspers does not do

Jaspers runs no code from a skill. Scripts are listed for the assistant to read, not run, and Claude Code's `` !`command` `` lines are replaced with a note. A skill runs in the conversation that loaded it, never in a separate agent.

## Installing

Settings > Skills > **Add a skill** installs from:

- **GitHub**: a repo (`https://github.com/owner/repo`), a folder in one (`…/tree/main/skills/pdf`), or a `SKILL.md` (`…/blob/main/skills/pdf/SKILL.md`). No release is needed; the app fetches the branch.
- **An upload**: **Upload…**, or drop a file on the pane: a `.zip`, a `.skill` (Claude.ai's export), a `.tar.gz`, or a single `SKILL.md`.

The app finds every `SKILL.md` folder in what it fetched and shows each one: its name, description, files, whether it has scripts, and its `SKILL.md` to read. Nothing is installed until you pick skills and press **Install**. When a repo holds several, none is picked for you.

You can also ask the assistant to install skills from a GitHub link. It fetches them the same way, then asks you in the conversation, with each skill's `SKILL.md` to read; nothing is installed until you press **Install**, and a repo with several installs only the ones you asked for.

**A skill's instructions go into the assistant's context and steer what it does with your plugins, views, and keys.** Install only skills you trust.

An installed skill is read only, since **Update** would replace your edits. **Duplicate** makes a copy of any skill that is yours to edit. **Remove** and **Delete** move a skill's folder to the Trash. A skill you wrote is never replaced by an install of the same name.

## Skills in a plugin

A plugin brings skills in a `skills/` folder beside `plugin.tsx`, one folder per skill:

```
watchlist/
  plugin.tsx
  skills/
    earnings-review/
      SKILL.md
```

They are named `<plugin>:<name>` (`/watchlist:earnings-review`), reload as they are saved without rebuilding the plugin, and leave with it. Ship the `skills/` folder in the plugin's archive. A plugin's skills are read only in Settings; Duplicate copies one to edit.

A plugin with its own model loop, like the research plugin's analysts, loads skills the same way the assistant does. Declare the capability and use the SDK's helpers:

```ts
import { definePlugin, defineSource, runSkillTool, skillsPrompt, skillTools, type ToolResult, type Turn } from "@jaspers-ai/sdk";
import { z } from "zod";

export default definePlugin({
  id: "analyst",
  capabilities: ["llm", "skills"],
  sources: {
    ask: defineSource({
      description: "Ask the analyst",
      input: z.object({ question: z.string() }),
      run: async (args, ctx) => {
        const skills = await ctx.skills.catalog();
        const system = ["You are an analyst.", skillsPrompt(skills)].filter(Boolean).join("\n\n");
        const tools = skillTools(skills.map((s) => s.name));
        const turns: Turn[] = [{ role: "user", text: (args as { question: string }).question }];
        for (let round = 0; round < 20; round++) {
          const reply = await ctx.llm.complete({ system, turns, tools });
          turns.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls, raw: reply.raw });
          if (reply.toolCalls.length === 0) return reply.text;
          const results: ToolResult[] = [];
          for (const call of reply.toolCalls) {
            results.push((await runSkillTool(ctx.skills, call, turns)) ?? { callId: call.id, output: "Unknown tool.", isError: true });
          }
          turns.push({ role: "tool", results });
        }
        return "Stopped after 20 rounds.";
      },
    }),
  },
});
```

`ctx.skills.catalog({ names })` narrows the list; `ctx.skills.activate(name)` and `ctx.skills.read(name, path)` are what the two tools call. A plugin gets the skills the assistant may load, never one that is off or one only `/name` loads.

---

## Scheduled NYSE market-calendar tasks (`market-calendar.ts` & `clock-rule.ts`)

Ask the assistant in plain words to run work on a schedule — *"every morning at 9:35am ET when the market is open, run `/morning-brief`"* or *"refresh my watchlist every 5 minutes"* — or manage tasks in **Settings > Tasks**.

The scheduler (`src/main/tasks/tasks.ts` paired with `src/shared/tasks/tasks.ts`, `src/shared/tasks/clock-rule.ts`, and `src/shared/tasks/market-calendar.ts`) supports up to `TASKS_MAX = 50` pending tasks per workspace across three timing modes:

- **Local-time clock rules (`at: ClockRule`):** A rule `{ days, time, timeZone, marketOnly }` resolves each run in its IANA time zone (such as `America/New_York`) across daylight-saving transitions (`nextByRule` in `src/shared/tasks/clock-rule.ts`), so `09:30` stays `09:30` year-round. Malformed clock rules fail validation (`checkRule`) rather than silently becoming daily schedules.
- **Offline NYSE / Nasdaq trading-day calendar (`marketOnly: true`):** When `marketOnly` is set, `isTradingDay` (`src/shared/tasks/market-calendar.ts`, with built-in holiday tables through `CALENDAR_THROUGH = '2028-12-31'`) skips weekends and full US equity market holidays without making any network request.
- **Intervals (`every`) and one-shots (`executeAt`):** Direct tool calls (`call`) can repeat as often as every 1 second (`EVERY_MIN_CALL_MS = 1_000`), while assistant instruction runs (`instructions`) repeat at 60 seconds or longer (`EVERY_MIN_ASK_MS = 60_000`).
- **Skills, model pinning, and Pro mode scripts:**
  - Starting `instructions` with `/name` (for example `/morning-brief AAPL MSFT`) loads that Agent Skill on every scheduled run.
  - Each task can pin its own `model` (such as a local Ollama model or a smaller cloud model; see [Getting started](getting-started.md)) and counts against the daily task token budget in **Settings > Tasks**.
  - Tasks that need shell automation can attach up to `TASK_COMMANDS_MAX = 5` pre-approved [Pro mode](pro-mode.md) scripts (`commands`), approved once when the task is scheduled.
- **Refreshes of a closed loop's tiles:** A `refresh_element` task whose tile is in a loop you closed skips its runs quietly instead of failing every interval (`closedHolding` in `src/shared/loops/closed.ts`), and refreshes again once the loop is reopened from **View loops**, which brings its tiles back under the same ids.

## SQLite delta watches (`speak: "changed"` & `delta.ts`)

Scheduled checks that poll for new filings, feed updates, or releases often return identical rows across consecutive ticks.

When a task is scheduled with both a direct tool `call` (such as `run_source` or `refresh_element`) and `speak: "changed"` (`isWatch` in `src/shared/tasks/tasks.ts`), the scheduler runs it as a SQLite delta watch:

1. **Direct source poll:** At each scheduled tick, `execute` (`src/main/tasks/tasks.ts`) invokes `call` directly without calling any language model.
2. **SQLite observation history (`watched` in `~/Jaspers/data/jaspers.db`):** The store (`watch` in `src/store/db.ts`) records the observation (`task`, `at`, SHA-256 `hash`, `text`) in the `watched` table, trimming older entries past the latest 20 observations per task (`trimWatched`), and returns the previous observation.
3. **Order-independent row diffing (`src/shared/tasks/delta.ts`):** `delta(before, after)` strips volatile run metadata (`datasetId`, `resultId`, `rowCount` via `RUN_METADATA`), extracts structured JSON rows (`extractRows` + `stableStringify`), and compares the previous and current results as a multiset (bag of lines, up to `LINES_MAX = 40` added/removed lines and `DELTA_MAX = 4000` characters). If a data source re-orders the same rows between calls, `delta` reports `changed: false`.
4. **Wake on change only:**
   - When `changed` is `false` (and on the initial baseline run), the tick finishes with `result: "unchanged"` without invoking the language model or raising a notification.
   - When `changed` is `true`, the scheduler invokes the task's model with `instructions` plus the `New` and `Gone` rows (`found.text`), posts the assistant's reply into the workspace conversation, and records a notification.
