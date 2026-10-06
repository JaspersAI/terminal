// Loops: a unit of work and the tiles that show it. Every element on a grid is a tile of one, but
// the docked chat, which is the global conversation in a tile. A loop has one frame, on the cells of
// a window: the tile that says what the work is and takes what is typed for it. The views the work
// shows are tiles laid out inside the frame, so a piece of work is one thing on the grid however many
// views it has. A loop is made with its frame, and closing the frame closes it: its record, its
// tiles, and its conversation are kept, and reopening it brings the frame back (`closed.ts`).
//
// Pure: the record, and every rule about names, tiles, and a saved workspace made whole. Main applies
// them where tiles are placed and removed.

import {
  CHAT_VIEW,
  EMPTY_GRID,
  extent,
  layoutOf,
  rectProblem,
  resolvePlacement,
  restored,
  setMode,
  type Grid,
  type GridElement,
  type GridSize,
  type Panel,
  type PanelContent,
} from '../grid/grid.ts'

export interface Loop {
  /**
   * f1, f2, … from a counter kept with its workspace, never reused: the key its tiles, its thread,
   * and its log are filed under. Users and models call it by its name, loop_1 (`loopName`).
   */
  id: string
  /** One line saying what the work is. */
  desc: string
  /** What its agent was set to do, in words written for it. Empty for a tile nobody asked for in words. */
  brief: string
  /** The plugins its agent is told of. */
  plugins: string[]
  /** The skills named for it, beyond its plugins' own. */
  skills: string[]
  createdAt: number
  /** What happened to it since it was made, oldest first, for the loop log. Absent until the first. */
  log?: LoopChange[]
}

/** One change in a loop's life, after it was made. */
export interface LoopChange {
  at: number
  change: 'closed' | 'reopened'
}

/**
 * A loop whose frame was closed: its record, and the frame with every tile inside it as they were,
 * so reopening it puts back what was there. Its thread and its log are kept under its id.
 */
export interface ClosedLoop {
  loop: Loop
  /** The window its frame was in. */
  window: number
  /** The frame first, then the tiles inside it. */
  elements: GridElement[]
  panels: Panel[]
}

/** A workspace's loops, and the counter their ids come from. */
export interface Loops {
  seq: number
  list: Loop[]
  /** The closed ones, most recently closed last. Absent when none is. */
  closed?: ClosedLoop[]
}

export const NO_LOOPS: Loops = { seq: 0, list: [] }

export const DESC_MAX = 80

/** What is known of a tile when its loop is made for it: its view's title and plugin, and what it shows. */
export interface TileSeen {
  title?: string
  plugin?: string | null
  summary?: string | null
}

/** Whether what a panel holds is a loop's tile: everything is, but the docked chat. */
export function isTile(content: PanelContent): boolean {
  return content.kind !== 'view' || content.view !== CHAT_VIEW
}

/** What a loop is made from when the orchestrator starts one: what it is for, and what its agent is told. */
export interface LoopSpec {
  desc: string
  brief: string
  plugins: string[]
  skills: string[]
}

/** A workspace's loops with one more, made as the orchestrator asked, under the next id: its desc cut. */
export function withLoopAsked(loops: Loops, spec: LoopSpec, now: number): { loops: Loops; loop: Loop } {
  const seq = loops.seq + 1
  const loop: Loop = {
    id: `f${seq}`,
    desc: spec.desc.slice(0, DESC_MAX),
    brief: spec.brief,
    plugins: [...spec.plugins],
    skills: [...spec.skills],
    createdAt: now,
  }
  return { loops: { seq, list: [...loops.list, loop] }, loop }
}

/** The plugin a view came with, by its id: none for a built-in. */
export function viewPlugin(view: string): string | null {
  const [first] = view.split('/')
  return !first || first === 'core' ? null : first
}

/** What an id looks like: f1, f2, … */
export const LOOP_ID = /^f[1-9]\d*$/

