import {
  arrange,
  DEFAULT_SIZE,
  EDGE_ANCHORS,
  freeRects,
  layoutOf,
  MIN_CELLS,
  NAMED_SIZES,
  presetSlots,
  PRESET_NAMES,
  setRect,
  type Anchor,
  type ElementMode,
  type GridSize,
  type PanelContent,
  type Preset,
  type NamedSize,
  type Rect,
  type Size,
} from '../../../shared/grid/grid'
import { MAIN_WINDOW, windowNumbers, WINDOWS_MAX } from '../../../shared/grid/windows'
import { frameOf, isTile, notPlaced } from '../../../shared/loops/loops'
import { asWindow, placeChecked, refreshChecked, removeChecked } from '../../actions'
import { notOwnFrame, ownTile } from '../../loops/loops'
import {
  changeGrid,
  changeGridOf,
  changeMode,
  findElement,
  focus,
  getGrid,
  getGrids,
  gridSizeOf,
  moveElementAcross,
} from '../../grid/grid'
import { getState } from '../../state'
import { displayCount, openWindow, useAllScreens, useOneScreen } from '../../grid/windows'
import { screenToolsOffered } from '../../../shared/grid/screens'
import type { Tool, ToolContext } from './types'
import { optional, unstring, isRecord, WINDOW } from './input'
import { coerceViewState } from '../../../shared/agent/view-state'

const MODES: ElementMode[] = ['tiled', 'floating', 'maximized', 'minimized']

const ELEMENT_ID = {
  type: 'string',
  description: 'An element id, like e3.',
}

/** The cells a rect may take, on the grid this round acts on: the workspace's size, not a constant. */
function rectSchema({ cols, rows }: GridSize): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      x: { type: 'integer', minimum: 0, maximum: cols - MIN_CELLS },
      y: { type: 'integer', minimum: 0, maximum: rows - MIN_CELLS },
      w: { type: 'integer', minimum: MIN_CELLS, maximum: cols },
      h: { type: 'integer', minimum: MIN_CELLS, maximum: rows },
    },
    required: ['x', 'y', 'w', 'h'],
  }
}

/** A preset's slots in words, worked out for this grid, since they are fractions of it. */
function presetSizes(size: GridSize): string {
  const slots = (preset: Preset): string =>
    presetSlots(preset, size)
      .map((r) => `${r.w}×${r.h}`)
      .join(' and ')
  return `1: one full. 1+1: halves side by side. 2+2: quarters. main+side: ${slots('main+side')}. main+bottom: ${slots('main+bottom')}. 3-col: columns ${presetSlots(
    '3-col',
    size,
  )
    .map((r) => r.w)
    .join(', ')} wide.`
}

/** Where a new element goes, as a tool's parameters say it: what place_view and create_loop both take, each with its own default size. */
export function placementProperties(size: GridSize, fallback: NamedSize = 'quarter'): Record<string, unknown> {
  return {
    size: {
      description: `${namedSizes(size)} Or {"w", "h"} in cells. Default ${fallback}.`,
      anyOf: [
        { type: 'string', enum: NAMED_SIZES },
        {
          type: 'object',
          properties: {
            w: { type: 'integer', minimum: MIN_CELLS, maximum: size.cols },
            h: { type: 'integer', minimum: MIN_CELLS, maximum: size.rows },
          },
          required: ['w', 'h'],
        },
      ],
    },
    anchor: {
      description:
        'Roughly where. auto: the first free spot in reading order. left, right, top, bottom: against that edge. center. {"beside": id}: next to an element, taking its height. {"below": id} or {"above": id}: taking its width. Default auto.',
      anyOf: [
        { type: 'string', enum: EDGE_ANCHORS },
        { type: 'object', properties: { beside: ELEMENT_ID }, required: ['beside'] },
        { type: 'object', properties: { below: ELEMENT_ID }, required: ['below'] },
        { type: 'object', properties: { above: ELEMENT_ID }, required: ['above'] },
      ],
    },
    rect: {
      ...rectSchema(size),
      description: 'Exact cells, winning over size and anchor. If taken, the same size goes as near as it fits.',
    },
  }
}

/**
 * The grid tools for one round. They are rebuilt each round because a rect's limits are the grid's
 * own size, which the user can change: a schema left at 16 × 12 would refuse cells that exist.
 */
