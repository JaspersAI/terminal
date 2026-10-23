import { mask } from '../agent/transcript.ts'
import type { Panel } from '../grid/grid.ts'
import type { AppState } from '../state.ts'

// What a line of Eye's telemetry is: one JSON object per thing that happened, appended to the
// session's `events.jsonl`, numbered by its place in the file. A session's lines are enough to read
// it back in order: what the user did (actions, clicks, the windows), what the app's tree became
// (a snapshot, then every change as JSON Patch), every step of every request to the assistant as it
// happened, what went wrong, and how the app performed. Pure: main writes the lines, the server
// reads them, and the rules for what a line may hold are here, where both can be held to them.
//
// What a line never holds: a key, a token, or a password the app knows (masked, as is the email it
// is signed in as); what is written in a cell or a note (the tree keeps that one holds something,
// never what, and the tools that read and write cells keep only that they did); the characters typed
// into a field (a count); the user's home folder (written `~`).

/** The line this build writes. A line with no `v` is from a build before lines had one. */
export const LINE_VERSION = 2

export type EyeKind =
  | 'session'
  | 'snapshot'
  | 'session-end'
  | 'setting'
  | 'action'
  | 'click'
  | 'type'
  | 'zoom'
  | 'chart'
  | 'source'
  | 'focus'
  | 'blur'
  | 'window'
  | 'change'
  | 'run'
  | 'llm'
  | 'said'
  | 'status'
  | 'added'
  | 'tool'
  | 'tool-end'
  | 'run-end'
  | 'notice'
  | 'error'
  | 'crash'
  | 'unresponsive'
  | 'metrics'
  | 'frame'
  | 'feedback'

/** A line as the recorder is handed it. `at` is when it happened, ms since the epoch; left out, now. */
export interface EyeEvent {
  kind: EyeKind
  at?: number
  /** A name the app chose: a tool, an action, a view, a plugin, a frame's file, a button's label. */
  name?: string
  ok?: boolean
  ms?: number
  count?: number
  /** The run it belongs to. */
  run?: string
  /** What inside the run (a round, a call), or an action's cause id. */
  span?: string
  window?: number
  workspace?: string
  /** The action that led to a change of the tree. */
  cause?: string
  /** What the kind carries: each kind's keys are fixed by the code that writes it. */
  data?: Record<string, unknown>
}

/** What a line is masked against: the secrets the app holds (and the email it is signed in as), and the home folder as it is written. */
export interface Masking {
  secrets: readonly string[]
  homes: readonly string[]
}

/**
 * The home folder as a line may hold it: as the system writes it, and on Windows also as a file URL
 * writes it, with forward slashes and its spaces escaped, the way a stack trace names a file.
 */
export function homeForms(home: string): string[] {
  if (home.length <= 1) return []
  const forward = home.replaceAll('\\', '/')
  return [...new Set([home, forward, encodeURI(forward)])]
}

/**
 * How long a line may be, in characters of JSON. Past it, the line keeps its ids and says how big its
 * data was instead. A safety valve for a runaway value, not a cap on what is recorded: a snapshot of
 * the tree is never cut, and a change that was is followed by a snapshot.
 */
export const LINE_MAX = 256 * 1024

/** How long a name may be: a button's label shorter than the rest. */
const NAME_MAX = 200
const LABEL_MAX = 80

/** How much of each text a kind keeps. A request or a reply is a page or two; a tool's arguments or result less. */
const CAPS: Partial<Record<EyeKind, Record<string, number>>> = {
  'run-end': { request: 8000, reply: 8000, error: 4000 },
  said: { text: 8000 },
  added: { text: 8000 },
  tool: { input: 4000 },
  'tool-end': { output: 4000, error: 4000 },
  source: { error: 4000 },
  chart: { series: 80, label: 80 },
  llm: { message: 4000 },
  error: { message: 4000, stack: 4000 },
  notice: { text: 1000 },
  status: { line: 500 },
  feedback: { text: 4000 },
}

/**
 * The line as it is written: every string masked, every text capped, the fields in one order, one
 * line ending at its newline. `dropped` says the line was past `LINE_MAX` and its data left out.
 */