/** A loop's number: f3 is 3. */
export function loopNumber(id: string): number {
  return Number(id.slice(1))
}

/**
 * What a loop is called, by the user, by the models, and on its tile: loop_3 for f3. The number is
 * the one its workspace's counter gave it, so a name is never given twice and says nothing of the work.
 */
export function loopName(id: string): string {
  return `loop_${loopNumber(id)}`
}

/** The plugin of the Jaspers deep research agent: its research rooms. */
export const DEEP_RESEARCH_PLUGIN = 'research'

/**
 * Whether a loop shows its conversation under its command line: only a deep research loop does,
 * whose answer is the conversation itself. Any other shows what it found in its views, and says
 * what came of a command in one line.
 */
export function showsChat(loop: Pick<Loop, 'plugins'>): boolean {
  return loop.plugins.includes(DEEP_RESEARCH_PLUGIN)
}

/**
 * A loop's record for a tile nobody asked for one for, under the id given: described by what it shows
 * or else what it is, and told of the plugin its view came with.
 */
function recordFor(id: string, content: PanelContent, seen: TileSeen, now: number): Loop {
  const desc = content.kind === 'view' ? seen.summary || seen.title || content.view : 'No view yet'
  return {
    id,
    desc: desc.slice(0, DESC_MAX),
    brief: '',
    plugins: seen.plugin ? [seen.plugin] : [],
    skills: [],
    createdAt: now,
  }
}

/** A workspace's loops with one more, made for a tile nobody named a loop for, under the next id. */
export function withLoopFor(
  loops: Loops,
  content: PanelContent,
  seen: TileSeen,
  now: number,
): { loops: Loops; loop: Loop } {
  const seq = loops.seq + 1
  const loop = recordFor(`f${seq}`, content, seen, now)
  return { loops: { seq, list: [...loops.list, loop] }, loop }
}

/** What a loop is doing: read off the runs in flight and what is asked on its tiles, never stored, so a restart cannot leave one working that is not. */
export type LoopStatus = 'working' | 'asking' | 'idle'

/** A loop waiting on the user is asking, though its run is in flight then too; one with a run that is not waiting is working. */
export function statusOf(working: boolean, asking: boolean): LoopStatus {
  return asking ? 'asking' : working ? 'working' : 'idle'
}

/**
 * The loop a model or a user names: by its name, loop_3, however it is written (@loop_3, loop 3,
 * Loop #3, loop3), or by its id, f3, which a model may have read in a conversation from before loops
 * had names.
 */
