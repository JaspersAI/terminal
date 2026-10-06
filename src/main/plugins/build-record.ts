import fs from 'node:fs'
import path from 'node:path'
import {
  BUILD_RECORD_FILE,
  envelopeOf,
  readBuildRecord,
  widened,
  type BuildRecord,
} from '../../shared/plugins/build-record.ts'
import type { ValidatedPlugin } from '../../shared/plugins/plugins.ts'

// A plugin the assistant built carries the record of what the user approved. It is what makes the
// folder the assistant's rather than the user's own: the app may edit it through the builder,
// holds every build to its envelope, and removes it from Settings.

export function readBuildRecordFile(dir: string): BuildRecord | null {
  try {
    return readBuildRecord(JSON.parse(fs.readFileSync(path.join(dir, BUILD_RECORD_FILE), 'utf8')))
  } catch {
    return null
  }
}

export function writeBuildRecordFile(dir: string, record: BuildRecord): void {
  fs.writeFileSync(path.join(dir, BUILD_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 })
}

/**
 * What is wrong with a build of a folder the assistant built, or null: a connection that runs a
 * command, which no sandbox bounds and the envelope cannot promise anything about, or anything the
 * definition and package.json declare beyond what the user approved. A folder without a record is
 * the user's own and is not checked.
 */
export function checkEnvelope(plugin: ValidatedPlugin, dir: string): string | null {
  const record = readBuildRecordFile(dir)
  if (!record) return null
  for (const [name, connection] of Object.entries(plugin.connections)) {
    if (connection.command) {
      return `${plugin.id} is a plugin the assistant built, which reaches servers over https only; ${name} runs a command. Give it a url instead.`
    }
  }
  const lines = widened(envelopeOf(plugin, dependencyNames(dir)), record.approved)
  if (lines.length === 0) return null
  return `${plugin.id} declares ${lines.join(', ')}, which the user did not approve. Call install_plugin again with it.`
}

/** The names under package.json's dependencies, sorted; none when there is no file or it does not parse. */
export function dependencyNames(dir: string): string[] {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      dependencies?: unknown
    }
    const dependencies = manifest.dependencies
    if (typeof dependencies !== 'object' || dependencies === null) return []
    return Object.keys(dependencies).sort()
  } catch {
    return []
  }
}
