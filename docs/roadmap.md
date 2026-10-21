# Roadmap

Features land one at a time, as they are needed. Nothing here is scheduled. These are the capabilities already live in the Terminal and the additions that would matter most next.

## Shipped and live today

- **Custom screeners (live):** Quantitative factor screens and qualitative SEC filing screens ship via **Jaspers Discover** (`jaspers/screener-mcp` on [Jaspers Hub](https://hub.jsprai.com)) and custom SQL/plugin screeners over `~/Jaspers/data/jaspers.db`, paired with NYSE market-calendar scheduled refreshes and zero-token SQLite delta watches ([Skills](skills.md)).
- **Analyst rooms (live):** Concurrent numbered Grid Loops (`loop_1`, `loop_2`, …) and plugin-hosted model loops (`capabilities: ["llm", "skills"]`, such as **Jaspers Research**) run specialized agents side by side on the grid for **valuation, credit, accounting, industry research, risks, and fact-checking**, each with its own conversation thread, views, and [Agent Skills](skills.md#skills-in-a-plugin).
- **Excel export and grid formulas (live):** Empty grid cells evaluate Excel formulas (`NPV`, `IRR`, `PV`, `FV`, `PMT`, `INDEX`, `MATCH`, `VLOOKUP`, `SUMIF`, and arrow-key cell/range pointing) directly on screen, while document-producing plugins (`files` capability, see [`docs/templates/document/`](templates/README.md)) and [Pro mode](pro-mode.md) scripts export structured tables and multi-tab `.xlsx` workbooks to disk.

## Research and data plugins

- **Market data:** real-time prices, options, futures, FX, rates, commodities, short interest.
- **Filings and transcripts:** SEC/foreign filings, earnings-call transcripts, investor presentations, amendments.
- **Consensus data:** analyst estimates, revisions, guidance, surprises, valuation targets.
- **Alternative data:** web traffic, app downloads, job postings, credit-card spend, shipping, satellite data.
- **Insider and institutional ownership:** Form 4, 13F, 13D/G, activist campaigns, ownership changes.
- **News and sentiment:** event detection, source quality scoring, sentiment and narrative momentum.

## Investment-process features

- **Idea funnel:** capture → screen → research → valuation → debate → portfolio decision.
- **Custom screeners (live):** reusable quantitative factor screens, qualitative filing screens (`jaspers/screener-mcp`), and scheduled NYSE market-calendar refreshes and SQLite delta watches are live today; multi-vendor cross-asset factor backtesting is next.
- **Valuation workbench:** DCF, multiples, reverse DCF, sum-of-the-parts, scenario analysis, sensitivity tables.
- **Financial-model builder:** automated historicals, forecast drivers, three-statement models, debt schedules.
- **Catalyst calendar:** earnings, product launches, filings, regulatory decisions, maturities, lockups.
- **Risk dashboard:** leverage, liquidity, dilution, customer concentration, litigation, governance, key-person risk.
- **Portfolio construction:** position sizing, factor exposure, correlation, drawdown, hedging, tax lots.
- **Thesis tracker:** thesis claims, supporting evidence, disconfirming evidence, milestones, kill criteria.
- **Decision journal:** record estimates and conviction, then measure forecast accuracy and attribution.
- **Alerts:** price, valuation, estimate revisions, insider activity, filing changes, thesis-break events.

## Collaboration features

- **Analyst rooms (live):** specialized agents for **valuation, credit, accounting, industry research, risks, and fact-checking** run concurrently in numbered Grid Loops and skill-driven research plugins today; shared multi-user rooms across machines are still to come.
- Automatic **source citation, contradiction detection, and model-to-filing tie-outs**. The chat already shows the sources a reply cites, when a server gives its quotes as [citations](connections-and-data.md#citations-in-the-chat); citing on its own, from any source, is still to come.
- **Export:** Excel export (`.xlsx` workbooks via document plugins and Pro mode, alongside live Excel formulas on the grid) and Markdown/PDF investment memos are live today; native PowerPoint export and direct portfolio-management system integrations are still to come.
