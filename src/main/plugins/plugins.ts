import { app } from 'electron'
import type * as esbuild from 'esbuild'
import { bundlePlugin } from './bundle'
import { checkEnvelope, readBuildRecordFile } from './build-record'
import fs from 'node:fs'
import path from 'node:path'
import { describeSource } from '../../shared/plugins/install'
import type { ValidatedPlugin } from '../../shared/plugins/plugins'
import { evaluatePlugin } from './plugin-eval'
import { removeHost, startHost } from './plugin-host'
import type { PluginInfo } from '../../shared/state'
import { registerConnections, secretValues, unregisterConnections } from './connections'
import { useUnpackedEsbuild } from './esbuild-path'
import { pluginRoots } from '../home'
import { readInstallRecord } from './install-record'
import { setPluginInfo } from './plugin-info'
import { registerPlugin, unregisterPlugin, type ViewDef } from './registry'
import { registerPluginSkills, unregisterPluginSkills } from '../skills/skills'
import { getState, update } from '../state'

// A plugin is a folder with plugin.tsx. It is bundled twice: once as ESM for the browser, which is
// what the view host will load into an iframe, and once as CJS for Node, which is evaluated here so
// main learns what the plugin defines. The definitions half runs in a vm context with a require
// shim and a timeout: the code is not the app's, so a bad plugin is an error in the tree rather
// than a crash, and a broken rebuild leaves the last good registration alone. A plugin brings its
// connections with it: they are registered before its sources and leave with it, so nothing offers
// a source on a server the plugin no longer declares. Its skills/ folder is Markdown, read on every
// build whether or not the code builds, and on its own when only a skill changed.

/** An editor's save lands as several events; wait for them to stop before rebuilding. */
const WATCH_DELAY_MS = 200

const watchers: fs.FSWatcher[] = []
const timers = new Map<string, NodeJS.Timeout>()
/** Plugins with a change outside skills/ since their last rescan: those rebuild, the rest only read their skills. */
const codeChanged = new Set<string>()
/** One build at a time per plugin, so two saves in a row cannot register out of order. */
const queue = new Map<string, Promise<void>>()

/** Finds every plugin, builds it, and watches for changes. Once, at startup. */
export function startPlugins(): void {
  // Before the first build loads esbuild: a packaged app has to be told where its binary is.
  useUnpackedEsbuild()
  for (const [id, dir] of discover()) void load(id, dir)
  watch()
}

/** Where the built browser bundle for a plugin goes. Stage 4 serves it to the iframe from here. */
export function bundlePath(id: string): string {
  return path.join(app.getPath('userData'), 'cache', 'plugins', id, 'bundle.js')
}

/**
 * A plugin folder, from its file to its registration. Failure at any step keeps whatever was
 * registered before and says why, since a half-written file is the usual reason to be here.
 */
function load(id: string, dir: string): Promise<void> {
  const next = (queue.get(id) ?? Promise.resolve()).then(() => build(id, dir))
  queue.set(id, next)
  return next
}

async function build(id: string, dir: string): Promise<void> {
  begin(id, dir)
  registerPluginSkills(id, dir)
  try {
    const code = await bundlePlugin(dir, bundlePath(id))
    const validated = evaluatePlugin(code, id)
    // A plugin the assistant built is held to what the user approved: anything wider is this build's
    // error, and the last good registration stays, as after any failed build.
    const refused = checkEnvelope(validated, dir)
    if (refused) throw new Error(refused)
    // Its connections first, so a source's line in the prompt finds the connection it runs on.
    registerConnections(id, dir, validated.connections)
    registerPlugin(id, validated.sources, viewDefs(validated))
    const version = (getState().plugins[id]?.version ?? 0) + 1
    const values = secretValues(id)
    setPluginInfo(id, {
      status: 'ready',
      version,
      sources: Object.keys(validated.sources).map((name) => `${id}/${name}`),
      views: Object.keys(validated.views).map((name) => `${id}/${name}`),
      errors: [],
      capabilities: validated.capabilities,
      frames: validated.frames,
      secrets: Object.entries(validated.secrets).map(([key, { label }]) => ({
        key,
        label,
        set: values[key] !== undefined,
      })),
      connections: Object.keys(validated.connections).map((name) => `${id}/${name}`),
    })
    console.log(`plugins: ${id} ready (v${version})`)
    // Code the plugin runs after registration runs in its own process, on this build: from now when
    // the plugin defines start, and from its first source run when it does not.
    if (validated.hasBackend)
      await startHost(id, { code, dir, capabilities: validated.capabilities, eager: validated.start !== null })
    else await removeHost(id, 'the plugin has no code of its own to run')
  } catch (err) {
    const errors = messages(err)
    setPluginInfo(id, { status: 'error', errors })
    console.warn(`plugins: ${id} ${errors[0]}`)
  }
}

