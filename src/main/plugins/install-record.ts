import fs from 'node:fs'
import path from 'node:path'
import { readRecord, type InstallRecord } from '../../shared/plugins/install.ts'

// An installed plugin's folder carries a record of where it came from. It is what makes a plugin
// installed rather than the user's own, which is the one the app may update and remove.

export const RECORD_FILE = '.jaspers-install.json'

export function readInstallRecord(dir: string): InstallRecord | null {
  try {
    return readRecord(JSON.parse(fs.readFileSync(path.join(dir, RECORD_FILE), 'utf8')))
  } catch {
    return null
  }
}

export function writeInstallRecord(dir: string, record: InstallRecord): void {
  fs.writeFileSync(path.join(dir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 })
}