export function eyeLine(event: EyeEvent & { at: number }, masking: Masking): { text: string; dropped: boolean } {
  const caps = CAPS[event.kind] ?? {}
  const data =
    event.data === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(event.data).map(([key, value]) => {
            const clean = cleaned(value, masking)
            return [key, typeof clean === 'string' && caps[key] !== undefined ? cut(clean, caps[key]) : clean]
          }),
        )
  const line = fields(event, masking, data)
  const text = JSON.stringify(line)
  if (text.length <= LINE_MAX || event.kind === 'snapshot') return { text: `${text}\n`, dropped: false }
  return { text: `${JSON.stringify(fields(event, masking, { dropped: text.length }))}\n`, dropped: true }
}

function fields(event: EyeEvent & { at: number }, masking: Masking, data: unknown): Record<string, unknown> {
  const line: Record<string, unknown> = { v: LINE_VERSION, at: event.at, kind: event.kind }
  if (event.name !== undefined) {
    line['name'] = cut(cleaned(event.name, masking) as string, event.kind === 'click' ? LABEL_MAX : NAME_MAX)
  }
  if (event.ok !== undefined) line['ok'] = event.ok
  if (event.ms !== undefined) line['ms'] = Math.round(event.ms)
  if (event.count !== undefined) line['count'] = event.count
  if (event.run !== undefined) line['run'] = event.run
  if (event.span !== undefined) line['span'] = event.span
  if (event.window !== undefined) line['window'] = event.window
  if (event.workspace !== undefined) line['workspace'] = event.workspace
  if (event.cause !== undefined) line['cause'] = event.cause
  if (data !== undefined) line['data'] = data
  return line
}

/** Every string in a value masked and the home folder written `~`, the value given left as it was. Keys are the app's names and stay. */
export function cleaned(value: unknown, masking: Masking): unknown {
  if (typeof value === 'string') {
    let masked = mask(value, masking.secrets as string[])
    for (const home of masking.homes) if (home.length > 1) masked = masked.split(home).join('~')
    return masked
  }
  if (Array.isArray(value)) return value.map((item) => cleaned(item, masking))
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleaned(item, masking)]))
  return value
}

/** A text at most `max` long, marked where it was cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

const cut = clip

/**
 * The actions that are not the user's: a view writing its own state, output, or text, which it does
 * as it is used (a note on every key pressed), and a window saying it has drawn a question. What
 * they change is in the tree's changes; they are not lines of their own.
 */
const QUIET_ACTIONS = new Set(['panel.setState', 'panel.publish', 'panel.publishText', 'question.seen'])

export function quietAction(name: string): boolean {
  return QUIET_ACTIONS.has(name)
}

/** The assistant's tools whose input and output are what is written in cells. */
const CELL_TOOLS = new Set(['read_cells', 'write_cells'])
/** What such a tool's input, output, or error is kept as: that it was cells. */
export const HIDDEN_CELLS = '[cells]'

export function hidesCells(tool: string): boolean {
  return CELL_TOOLS.has(tool)
}

/**
 * What a dispatched action is kept as: its type as the line's name, and the rest as its data, less
 * what must never be written: a provider's token, a plugin's secret, what was typed into cells (their
 * names stay), and a note's words (the `feedback` line has those). What a view is placed with is in
 * the tree, as Eye keeps it, and is left out here. What the user answers the assistant is what they
 * sent it, and stays. Anything that is not an action is `?`.
 */
export function actionData(raw: unknown): { name: string; data: Record<string, unknown> } {
  if (!isRecord(raw) || typeof raw['type'] !== 'string') return { name: '?', data: {} }
  const { type, ...data } = raw
  const name = type.slice(0, NAME_MAX)
  if (name === 'provider.set' && isRecord(data['input'])) {
    const { token: _token, ...input } = data['input']
    return { name, data: { ...data, input } }
  }
  if (name === 'plugin.setSecret') {
    const { value: _value, ...rest } = data
    return { name, data: rest }
  }
  if (name === 'cells.write' && isRecord(data['cells']))
    return { name, data: { ...data, cells: Object.keys(data['cells']) } }
  if (name === 'eye.feedback') return { name, data: {} }
  if (name === 'element.place') {
    const { state: _state, ...rest } = data
    return { name, data: rest }
  }
  return { name, data }
}

