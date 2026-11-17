import {
  BROWSER_INTERACTION_ACTIONS,
  BROWSER_SCROLL_DIRECTIONS,
  extractBrowserTextSummary,
  readBrowserInteraction,
  resolveBrowserPanelTarget,
} from '../../../shared/grid/browser-interact'
import { replicaAt } from '../../collab/collab'
import { interactBrowserPanel } from '../../grid/browser'
import { getGrids } from '../../grid/grid'
import { loopsOf, ownTile, touchLoop } from '../../loops/loops'
import { getState } from '../../state'
import type { Tool } from './types'

export const browserTools: Tool[] = [
  {
    name: 'use_browser',
    description:
      'Act inside a core/browser view on the user’s behalf using real browser mouse, keyboard, scroll, and tab events in the signed-in browser session. Use click to press buttons, confirmation modals, tabs, checkboxes, or links (pass control like "c1" from Controls in panels/<id>/text, visible text like "Follow", CSS selector, or viewport x and y coordinates); type to focus and enter text into inputs, textareas, contenteditable editors, or select dropdowns (with optional clear and submit); press to send a key like "Enter", "Escape", "Tab", or "ArrowDown"; scroll to scroll the page or an open dialog ("down", "up", "left", "right", "top", "bottom"); or navigate, back, forward, reload, new_tab, select_tab, and close_tab to manage navigation and tabs. Returns the updated URL, title, open tabs, visible Controls, and text preview, and refreshes panels/<id>/text.',
    parameters: {
      type: 'object',
      properties: {
        elementId: {
          type: 'string',
          description:
            'The core/browser element id (like e15), panel id (like p15), or room id when it has one browser.',
        },
        action: {
          type: 'string',
          enum: [...BROWSER_INTERACTION_ACTIONS],
          description: 'The browser interaction to perform.',
        },
        control: {
          type: 'string',
          description: 'For click, type, or scroll: a control id from Controls in panels/<id>/text, like "c1".',
        },
        text: {
          type: 'string',
          description:
            'For click, type, or scroll: the visible label, aria-label, or placeholder of the target control (prioritizing open modal dialogs).',
        },
        selector: {
          type: 'string',
          description: 'For click, type, or scroll: a CSS selector matching a visible enabled element.',
        },
        index: {
          type: 'integer',
          minimum: 0,
          description: '0-based match index when multiple controls match text or selector (default 0).',
        },
        x: {
          type: 'number',
          minimum: 0,
          description: 'Viewport X coordinate in CSS pixels when clicking, typing, or scrolling at coordinates.',
        },
        y: {
          type: 'number',
          minimum: 0,
          description: 'Viewport Y coordinate in CSS pixels when clicking, typing, or scrolling at coordinates.',
        },
        doubleClick: {
          type: 'boolean',
          description: 'For click: true to send a double-click instead of a single click.',
        },
        value: {
          type: 'string',
          description: 'For type: the text to enter into the field (or option label/value for a select dropdown).',
        },
        clear: {
          type: 'boolean',
          description:
            'For type: whether to clear existing field content before typing (default true when a target is given).',
        },
        submit: {
          type: 'boolean',
          description: 'For type: true to press Enter after typing.',
        },
        key: {
          type: 'string',
          description:
            'For press: a key or chord such as "Enter", "Escape", "Tab", "Shift+Tab", "Space", "Backspace", "ArrowDown", "PageDown", or a single character.',
        },
        direction: {
          type: 'string',
          enum: [...BROWSER_SCROLL_DIRECTIONS],
          description: 'For scroll: direction to scroll (default "down").',
        },
        pixels: {
          type: 'number',
          minimum: 20,
          maximum: 4000,
          description: 'For scroll: distance in CSS pixels for down, up, left, or right (default 500).',
        },
        url: {
          type: 'string',
          description: 'For navigate or new_tab: an https:// or http:// address.',
        },
        tabId: {
          type: 'string',
          description: 'For select_tab or close_tab: tab id like "t1" or "t2".',
        },
      },
      required: ['elementId', 'action'],
    },
    async run(input, context) {
      const { workspaceId, signal, loop } = context
      const rawTarget = firstNonEmptyString(input.elementId, input.panelId, input.id)
      const grids = getGrids(workspaceId)
      const loops = loopsOf(workspaceId).list
      const { elementId, panel } = resolveBrowserPanelTarget(grids, loops, rawTarget, loop)
      ownTile(context, elementId)
      if (replicaAt(workspaceId, elementId)) {
        throw new Error('Built-in browser views run on the room owner’s terminal and cannot be driven on a replica.')
      }

      const interaction = readBrowserInteraction(input)
      const result = await interactBrowserPanel(workspaceId, panel.id, interaction, signal)

      const ownerLoop = findElementLoop(workspaceId, elementId)
      if (ownerLoop) touchLoop(workspaceId, ownerLoop)

      const { textPreview, controls } = extractBrowserTextSummary(result.snapshot.text)
      const tabs =
        result.snapshot.tabs && result.snapshot.tabs.length > 1
          ? result.snapshot.tabs.map((tab) => ({
              id: tab.id,
              url: tab.url,
              title: tab.title,
              active: tab.id === result.snapshot.activeTabId,
            }))
          : undefined

      return JSON.stringify({
        elementId,
        action: result.action,
        detail: result.detail,
        url: result.snapshot.url,
        title: result.snapshot.title,
        loading: result.snapshot.loading,
        activeTabId: result.snapshot.activeTabId,
        tabCount: result.snapshot.tabCount,
        ...(tabs ? { tabs } : {}),
        ...(result.snapshot.error ? { error: result.snapshot.error } : {}),
        ...(controls ? { controls } : {}),
        ...(textPreview ? { textPreview } : {}),
      })
    },
  },
]

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const val of values) {
    if (typeof val === 'string' && val.trim() !== '') return val.trim()
  }
  return undefined
}

function findElementLoop(workspaceId: string, elementId: string): string | undefined {
  for (const grid of Object.values(getState().grids[workspaceId] ?? {})) {
    const found = grid.elements.find((e) => e.id === elementId)
    if (found) return found.loop
  }
  return undefined
}