export function named(loops: readonly Loop[], text: string): Loop | undefined {
  const number = /^@?(?:loop[\s_#-]*|f)([1-9]\d*)$/i.exec(text.trim())?.[1]
  return number === undefined ? undefined : loops.find((one) => one.id === `f${number}`)
}

/**
 * The loop a typed message is for, and the message without its address: it starts with that loop's
 * name behind an @, @loop_3, and says something after it. Null when the message is for no loop by
 * name, which leaves it the orchestrator's.
 */
export function addressed(loops: readonly Loop[], input: string): { loop: Loop; message: string } | null {
  const match = /^@loop[_-]?([1-9]\d*)\s+(\S[\s\S]*)$/i.exec(input.trim())
  const loop = match ? loops.find((one) => one.id === `f${match[1]}`) : undefined
  return loop ? { loop, message: match![2]! } : null
}

/** A workspace's loops with one more plugin its agent is told of. The same object when it already is, or there is no such loop. */
export function withPlugin(loops: Loops, loopId: string, plugin: string): Loops {
  const loop = loops.list.find((one) => one.id === loopId)
  if (!loop || loop.plugins.includes(plugin)) return loops
  const told = { ...loop, plugins: [...loop.plugins, plugin] }
  return { ...loops, list: loops.list.map((one) => (one === loop ? told : one)) }
}

/** An element's number: e12 is 12. Elements are numbered as they are made, so the lower is the older. */
function numberOf(element: GridElement): number {
  return Number(element.id.slice(1))
}

/** A loop's frame, in whichever window it is: its tile on a window's own cells, which its other tiles are inside. */
export function frameOf(
  grids: Record<number, Grid>,
  loop: string,
): { window: number; element: GridElement } | undefined {
  for (const window of windowsOf(grids)) {
    const element = grids[window]!.elements.find((e) => e.loop === loop && e.parent === undefined)
    if (element) return { window, element }
  }
  return undefined
}

/** A workspace's window numbers, ascending. */
function windowsOf(grids: Record<number, Grid>): number[] {
  return Object.keys(grids)
    .map(Number)
    .sort((a, b) => a - b)
}

/** A loop's tiles across a workspace's windows, oldest first: its frame, and the tiles inside it. */
export function tilesOf(grids: Record<number, Grid>, loop: string): { window: number; element: GridElement }[] {
  return Object.entries(grids)
    .flatMap(([window, grid]) =>
      grid.elements.filter((e) => e.loop === loop).map((element) => ({ window: Number(window), element })),
    )
    .sort((a, b) => numberOf(a.element) - numberOf(b.element))
}

/** The loops without the ones that have no tile left. The same object when every one has. */
export function withoutTileless(loops: Loops, grids: Record<number, Grid>): Loops {
  const tagged = new Set(Object.values(grids).flatMap((grid) => grid.elements.map((e) => e.loop)))
  const list = loops.list.filter((one) => tagged.has(one.id))
  return list.length === loops.list.length ? loops : { ...loops, list }
}

/**
 * What a workspace's file says its loops are, read with care: a record that is not one is left
 * behind, an id is kept once, open or closed, and the counter is never behind the ids it handed out. A file from before loops could be closed has none
 * closed.
 */
export function readLoops(list: unknown, seq: unknown, closed?: unknown): Loops {
  const kept: Loop[] = []
  for (const raw of Array.isArray(list) ? list : []) {
    const one = readRecord(raw, kept)
    if (one) kept.push(one)
  }
  const shut: ClosedLoop[] = []
  for (const raw of Array.isArray(closed) ? closed : []) {
    if (typeof raw !== 'object' || raw === null) continue
    const one = raw as Record<string, unknown>
    const record = readRecord(one.loop ?? one.flurb, [...kept, ...shut.map((had) => had.loop)])
    const elements = Array.isArray(one.elements) ? one.elements.filter(isElement).map(retagged) : []
    const panels = Array.isArray(one.panels) ? one.panels.filter(isPanel) : []
    const window = typeof one.window === 'number' && Number.isInteger(one.window) && one.window >= 1 ? one.window : 1
    // A closed loop is its frame and what was in it: without the frame there is nothing to reopen.
    const frame = elements[0]
    if (!record || !frame || frame.parent !== undefined) continue
    if (!panels.some((p) => p.elementId === frame.id && p.content.kind === 'frame')) continue
    shut.push({ loop: record, window, elements, panels })
  }
  const ids = [...kept, ...shut.map((one) => one.loop)].map((one) => Number(one.id.slice(1)))
  const highest = Math.max(0, ...ids)
  const counted = typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : 0
  if (kept.length === 0 && shut.length === 0 && counted === 0) return NO_LOOPS
  const read: Loops = { seq: Math.max(counted, highest), list: kept }
  return shut.length > 0 ? { ...read, closed: shut } : read
}

/** One record off disk, or null when it is not one or its id is taken. A name a file from before names were numbered holds is left behind. */
function readRecord(raw: unknown, taken: readonly Loop[]): Loop | null {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []
  if (typeof raw !== 'object' || raw === null) return null
  const one = raw as Record<string, unknown>
  if (typeof one.id !== 'string' || !LOOP_ID.test(one.id) || taken.some((had) => had.id === one.id)) return null
  if (typeof one.desc !== 'string') return null
  const log = Array.isArray(one.log) ? one.log.filter(isChange).map(({ at, change }) => ({ at, change })) : []
  return {
    id: one.id,
    desc: one.desc,
    brief: typeof one.brief === 'string' ? one.brief : '',
    plugins: strings(one.plugins),
    skills: strings(one.skills),
    createdAt: typeof one.createdAt === 'number' ? one.createdAt : 0,
    ...(log.length > 0 ? { log } : {}),
  }
}

/**
 * An element as a file holds it, with its loop's tag where it is now: a file written before loops had
 * their name tags a tile `flurb`. The same object when there is nothing to move.
 */
export function retagged(element: GridElement): GridElement {
  const { flurb, ...rest } = element as GridElement & { flurb?: unknown }
  if (flurb === undefined) return element
  return typeof flurb === 'string' && rest.loop === undefined ? { ...rest, loop: flurb } : rest
}

function isChange(value: unknown): value is LoopChange {
  if (typeof value !== 'object' || value === null) return false
  const one = value as Record<string, unknown>
  return typeof one.at === 'number' && (one.change === 'closed' || one.change === 'reopened')
}

function isElement(value: unknown): value is GridElement {
  if (typeof value !== 'object' || value === null) return false
  const one = value as Record<string, unknown>
  const rect = one.rect as Record<string, unknown> | undefined
  return (
    typeof one.id === 'string' &&
    typeof one.panelId === 'string' &&
    typeof rect === 'object' &&
    rect !== null &&
    ['x', 'y', 'w', 'h'].every((k) => typeof rect[k] === 'number')
  )
}

function isPanel(value: unknown): value is Panel {
  if (typeof value !== 'object' || value === null) return false
  const one = value as Record<string, unknown>
  const content = one.content as Record<string, unknown> | undefined
  return (
    typeof one.id === 'string' &&
    typeof one.elementId === 'string' &&
    typeof content === 'object' &&
    content !== null &&
    (content.kind === 'frame' || (content.kind === 'view' && typeof content.view === 'string'))
  )
}

/**
 * A workspace as it was saved, made whole: every tile has a loop, every loop has one frame, and its
 * other tiles are inside it. A file from before loops, one from when a loop's tiles lay loose on the
 * window, and one a view was dropped from all come through here. The same objects come back when
 * nothing had to change.
 */
export function adopt(
  grids: Record<number, Grid>,
  loops: Loops,
  seen: (panel: Panel) => TileSeen,
  now: number,
): { grids: Record<number, Grid>; loops: Loops } {
  const tagged = everyTileTagged(grids, loops, seen, now)
  const whole = everyTileFramed(tagged.grids)
  const kept = withoutTileless(tagged.loops, whole)
  // A tile carries the tag of a loop the file also has closed only when the file was changed by hand:
  // what is on the grid is the loop, open.
  const open = new Set(kept.list.map((one) => one.id))
  const closed = kept.closed?.filter((one) => !open.has(one.loop.id))
  if (closed === undefined || closed.length === kept.closed!.length) return { grids: whole, loops: kept }
  const { closed: _was, ...rest } = kept
  return { grids: whole, loops: closed.length > 0 ? { ...rest, closed } : rest }
}

/**
 * Every tile with a loop. A tile with no tag gets a loop of its own, in window and then element
 * order; the docked chat loses a tag it should not have. A tile whose tag names no record keeps the
 * tag, and the record is made again under it: its thread and its log are filed under that id, and a
 * file that lost its records (damaged by hand, or written by a build from before them, which keeps
 * the tags) must not hand the conversation to another tile. For the same reason the counter is never
 * behind a tag a tile carries. What is inside a frame is that frame's work, and only a frame has
 * anything inside it; a second frame under one tag is work of its own.
 */
function everyTileTagged(
  grids: Record<number, Grid>,
  loops: Loops,
  seen: (panel: Panel) => TileSeen,
  now: number,
): { grids: Record<number, Grid>; loops: Loops } {
  const carried = Object.values(grids).flatMap((grid) =>
    grid.elements.flatMap((e) => (e.loop !== undefined && LOOP_ID.test(e.loop) ? [Number(e.loop.slice(1))] : [])),
  )
  const highest = Math.max(loops.seq, ...carried)
  let next = highest === loops.seq ? loops : { ...loops, seq: highest }
  const known = new Set(loops.list.map((one) => one.id))
  const framed = new Set<string>()
  const whole: Record<number, Grid> = {}
  let changed = false
  for (const window of windowsOf(grids)) {
    const grid = grids[window]!
    const panelOf = (element: GridElement): Panel | undefined => grid.panels.find((p) => p.elementId === element.id)
    const frames = new Set(grid.elements.filter((e) => panelOf(e)?.content.kind === 'frame').map((e) => e.id))
    let touched = false
    // The window's own first, so what is inside a frame can take the frame's work.
    const own = grid.elements.map((element): GridElement => {
      const panel = panelOf(element)
      const frame = frames.has(element.id)
      if (element.parent !== undefined && frames.has(element.parent) && !frame && panel && isTile(panel.content)) {
        return element
      }
      let one: GridElement = element
      if (one.parent !== undefined) {
        const { parent: _lost, ...out } = one
        one = out
        touched = true
      }
      const tag = one.loop
      if (!panel || !isTile(panel.content)) {
        if (tag === undefined) return one
        touched = true
        const { loop: _dropped, ...bare } = one
        return bare
      }
      // A frame's record is made from what is inside it: that is what the work shows.
      const first = frame ? grid.elements.find((e) => e.parent === element.id) : undefined
      const shown = (first && panelOf(first)) ?? panel
      const taken = frame && tag !== undefined && framed.has(tag)
      if (tag !== undefined && !taken && LOOP_ID.test(tag)) {
        if (!known.has(tag)) {
          next = { ...next, list: [...next.list, recordFor(tag, shown.content, seen(shown), now)] }
          known.add(tag)
        }
      } else {
        const made = withLoopFor(next, shown.content, seen(shown), now)
        next = made.loops
        known.add(made.loop.id)
        one = { ...one, loop: made.loop.id }
        touched = true
      }
      if (frame) framed.add(one.loop!)
      return one
    })
    const tagOf = new Map(own.map((e) => [e.id, e.loop]))
    const elements = own.map((element): GridElement => {
      const tag = element.parent === undefined ? element.loop : tagOf.get(element.parent)
      if (element.loop === tag) return element
      touched = true
      return { ...element, loop: tag }
    })
    whole[window] = touched ? { ...grid, elements } : grid
    changed ||= touched
  }
  return { grids: changed ? whole : grids, loops: next }
}

/**
 * Every loop's tiles inside its frame. A loop whose tiles lie loose on a window gets a frame where
 * they are, in the window of its oldest tile, and they go inside it laid out as they were; a tile of
 * its in another window joins them. A frame is new in every window: its id is past every one the
 * workspace handed out.
 */
function everyTileFramed(grids: Record<number, Grid>): Record<number, Grid> {
  type Found = { window: number; element: GridElement }
  const works = new Map<string, { frame?: Found; loose: Found[] }>()
  for (const window of windowsOf(grids)) {
    const grid = grids[window]!
    for (const element of grid.elements) {
      if (element.loop === undefined || element.parent !== undefined) continue
      const work = works.get(element.loop) ?? { loose: [] }
      works.set(element.loop, work)
      if (grid.panels.find((p) => p.elementId === element.id)?.content.kind === 'frame')
        work.frame = { window, element }
      else work.loose.push({ window, element })
    }
  }
  // The tiles still to go inside a frame: they hold no cells of the window against a frame being made.
  const loose = new Set([...works.values()].flatMap((work) => work.loose.map((one) => one.element.id)))
  if (loose.size === 0) return grids
  const next = { ...grids }
  let seq = Math.max(0, ...Object.values(grids).map((grid) => grid.seq))
  for (const [loop, work] of works) {
    if (work.loose.length === 0) continue
    const tiles = [...work.loose].sort((a, b) => numberOf(a.element) - numberOf(b.element))
    const home = work.frame?.window ?? tiles[0]!.window
    const alone = !work.frame && tiles.length === 1
    let grid = next[home]!
    let frame = work.frame?.element.id
    if (frame === undefined) {
      seq += 1
      frame = `e${seq}`
      const settled = layoutOf(grid).elements.filter((e) => !loose.has(e.id))
      const here = tiles.filter((one) => one.window === home).map((one) => one.element)
      const element = frameFor({ id: frame, panelId: `p${seq}`, loop }, here, alone, settled, grid.size)
      const panel: Panel = {
        id: element.panelId,
        elementId: frame,
        content: { kind: 'frame' },
        state: {},
        output: null,
        summary: null,
        text: null,
        refreshedAt: null,
      }
      grid = { ...grid, elements: [...grid.elements, element], panels: [...grid.panels, panel], seq }
    }
    for (const { window, element } of tiles) {
      const beside = grid.elements.filter((e) => e.parent === frame)
      const joined = insideFrame(restored(element), frame, alone, beside, grid.size)
      loose.delete(element.id)
      if (window === home) {
        grid = { ...grid, elements: grid.elements.map((e) => (e.id === element.id ? joined : e)) }
        continue
      }
      const from = next[window]!
      const panel = from.panels.find((p) => p.elementId === element.id)
      next[window] = {
        ...from,
        elements: from.elements.filter((e) => e.id !== element.id),
        panels: from.panels.filter((p) => p.elementId !== element.id),
        focus: from.focus.filter((id) => id !== element.id),
      }
      grid = { ...grid, elements: [...grid.elements, joined], panels: panel ? [...grid.panels, panel] : grid.panels }
    }
    next[home] = grid
  }
  return next
}

/**
 * The frame for tiles that lay loose on a window. One tile alone hands the frame its place as it is:
 * its cells, and whether it floated, or was maximized or minimized. Several hand it the cells they
 * spanned, tiled. Where those cells are another's the frame takes the nearest that are free, and
 * with none it floats over what is there, since nothing is ever dropped to make room.
 */
function frameFor(
  made: { id: string; panelId: string; loop: string },
  tiles: GridElement[],
  alone: boolean,
  settled: GridElement[],
  size: GridSize,
): GridElement {
  const homes = tiles.map(restored)
  const rect = extent(homes)!
  const base = { ...made, rect, z: Math.max(...tiles.map((e) => e.z)) }
  const only = alone ? tiles[0]! : undefined
  const found =
    homes[0]!.mode === 'floating' && only !== undefined
      ? null
      : rectProblem(rect, size) === null
        ? resolvePlacement(settled, size, { rect })
        : null
  const element: GridElement = found ? { ...base, rect: found.rect, mode: 'tiled' } : { ...base, mode: 'floating' }
  if (only?.mode !== 'maximized' && only?.mode !== 'minimized') return element
  return setMode({ ...EMPTY_GRID, size, elements: [...settled, element] }, made.id, only.mode).element
}

/** A tile that lay loose, inside its frame: where it was when those cells are free there, else the nearest, else floating. */
function insideFrame(
  tile: GridElement,
  frame: string,
  alone: boolean,
  beside: GridElement[],
  size: GridSize,
): GridElement {
  const inside = { ...tile, parent: frame }
  // What a tile alone was, floating or not, its frame is now.
  if (alone) return { ...inside, mode: 'tiled' }
  if (tile.mode === 'floating') return inside
  const found = rectProblem(tile.rect, size) === null ? resolvePlacement(beside, size, { rect: tile.rect }) : null
  return found ? { ...inside, rect: found.rect, mode: 'tiled' } : { ...inside, mode: 'floating' }
}

/** The chat a loop's thread and log are filed under: its workspace's key, then its own id. */
export function loopChat(workspaceId: string, loop: string): string {
  return `${workspaceId}/${loop}`
}

/**
 * What a loop's agent is not offered, of what the global assistant has: arranging the window and
 * what is focused in it, and opening and gathering windows.
 */
export const LOOP_EXCLUDED_TOOLS: readonly string[] = [
  'arrange',
  'focus',
  'open_window',
  'use_all_screens',
  'use_one_screen',
]

/**
 * What the orchestrator is not offered, of what a loop's agent has: what puts a view on the grid,
 * changes what one shows, takes a tile away, or builds a plugin. Work in a tile does those.
 */
export const ORCHESTRATOR_EXCLUDED_TOOLS: readonly string[] = ['place_view', 'set', 'remove_element', 'build_plugin']

/** The built-in note: a text area on the grid. */
export const NOTE_VIEW = 'core/note'

/**
 * Why a loop's agent may not place this view, in words for its model, or null when it may. The note
 * is no agent's to place: a model left to itself writes its status and its findings into one, a call
 * and a view for words that belong in its reply, which the user reads in its tile. The views are for
 * what the plugins show. A note already on the grid is driven and read as any tile is.
 */
export function notPlaced(view: string): string | null {
  if (view !== NOTE_VIEW) return null
  return 'A note is not placed by work: a status, a plan, or a finding is said in your reply, which the user reads in your tile. The views are for what the plugins show.'
}

/**
 * Why a loop's agent may not change this element, in words for its model, or null when it may: the
 * tile is its own. `id` is an element's or a panel's. One that is on no grid answers null too: the
 * tool says that in the words it always has.
 */
export function notOwn(grids: Record<number, Grid>, loops: readonly Loop[], loop: string, id: string): string | null {
  for (const grid of Object.values(grids)) {
    const panel = grid.panels.find((p) => p.id === id || p.elementId === id)
    const element = panel ? grid.elements.find((e) => e.id === panel.elementId) : undefined
    if (!element) continue
    if (element.loop === loop) return null
    const owner = loops.find((one) => one.id === element.loop)
    const whose = owner ? `it belongs to ${loopName(owner.id)}` : 'it is the chat'
    const mine = tilesOf(grids, loop).map((one) => one.element.id)
    return `${element.id} is not one of this work's tiles: ${whose}. Yours are ${mine.join(', ') || 'none'}. Read it with get if that helps; changing it is for its own conversation.`
  }
  return null
}

/** The chats of the loops that were there and are not, open or closed: deleted, or their workspace was. */
export function gone(prev: Record<string, Loops>, next: Record<string, Loops>): string[] {
  return Object.entries(prev).flatMap(([workspaceId, had]) => {
    const now = next[workspaceId]
    const has = new Set([...(now?.list ?? []), ...(now?.closed ?? []).map((one) => one.loop)].map((one) => one.id))
    const all = [...had.list, ...(had.closed ?? []).map((one) => one.loop)]
    return all.filter((one) => !has.has(one.id)).map((one) => loopChat(workspaceId, one.id))
  })
}

/** The chats of the loops that were open and are not: closed, deleted, or their workspace was. What they were doing stops. */
export function shut(prev: Record<string, Loops>, next: Record<string, Loops>): string[] {
  return Object.entries(prev).flatMap(([workspaceId, had]) => {
    const open = new Set((next[workspaceId]?.list ?? []).map((one) => one.id))
    return had.list.filter((one) => !open.has(one.id)).map((one) => loopChat(workspaceId, one.id))
  })
}