/** A plugin's views as the registry holds them: prefixed ids, and renders read back as ids. */
function viewDefs(validated: ValidatedPlugin): ViewDef[] {
  const idOf = new Map<unknown, string>(
    Object.entries(validated.sources).map(([name, def]) => [def, `${validated.id}/${name}`]),
  )
  return Object.entries(validated.views).map(([name, view]) => ({
    id: `${validated.id}/${name}`,
    plugin: validated.id,
    title: view.title,
    state: view.state,
    output: view.output,
    instructions: view.instructions,
    // Validation has already checked that every entry is one of this plugin's own sources.
    renders: (view.renders ?? []).map((ref) => idOf.get(ref)!),
    summarize: view.summarize,
  }))
}

/** Every plugin folder, the user's before the app's own, which is how one shadows the other. */
function discover(): Map<string, string> {
  const found = new Map<string, string>()
  for (const root of pluginRoots()) {
    let names: string[] = []
    try {
      names = fs.readdirSync(root).sort()
    } catch {
      continue
    }
    for (const name of names) {
      if (ignored(name)) continue
      const dir = path.join(root, name)
      if (!fs.existsSync(path.join(dir, 'plugin.tsx'))) continue
      if (found.has(name)) {
        console.warn(`plugins: ${dir} is shadowed by ${found.get(name)}`)
        continue
      }
      found.set(name, dir)
    }
  }
  return found
}

/** Every root is watched whole: a plugin is a folder, and anything in it can change what it builds to. */
function watch(): void {
  for (const root of pluginRoots()) {
    try {
      watchers.push(
        fs.watch(root, { recursive: true }, (_event, filename) => {
          if (!filename) return
          // The folder name is the plugin id, whatever changed inside it.
          const segments = filename.split(path.sep)
          const id = segments[0]
          if (!id || ignored(id) || filename.includes('node_modules')) return
          if (segments[1] !== 'skills') codeChanged.add(id)
          const waiting = timers.get(id)
          if (waiting) clearTimeout(waiting)
          timers.set(
            id,
            setTimeout(() => {
              timers.delete(id)
              if (codeChanged.delete(id)) rescan(id)
              else rescanSkills(id)
            }, WATCH_DELAY_MS),
          )
        }),
      )
    } catch {
      // A root that is not there (the app's own, when it runs from somewhere else) is not watched.
    }
  }
}

/** One folder changed: build what is there now, or let go of what is not. */
function rescan(id: string): void {
  const dir = discover().get(id)
  if (dir) void load(id, dir)
  // Behind any build still running, so a build that finishes late cannot bring a removed plugin back.
  else if (getState().plugins[id])
    queue.set(
      id,
      (queue.get(id) ?? Promise.resolve()).then(() => remove(id)),
    )
}

/** Only a plugin's skills/ changed: read its skills again and leave its build alone. */
function rescanSkills(id: string): void {
  const dir = discover().get(id)
  if (dir && getState().plugins[id]) registerPluginSkills(id, dir)
  else rescan(id)
}

function remove(id: string): void {
  unregisterPlugin(id)
  unregisterConnections(id)
  unregisterPluginSkills(id)
  void removeHost(id, 'plugin removed')
  update((state) => {
    if (!state.plugins[id]) return state
    const plugins = { ...state.plugins }
    delete plugins[id]
    return { ...state, plugins }
  })
  console.log(`plugins: ${id} removed`)
}

/** A build starts: the plugin is in the tree from here on, and keeps what it had until one lands. */
function begin(id: string, dir: string): void {
  update((state) => {
    const previous = state.plugins[id]
    const info: PluginInfo = previous
      ? { ...previous, dir, ...provenance(dir), status: 'building' }
      : {
          id,
          dir,
          ...provenance(dir),
          status: 'building',
          version: 0,
          sources: [],
          views: [],
          errors: [],
          capabilities: [],
          frames: [],
          secrets: [],
          connections: [],
          skills: [],
          host: 'none',
          jobs: [],
          usage: { calls: 0, input: 0, output: 0 },
        }
    return { ...state, plugins: { ...state.plugins, [id]: info } }
  })
}

/** Whether a plugin folder was built by the assistant, installed from a source, or is the user's own. */
function provenance(dir: string): Pick<PluginInfo, 'origin' | 'install' | 'built'> {
  const built = readBuildRecordFile(dir)
  if (built) return { origin: 'built', install: null, built: { purpose: built.purpose, at: built.at } }
  const record = readInstallRecord(dir)
  return {
    origin: record ? 'installed' : 'local',
    install: record
      ? {
          source: describeSource(record.source),
          updatable: record.source.kind !== 'file',
          version: record.version,
          installedAt: record.installedAt,
        }
      : null,
    built: null,
  }
}

/** Builds a folder again now: after packages were installed into it, which the watcher does not see. */
export function rebuildPlugin(id: string): void {
  rescan(id)
}

/** esbuild says where it stopped; everything else says what it said. */
function messages(err: unknown): string[] {
  const errors = (err as { errors?: esbuild.Message[] }).errors
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((e) =>
      e.location ? `${e.location.file}:${e.location.line}:${e.location.column} ${e.text}` : e.text,
    )
  }
  return [err instanceof Error ? err.message : String(err)]
}

function ignored(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules'
}
