import type { Reference } from '../../../shared/agent/build/prompt'
import sdk from '../../../../docs/sdk-reference.md?raw'
import tutorial from '../../../../docs/writing-a-plugin.md?raw'
import context from '../../../../packages/sdk/src/context.ts?raw'
import llm from '../../../../packages/sdk/src/llm.ts?raw'
import connectionPlugin from '../../../../docs/templates/connection/plugin.tsx?raw'
import connectionPackage from '../../../../docs/templates/connection/package.json?raw'
import documentPlugin from '../../../../docs/templates/document/plugin.tsx?raw'
import documentPackage from '../../../../docs/templates/document/package.json?raw'
import feedPlugin from '../../../../docs/templates/feed/plugin.tsx?raw'
import feedPackage from '../../../../docs/templates/feed/package.json?raw'
import feedTablePlugin from '../../../../docs/templates/feed-table/plugin.tsx?raw'
import feedTableView from '../../../../docs/templates/feed-table/SeriesTable.tsx?raw'
import feedTableStyles from '../../../../docs/templates/feed-table/styles.css?raw'
import feedTablePackage from '../../../../docs/templates/feed-table/package.json?raw'

// What the builder reads: the SDK's own documentation, the templates, and the SDK's source for `ctx`,
// the same files a person reads, bundled into main as text. One source of truth: a change to the
// docs or to those types is a change to what the builder is told. The docs name what `ctx` gives;
// context.ts says what each method takes and answers, and llm.ts what a turn and a completion are,
// which the llm capability takes and answers.

export const REFERENCE: Reference = {
  sdk,
  tutorial,
  types: [
    { path: 'context.ts', content: context },
    { path: 'llm.ts', content: llm },
  ],
  templates: [
    {
      name: 'feed',
      files: [
        { path: 'plugin.tsx', content: feedPlugin },
        { path: 'package.json', content: feedPackage },
      ],
    },
    {
      name: 'feed-table',
      files: [
        { path: 'plugin.tsx', content: feedTablePlugin },
        { path: 'SeriesTable.tsx', content: feedTableView },
        { path: 'styles.css', content: feedTableStyles },
        { path: 'package.json', content: feedTablePackage },
      ],
    },
    {
      name: 'document',
      files: [
        { path: 'plugin.tsx', content: documentPlugin },
        { path: 'package.json', content: documentPackage },
      ],
    },
    {
      name: 'connection',
      files: [
        { path: 'plugin.tsx', content: connectionPlugin },
        { path: 'package.json', content: connectionPackage },
      ],
    },
  ],
}