/** What a cell holds, as Eye keeps it: that it holds something. */
export const HIDDEN_CELL = '[cell]'
/** What a note holds, the same way. */
export const HIDDEN_NOTE = '[note]'

/** The views whose state is what the user wrote in them. */
const WRITTEN_VIEWS = new Set(['core/note'])

const made = new WeakMap<object, unknown>()

/** The same answer for the same object, so a tree made again of the parts that did not change is those same parts. */
function once<T extends object, U>(key: T, make: () => U): U {
  if (!made.has(key)) made.set(key, make())
  return made.get(key) as U
}

/**
 * The public tree as Eye keeps it: every cell's contents replaced by `HIDDEN_CELL`, every word of a
 * note (its state, its output, its summary, its text) by `HIDDEN_NOTE`, and Eye's own counters left
 * out, so the recorder's bookkeeping is not a change every minute. Grids and panels that did not
 * change come back as the same objects, so a diff passes over them.
 */
export function eyeTree(state: AppState): Record<string, unknown> {
  const grids = once(state.grids, () =>
    Object.fromEntries(
      Object.entries(state.grids).map(([workspace, windows]) => [
        workspace,
        once(windows, () =>
          Object.fromEntries(
            Object.entries(windows).map(([number, grid]) => [
              number,
              once(grid, () => ({
                ...grid,
                panels: grid.panels.map(written),
                cells: Object.fromEntries(Object.keys(grid.cells).map((cell) => [cell, HIDDEN_CELL])),
              })),
            ]),
          ),
        ),
      ]),
    ),
  )
  const { recording, asked, install } = state.eye
  return { ...state, grids, eye: { recording, asked, install } }
}

/** A panel as Eye keeps it: a note's every word hidden, typing into it no change; any other view as it is. */
function written(panel: Panel): Panel {
  if (panel.content.kind !== 'view' || !WRITTEN_VIEWS.has(panel.content.view)) return panel
  return once(panel, () => ({
    ...panel,
    state: hidden(panel.state),
    output: hidden(panel.output),
    summary: hidden(panel.summary),
    text: hidden(panel.text),
  }))
}

/**
 * Everything written in a note, as the tree holds it: what a line is masked against as it is against
 * a key, so the assistant reading a note back (its summary in a `get`) does not carry it out either.
 */
export function writtenTexts(grids: AppState['grids']): string[] {
  const texts = new Set<string>()
  const gather = (value: unknown): void => {
    if (typeof value === 'string' && value) texts.add(value)
    else if (Array.isArray(value)) value.forEach(gather)
    else if (isRecord(value)) Object.values(value).forEach(gather)
  }
  for (const windows of Object.values(grids)) {
    for (const grid of Object.values(windows)) {
      for (const panel of grid.panels) {
        if (panel.content.kind !== 'view' || !WRITTEN_VIEWS.has(panel.content.view)) continue
        for (const part of [panel.state, panel.output, panel.summary, panel.text]) gather(part)
      }
    }
  }
  return [...texts]
}

/** Every string with something in it replaced by `HIDDEN_NOTE`: what was written is gone, that something was is not. */
function hidden<T>(value: T): T {
  if (typeof value === 'string') return (value ? HIDDEN_NOTE : value) as T
  if (Array.isArray(value)) return value.map(hidden) as T
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hidden(item)])) as T
  return value
}

export const CHART_NOTE_NAMES = ['zoom', 'legend', 'point', 'hover'] as const
export type ChartNoteName = (typeof CHART_NOTE_NAMES)[number]

export const ZOOM_NOTE_NAMES = ['in', 'out', 'reset'] as const
export type ZoomNoteName = (typeof ZOOM_NOTE_NAMES)[number]

