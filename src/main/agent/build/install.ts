import {
  ALLOW,
  APPROVE,
  DECLINE,
  isApproved,
  trustQuestion,
  widenQuestion,
  type TrustQuestion,
} from '../../../shared/agent/build/trust.ts'
import {
  EMPTY_ENVELOPE,
  envelopeFromInput,
  widened,
  type BuildRecord,
  type Envelope,
} from '../../../shared/plugins/build-record.ts'
import type { PluginInfo } from '../../../shared/state.ts'
import { readBuildRecordFile, writeBuildRecordFile } from '../../plugins/build-record.ts'
import { fileContents, type BuildFolder } from './folder.ts'

// install_plugin: the one place a plugin the assistant wrote is put in front of the user. The first
// time, the question shows the envelope and the files whole, and a yes writes the record, installs
// the packages, and moves the folder into plugins/, where the watcher builds it. Later, a call
// within the approved envelope only rebuilds; one reaching wider shows what is new, and a yes widens
// the record. A no is final for the run; words the user typed in place of a button approve nothing
// and go back to the builder to follow. What touches the app (asking, the tree, the packages) is
// handed in, so a test drives the gate.

const PURPOSE_MAX = 200

export interface InstallDeps {
  /** The Jaspers home, for the question's wording. */
  home: string
  /** Puts the question to the user and answers with what they chose, or null when nobody answered. */
  ask(question: TrustQuestion): Promise<string | null>
  land(folder: BuildFolder): Promise<BuildFolder>
  rebuild(id: string): void
  /** Waits for the plugin's build to settle and answers its entry. */
  wait(id: string): Promise<PluginInfo>
  installPackages(dir: string, specs: string[]): Promise<void>
  now(): string
}

export async function installPlugin(
  folder: BuildFolder,
  input: Record<string, unknown>,
  request: string,
  deps: InstallDeps,
): Promise<{ folder: BuildFolder; info: PluginInfo }> {
  const purpose = typeof input['purpose'] === 'string' ? input['purpose'].trim() : ''
  if (!purpose || purpose.length > PURPOSE_MAX) {
    throw new Error(`purpose is one line, up to ${PURPOSE_MAX} characters, saying what the plugin is for.`)
  }
  const { envelope, packageSpecs } = envelopeFromInput(input)
  const files = await fileContents(folder)
  if (!files.some((file) => file.path === 'plugin.tsx')) throw new Error('Write plugin.tsx first: nothing to install.')

  if (!folder.live) {
    const answer = await deps.ask(trustQuestion({ id: folder.id, purpose, envelope, files, home: deps.home }))
    if (!isApproved(answer, APPROVE)) {
      throw new Error(
        wrote(answer, DECLINE) ??
          `The user did not approve building ${folder.id}. Say what you wanted to build and stop.`,
      )
    }
    const record: BuildRecord = { purpose, request, at: deps.now(), approved: envelope }
    writeBuildRecordFile(folder.dir, record)
    if (packageSpecs.length > 0) await deps.installPackages(folder.dir, packageSpecs)
    const live = await deps.land(folder)
    return { folder: live, info: await deps.wait(live.id) }
  }

  const record = readBuildRecordFile(folder.dir) ?? { purpose, request, at: deps.now(), approved: EMPTY_ENVELOPE }
  const lines = widened(envelope, record.approved)
  if (lines.length > 0) {
    const answer = await deps.ask(widenQuestion(folder.id, lines))
    if (!isApproved(answer, ALLOW)) {
      throw new Error(
        wrote(answer, DECLINE) ??
          `The user did not allow ${folder.id} to reach more: ${lines.join(', ')}. Keep to what was approved, or stop.`,
      )
    }
    writeBuildRecordFile(folder.dir, { ...record, purpose, approved: union(record.approved, envelope) })
    const fresh = packageSpecs.filter((spec) => !record.approved.packages.includes(nameOf(spec)))
    if (fresh.length > 0) await deps.installPackages(folder.dir, fresh)
  }
  deps.rebuild(folder.id)
  return { folder, info: await deps.wait(folder.id) }
}

/**
 * What to tell the builder when the user typed words of their own in place of a button: nothing is
 * approved, since only the button's word is a yes, but the words are theirs to follow, often a change
 * they want before they approve. Null for the no button or a closed question, which stop the build.
 */
function wrote(answer: string | null, no: string): string | null {
  const words = answer?.trim() ?? ''
  if (!words || words === no) return null
  return `Nothing was installed: in place of an answer the user wrote ${JSON.stringify(words)}. Do as it says if you can, then call install_plugin again to ask them, since only the button approves; if you cannot, say why and stop.`
}

/** What was approved before and what is asked now, together: an edit never narrows the record on its own. */
function union(approved: Envelope, wanted: Envelope): Envelope {
  const merge = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])].sort()
  return {
    hosts: merge(approved.hosts, wanted.hosts),
    capabilities: merge(approved.capabilities, wanted.capabilities),
    secrets: merge(approved.secrets, wanted.secrets),
    connections: merge(approved.connections, wanted.connections),
    packages: merge(approved.packages, wanted.packages),
    frames: merge(approved.frames, wanted.frames),
  }
}

/** The package name of a spec: everything before the version's @, with a scope's own @ kept. */
function nameOf(spec: string): string {
  return spec.startsWith('@') ? `@${spec.slice(1).split('@')[0]}` : spec.split('@')[0]!
}