export function gridTools(context?: ToolContext): Tool[] {
  const size = context ? gridSizeOf(context.workspaceId) : DEFAULT_SIZE
  const RECT = rectSchema(size)
  // Without a round to act in, every tool is here, so a task's call finds its tool by name.
  const screens = context
    ? screenToolsOffered(displayCount(), windowNumbers(getState().windows).length)
    : { all: true, one: true }
  const hidden = new Set([...(screens.all ? [] : ['use_all_screens']), ...(screens.one ? [] : ['use_one_screen'])])
  // A piece of work's agent lays its views out inside the work's own tile, wherever that is: it names no window.
  const inside = context?.loop !== undefined
  const where = inside
    ? `in your work's tile, on its own ${size.cols} columns × ${size.rows} rows`
    : `on the grid, ${size.cols} columns × ${size.rows} rows filling the window`
  const tools: Tool[] = [
    {
      name: 'place_view',
      description: `Put an installed view ${where}: the views are listed in the prompt, with the state each takes. Say what and roughly where; the grid manager picks the cells and never moves other elements to make room. Returns the element id, panel id, the rect it got, and resolved: exact, moved (same size, somewhere else), or shrunk. Fails with grid_full when not even 2×2 fits: make room as the grid rules say.`,
      parameters: {
        type: 'object',
        properties: {
          view: { type: 'string', description: 'An installed view id, like core/table.' },
          state: {
            type: 'object',
            description: 'What the view starts with, against its state schema.',
          },
          ...placementProperties(size),
          replace: {
            ...ELEMENT_ID,
            description:
              'An element to replace. With no size, anchor, or rect the new one takes over its cells as they are.',
          },
          ...(inside ? {} : { window: WINDOW }),
        },
        required: ['view'],
      },
      async run(input, context) {
        const { workspaceId } = context
        const window = asWindow(input.window)
        const content: PanelContent = { kind: 'view', view: asViewId(input.view) }
        // The note is no agent's to place: what it would say there is said in its reply.
        const refused = notPlaced(content.view)
        if (refused !== null) throw new Error(refused)
        // The view's own schema still decides; this only reads what the model spelled another way.
        const state = coerceViewState(stateSchemaOf(content.view), input.state)
        const checked = optional(state, asStateObject)
        const placement = {
          size: optional(input.size, asSize),
          anchor: optional(input.anchor, asAnchor),
          rect: optional(input.rect, asRect),
          replace: optional(input.replace, asElementId),
        }
        // A loop's agent takes the place of its own tiles only, and what it places is another of them.
        // The docked chat is no work's tile: it is the global conversation, and where it sits is the
        // window's business.
        if (context.loop !== undefined && !isTile(content)) {
          throw new Error(
            "The chat is the global conversation, which the user docks from the composer: it is not this work's to place.",
          )
        }
        if (placement.replace !== undefined) ownTile(context, placement.replace)
        const { element, panel, resolved } = placeChecked(
          workspaceId,
          window,
          content,
          checked,
          placement,
          context.loop,
        )
        return JSON.stringify({
          elementId: element.id,
          panelId: panel.id,
          window: findElement(workspaceId, element.id).window,
          rect: element.rect,
          resolved,
        })
      },
    },
    {
      name: 'move_element',
      description: inside
        ? 'Move an element to new cells; pass its current w and h to keep its size. A tiled element needs the cells free, and the error names what is in the way. A floating one may overlap. A maximized one is restored there.'
        : "Move an element to new cells; pass its current w and h to keep its size. With window, move it into another open window instead: rect there is optional, and it keeps its size where that fits. A piece of work's tile takes the views inside it along; a view inside one stays in its tile. A tiled element needs the cells free, and the error names what is in the way. A floating one may overlap. A maximized or a minimized one is restored there.",
      parameters: {
        type: 'object',
        properties: {
          elementId: ELEMENT_ID,
          rect: RECT,
          ...(inside ? {} : { window: { ...WINDOW, description: 'Another open window to move it into.' } }),
        },
        required: inside ? ['elementId', 'rect'] : ['elementId'],
      },
      async run(input, context) {
        const { workspaceId } = context
        const id = asElementId(input.elementId)
        ownTile(context, id)
        const window = optional(input.window, asWindow)
        if (window !== undefined) {
          const { element, resolved, from } = moveElementAcross(workspaceId, id, window, {
            rect: optional(input.rect, asRect),
          })
          return JSON.stringify({ elementId: element.id, window, from, rect: element.rect, resolved })
        }
        if (input.rect === undefined || input.rect === null)
          throw new Error('Give rect for new cells, or window for another window.')
        const { element } = changeGridOf(workspaceId, id, (grid) => setRect(grid, id, asRect(input.rect)))
        return JSON.stringify({ elementId: element.id, rect: element.rect })
      },
    },
    {
      name: 'resize_element',
      description:
        'Resize an element; pass its current x and y to keep its top left corner. Same rules as move_element: a tiled element needs the cells free.',
      parameters: {
        type: 'object',
        properties: { elementId: ELEMENT_ID, rect: RECT },
        required: ['elementId', 'rect'],
      },
      async run(input, context) {
        const { workspaceId } = context
        const id = asElementId(input.elementId)
        ownTile(context, id)
        const { element } = changeGridOf(workspaceId, id, (grid) => setRect(grid, id, asRect(input.rect)))
        return JSON.stringify({ elementId: element.id, rect: element.rect })
      },
    },
    {
      name: 'remove_element',
      description: 'Close an element and the panel in it.',
      parameters: { type: 'object', properties: { elementId: ELEMENT_ID }, required: ['elementId'] },
      async run(input, context) {
        const { workspaceId } = context
        const id = asElementId(input.elementId)
        ownTile(context, id)
        notOwnFrame(context, id)
        removeChecked(workspaceId, id)
        return JSON.stringify({ removed: id })
      },
    },
    {
      name: 'set_mode',
      description:
        "tiled: the default, never overlapping. floating: above the rest and free to overlap; use sparingly. maximized: fills the window, or for a view inside a piece of work's tile fills that tile, and hides the others there until set back to tiled, or floating if it floated before. minimized, for a piece of work's tile only: its bar alone, on the top row of where it stood, with the cells under it free for others; set it back to tiled, or floating if it floated before, and it returns to where it was, or to the nearest free cells when those were taken. Returns the rect it ends up with.",
      parameters: {
        type: 'object',
        properties: { elementId: ELEMENT_ID, mode: { type: 'string', enum: MODES } },
        required: ['elementId', 'mode'],
      },
      async run(input, context) {
        const { workspaceId } = context
        const id = asElementId(input.elementId)
        ownTile(context, id)
        const { element, resolved } = changeMode(workspaceId, id, asMode(input.mode))
        return JSON.stringify({ elementId: element.id, mode: element.mode, rect: element.rect, resolved })
      },
    },
    {
      name: 'arrange',
      description: `Re-tile every element into a layout, most recently focused first, so the focused one gets the main slot. ${presetSizes(size)} Fails when the grid has more elements than the layout has slots. Acts on one window, the main one unless window says otherwise.`,
      parameters: {
        type: 'object',
        properties: { preset: { type: 'string', enum: [...PRESET_NAMES] }, window: WINDOW },
        required: ['preset'],
      },
      async run(input, { workspaceId }) {
        const window = asWindow(input.window)
        const { grid } = changeGrid(workspaceId, window, (current) => arrange(current, asPreset(input.preset)))
        return JSON.stringify({ window, elements: grid.elements.map((e) => ({ elementId: e.id, rect: e.rect })) })
      },
    },
    {
      name: 'free_space',
      readsOnly: true,
      description: inside
        ? "The free space in your work's tile as maximal free rectangles, largest first."
        : "The free space on one window's grid as maximal free rectangles, largest first.",
      parameters: { type: 'object', properties: inside ? {} : { window: WINDOW } },
      async run(input, { workspaceId, loop }) {
        // A piece of work's agent asks about the cells inside its own tile; anyone else, a window's.
        const frame = loop === undefined ? undefined : frameOf(getGrids(workspaceId), loop)
        if (frame) {
          const grid = getGrid(workspaceId, frame.window)
          return JSON.stringify({ free: freeRects(layoutOf(grid, frame.element.id).elements, grid.size) })
        }
        const window = asWindow(input.window)
        const grid = getGrid(workspaceId, window)
        return JSON.stringify({ window, free: freeRects(layoutOf(grid).elements, grid.size) })
      },
    },
    {
      name: 'focus',
      description: 'Focus an element. The focused element is what "that" and "it" mean.',
      parameters: { type: 'object', properties: { elementId: ELEMENT_ID }, required: ['elementId'] },
      async run(input, { workspaceId }) {
        const id = asElementId(input.elementId)
        focus(workspaceId, id)
        return JSON.stringify({ focused: id })
      },
    },
    {
      name: 'open_window',
      description: `Open another window of this workspace with a grid of its own, empty, or as it was if that number was open before. It opens beside the main window, which is the only one with the chat. Up to ${WINDOWS_MAX} windows in all. Returns the number and the open ones; then place there with window.`,
      parameters: {
        type: 'object',
        properties: {
          window: {
            type: 'integer',
            minimum: 2,
            maximum: WINDOWS_MAX,
            description: 'A closed number to open again. Default: the lowest free one.',
          },
        },
      },
      async run(input) {
        const window = openWindow(optional(input.window, asWindow))
        return JSON.stringify({ window, open: windowNumbers(getState().windows) })
      },
    },
    {
      name: 'use_all_screens',
      description: `Spread this workspace over every screen the computer has: one window per display, each placed on its own display and filling it, opening the windows it needs, up to ${WINDOWS_MAX}. For when the user asks to use all their screens, both monitors, or the second display. The windows already open are moved, never opened again, so calling it twice leaves the same arrangement, and every window shows this workspace, with the chat in the main one. With more windows open than displays, the ones left over stay open where they are and come back as surplus: say so, and offer to close them or use_one_screen. Returns the windows, how many displays there are, and the surplus; then place on one of them with window. With one display it just makes the window fill the screen.`,
      parameters: { type: 'object', properties: {} },
      async run() {
        const { windows, displays, surplus } = useAllScreens()
        return JSON.stringify({ windows, displays, surplus })
      },
    },
    {
      name: 'use_one_screen',
      description:
        "Back to one window on one screen: every other window's elements move into the main window's grid, keeping their size where it fits, and those windows close. For when the user is done with the other screens or asks for one window again. Fails, naming the window and what is in it, when a window has cells written in it, since a move does not carry cells, or when an element does not fit in the main window's grid; then clear those cells with clear_cells, or make room with move_element, resize_element, or arrange, and nothing has changed meanwhile. Returns the windows that closed and the elements that moved.",
      parameters: { type: 'object', properties: {} },
      async run() {
        const { closed, moved } = useOneScreen()
        // The closes are asynchronous, so the tree can still list the windows just closed: once this
        // returns, the main window is the only one open.
        return JSON.stringify({ closed, moved, open: [MAIN_WINDOW] })
      },
    },
    {
      name: 'refresh_element',
      description:
        "Make an element's view fetch its data again, fresh, without changing what it shows: for update, reload, or the latest. A view that draws its own data is live already and ignores it.",
      parameters: { type: 'object', properties: { elementId: ELEMENT_ID }, required: ['elementId'] },
      async run(input, context) {
        const id = asElementId(input.elementId)
        ownTile(context, id)
        const panel = refreshChecked(context.workspaceId, id)
        return JSON.stringify({ refreshed: panel.elementId, at: panel.refreshedAt })
      },
    },
  ]
  return tools.filter((tool) => !hidden.has(tool.name))
}

