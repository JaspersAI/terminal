import fs from 'node:fs'
import path from 'node:path'
import { readSkillRecordData, type SkillInstallRecord } from '../../shared/skills/skill-install.ts'
import { RECORD_FILE } from '../plugins/install-record.ts'

// An installed skill's folder carries a record of where it came from, under the same name a plugin's
// does. It is what makes a skill installed rather than the user's own.

export function readSkillRecord(dir: string): SkillInstallRecord | null {
  try {
    return readSkillRecordData(JSON.parse(fs.readFileSync(path.join(dir, RECORD_FILE), 'utf8')))
  } catch {
    return null
  }
}

export function writeSkillRecord(dir: string, record: SkillInstallRecord): void {
  fs.writeFileSync(path.join(dir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 })
}