/** What a window may tell Eye: a click, how much was typed into a field, a zoom gesture, a chart interaction, an error. Never the characters typed. */
export type Note =
  | {
      kind: 'click'
      name: string
      role: string | null
      x: number
      y: number
      button?: number
      detail?: number
      view?: string | null
      plugin?: string | null
      panel?: string | null
    }
  | {
      kind: 'type'
      name: string
      count: number
      view?: string | null
      plugin?: string | null
      panel?: string | null
    }
  | {
      kind: 'zoom'
      name: ZoomNoteName
      factor?: number | null
      view?: string | null
      plugin?: string | null
      panel?: string | null
    }
  | {
      kind: 'chart'
      name: ChartNoteName
      panel: string
      chart: string
      start?: number
      end?: number
      series?: string | null
      shown?: boolean
      label?: string | null
      index?: number
      points?: number
    }
  | {
      kind: 'error'
      name: 'renderer' | 'view'
      message: string
      stack: string | null
      view: string | null
      plugin: string | null
    }

function readViewContext(raw: Record<string, unknown>): {
  view?: string | null
  plugin?: string | null
  panel?: string | null
} {
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? cut(value.trim(), NAME_MAX) : null
  const view = text(raw['view'])
  const plugin = text(raw['plugin'])
  const panel = text(raw['panel'])
  return {
    ...(view !== null ? { view } : {}),
    ...(plugin !== null ? { plugin } : {}),
    ...(panel !== null ? { panel } : {}),
  }
}