function asViewId(value: unknown): string {
  if (typeof value === 'string' && value) return value
  throw new Error('view must be an installed view id, like core/table.')
}

/** The JSON Schema of an installed view's state, or undefined for one that is not installed. */
function stateSchemaOf(view: string): Record<string, unknown> | undefined {
  return getState().views[view]?.stateSchema
}

function asStateObject(raw: unknown): Record<string, unknown> {
  const value = unstring(raw)
  if (isRecord(value)) return value
  throw new Error("state must be an object of the view's settings.")
}

export function asSize(raw: unknown): Size {
  const value = unstring(raw)
  const named = NAMED_SIZES.find((s) => s === value)
  if (named) return named
  if (isRecord(value) && typeof value.w === 'number' && typeof value.h === 'number') return { w: value.w, h: value.h }
  throw new Error(`size must be one of ${NAMED_SIZES.join(', ')}, or {"w", "h"} in cells.`)
}

export function asAnchor(raw: unknown): Anchor {
  const value = unstring(raw)
  const edge = EDGE_ANCHORS.find((a) => a === value)
  if (edge) return edge
  if (isRecord(value)) {
    if (typeof value.beside === 'string') return { beside: value.beside }
    if (typeof value.below === 'string') return { below: value.below }
    if (typeof value.above === 'string') return { above: value.above }
  }
  throw new Error(`anchor must be one of ${EDGE_ANCHORS.join(', ')}, or {"beside" | "below" | "above": element id}.`)
}

