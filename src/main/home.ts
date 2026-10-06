import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Where the user's own plugins and skills live: ~/Jaspers/plugins and ~/Jaspers/skills, or under
// wherever JASPERS_HOME points, so a driven run can work in a sandbox without touching the real one.
// That folder is the only place plugins come from: the official ones are installed from their own
// repos like any other.

export function jaspersHome(): string {
  return process.env['JASPERS_HOME'] || path.join(os.homedir(), 'Jaspers')
}

/** The user's plugin folders, and where an install lands. */
export function homePluginsRoot(): string {
  return path.join(jaspersHome(), 'plugins')
}

/** The user's skills: their own folders and the ones installed. */
export function homeSkillsRoot(): string {
  return path.join(jaspersHome(), 'skills')
}

/** What Eye records: a folder per session, each holding its frames and its telemetry. */
export function eyeRoot(): string {
  return path.join(jaspersHome(), 'data', 'eye')
}

/** Where an install is fetched and checked before it moves into place: outside the plugins folder. */
export function installRoot(): string {
  return path.join(jaspersHome(), '.install')
}

/** Where the assistant writes a plugin before the user approves it: outside the plugins folder, so nothing of it is built or run. */
export function buildRoot(): string {
  return path.join(jaspersHome(), '.build')
}

/** Where plugin folders are read from. Created on demand so the folder is findable. */
export function pluginRoots(): string[] {
  const home = homePluginsRoot()
  try {
    fs.mkdirSync(home, { recursive: true })
  } catch (err) {
    console.warn(`home: could not create ${home}:`, err)
  }
  return [home]
}