/** A note as a window sent it, every field of the right kind and capped, or null: the bridge is an input like any other. */
export function readNote(raw: unknown): Note | null {
  if (!isRecord(raw) || typeof raw['name'] !== 'string') return null
  const name = raw['name']
  if (raw['kind'] === 'click') {
    const { x, y, role, button, detail } = raw
    if (!isFinite(x) || !isFinite(y)) return null
    const validButton =
      typeof button === 'number' && Number.isInteger(button) && button >= 0 && button <= 4 ? button : undefined
    const validDetail =
      typeof detail === 'number' && Number.isInteger(detail) && detail >= 1 && detail <= 10 ? detail : undefined
    return {
      kind: 'click',
      name: cut(name, LABEL_MAX),
      role: typeof role === 'string' ? role.slice(0, 40) : null,
      x: Math.round(x),
      y: Math.round(y),
      ...(validButton !== undefined ? { button: validButton } : {}),
      ...(validDetail !== undefined ? { detail: validDetail } : {}),
      ...readViewContext(raw),
    }
  }
  if (raw['kind'] === 'type') {
    const count = raw['count']
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null
    return { kind: 'type', name: cut(name, LABEL_MAX), count, ...readViewContext(raw) }
  }
  if (raw['kind'] === 'zoom') {
    if (!ZOOM_NOTE_NAMES.includes(name as ZoomNoteName)) return null
    const factor =
      isFinite(raw['factor']) && raw['factor'] > 0 && raw['factor'] <= 10
        ? Math.round(raw['factor'] * 100) / 100
        : undefined
    return {
      kind: 'zoom',
      name: name as ZoomNoteName,
      ...(factor !== undefined ? { factor } : {}),
      ...readViewContext(raw),
    }
  }
  if (raw['kind'] === 'chart') {
    if (!CHART_NOTE_NAMES.includes(name as ChartNoteName)) return null
    if (typeof raw['panel'] !== 'string' || !raw['panel'].trim()) return null
    if (typeof raw['chart'] !== 'string' || !raw['chart'].trim()) return null
    const panel = cut(raw['panel'].trim(), NAME_MAX)
    const chart = cut(raw['chart'].trim(), 40)
    const pct = (v: unknown): number | undefined =>
      isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : undefined
    const start = pct(raw['start'])
    const end = pct(raw['end'])
    const series =
      typeof raw['series'] === 'string' && raw['series'].trim() ? cut(raw['series'].trim(), LABEL_MAX) : undefined
    const shown = typeof raw['shown'] === 'boolean' ? raw['shown'] : undefined
    const label =
      typeof raw['label'] === 'string' && raw['label'].trim() ? cut(raw['label'].trim(), LABEL_MAX) : undefined
    const index =
      typeof raw['index'] === 'number' && Number.isInteger(raw['index']) && raw['index'] >= 0 ? raw['index'] : undefined
    const points =
      typeof raw['points'] === 'number' && Number.isInteger(raw['points']) && raw['points'] >= 1
        ? raw['points']
        : undefined
    return {
      kind: 'chart',
      name: name as ChartNoteName,
      panel,
      chart,
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
      ...(series !== undefined ? { series } : {}),
      ...(shown !== undefined ? { shown } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(index !== undefined ? { index } : {}),
      ...(points !== undefined ? { points } : {}),
    }
  }
  if (raw['kind'] === 'error') {
    if ((name !== 'renderer' && name !== 'view') || typeof raw['message'] !== 'string') return null
    const text = (value: unknown, max: number): string | null => (typeof value === 'string' ? cut(value, max) : null)
    return {
      kind: 'error',
      name,
      message: cut(raw['message'], 4000),
      stack: text(raw['stack'], 4000),
      view: text(raw['view'], NAME_MAX),
      plugin: text(raw['plugin'], NAME_MAX),
    }
  }
  return null
}

/** A note as the line of the window that sent it, when one did. */
export function noteEvent(note: Note, window: number | null): EyeEvent {
  const where = window === null ? {} : { window }
  if (note.kind === 'click') {
    const { role, x, y, button, detail, view, plugin, panel } = note
    return {
      kind: 'click',
      name: note.name,
      ...where,
      data: {
        role,
        x,
        y,
        ...(button !== undefined ? { button } : {}),
        ...(detail !== undefined ? { detail } : {}),
        ...(view ? { view } : {}),
        ...(plugin ? { plugin } : {}),
        ...(panel ? { panel } : {}),
      },
    }
  }
  if (note.kind === 'type') {
    const { view, plugin, panel } = note
    const hasContext = Boolean(view || plugin || panel)
    return {
      kind: 'type',
      name: note.name,
      count: note.count,
      ...where,
      ...(hasContext
        ? {
            data: {
              ...(view ? { view } : {}),
              ...(plugin ? { plugin } : {}),
              ...(panel ? { panel } : {}),
            },
          }
        : {}),
    }
  }
  if (note.kind === 'zoom') {
    const { factor, view, plugin, panel } = note
    const data: Record<string, unknown> = {
      ...(factor !== undefined && factor !== null ? { factor } : {}),
      ...(view ? { view } : {}),
      ...(plugin ? { plugin } : {}),
      ...(panel ? { panel } : {}),
    }
    return {
      kind: 'zoom',
      name: note.name,
      ...where,
      ...(Object.keys(data).length > 0 ? { data } : {}),
    }
  }
  if (note.kind === 'chart') {
    const { panel, chart, start, end, series, shown, label, index, points } = note
    return {
      kind: 'chart',
      name: note.name,
      ...where,
      data: {
        panel,
        kind: chart,
        ...(start !== undefined ? { start } : {}),
        ...(end !== undefined ? { end } : {}),
        ...(series !== undefined && series !== null ? { series } : {}),
        ...(shown !== undefined ? { shown } : {}),
        ...(label !== undefined && label !== null ? { label } : {}),
        ...(index !== undefined ? { index } : {}),
        ...(points !== undefined ? { points } : {}),
      },
    }
  }
  const { message, stack, view, plugin } = note
  return { kind: 'error', name: note.name, ...where, data: { message, stack, view, plugin } }
}

/** Whether a keyboard shortcut is a zoom in, zoom out, or zoom reset gesture. */
export function zoomKey(event: {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}): ZoomNoteName | null {
  if ((!event.metaKey && !event.ctrlKey) || event.altKey) return null
  if (event.key === '+' || event.key === '=') return 'in'
  if (event.key === '-' || event.key === '_') return 'out'
  if (event.key === '0') return 'reset'
  return null
}

/** Whether a wheel or trackpad pinch event is a zoom in or zoom out gesture. */
export function zoomWheel(event: { deltaY: number; ctrlKey?: boolean; metaKey?: boolean }): 'in' | 'out' | null {
  if (!event.ctrlKey && !event.metaKey) return null
  if (!isFinite(event.deltaY) || event.deltaY === 0) return null
  return event.deltaY < 0 ? 'in' : 'out'
}

function isFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