export function asRect(raw: unknown): Rect {
  const value = unstring(raw)
  if (isRecord(value)) {
    const { x, y, w, h } = value
    if (typeof x === 'number' && typeof y === 'number' && typeof w === 'number' && typeof h === 'number') {
      return { x, y, w, h }
    }
  }
  throw new Error('rect must be {"x", "y", "w", "h"} in cells.')
}

function asElementId(value: unknown): string {
  if (typeof value === 'string' && value) return value
  throw new Error('elementId must be an element id from the grid, like e3.')
}

function asMode(value: unknown): ElementMode {
  const mode = MODES.find((m) => m === value)
  if (mode) return mode
  throw new Error(`mode must be one of ${MODES.join(', ')}.`)
}

function asPreset(value: unknown): Preset {
  const preset = PRESET_NAMES.find((p) => p === value)
  if (preset) return preset
  throw new Error(`preset must be one of ${PRESET_NAMES.join(', ')}.`)
}

/** The named sizes in cells on this grid: what the model is told `size` means here. */
function namedSizes({ cols, rows }: GridSize): string {
  const half = [Math.round(cols / 2), Math.round(rows / 2)]
  return `full ${cols}×${rows}, half ${half[0]}×${rows} (${cols}×${half[1]} when anchored top or bottom), quarter ${half[0]}×${half[1]}, third ${cols}×${Math.round(rows / 3)} (${Math.round(cols / 3)}×${rows} when anchored left or right), wide ${cols}×${Math.round(rows / 3)}, tall ${Math.round(cols / 4)}×${rows}.`
}
