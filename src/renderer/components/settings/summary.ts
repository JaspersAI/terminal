import type { ConnectionInfo, PluginInfo, SkillInfo } from '../../../shared/state'
import { everyText, shortLocal, taskStatus, type Task, type TaskStatus } from '../../../shared/tasks/tasks.ts'

// What a row in a Settings list says of its entry, in one short line, and which entry a split list
// shows. Pure, so a test reads it.

/** The second line of a plugin's row: where it came from, and the one thing most worth knowing now. */
export function pluginLine(
  plugin: PluginInfo,
  connections: ConnectionInfo[],
): { version: string; status: string; alert: boolean } {
  const version = plugin.install?.version ?? 'local'
  const has = (status: ConnectionInfo['status']): boolean => connections.some((c) => c.status === status)
  const say = (status: string, alert: boolean): { version: string; status: string; alert: boolean } => ({
    version,
    status,
    alert,
  })
  // A host that exited leaves the build standing and says why in errors.
  if (plugin.status === 'error' || plugin.errors.length > 0) return say('Error', true)
  if (has('error')) return say('Connection error', true)
  if (has('needs-secret')) return say('Needs a key', true)
  if (has('needs-auth')) return say('Needs authorization', true)
  if (has('needs-sign-in')) return say('Needs sign-in', true)
  if (plugin.status === 'building') return say('Building', false)
  if (has('connecting')) return say('Connecting', false)
  const jobs = plugin.jobs.length
  if (jobs > 0) return say(`${jobs} ${jobs === 1 ? 'job' : 'jobs'} running`, false)
  return say('Ready', false)
}

export const TASK_STATUS: Record<TaskStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  scheduled: 'Scheduled',
  done: 'Done',
  failed: 'Failed',
}

/** The second line of a task's row: where it stands, and how often it runs. */
export function taskLine(task: Task, now: number, timeZone: string): { status: string; when: string; alert: boolean } {
  const status = taskStatus(task)
  return {
    status: TASK_STATUS[status],
    when:
      task.every === null ? `once at ${shortLocal(task.executeAt, now, timeZone)}` : `every ${everyText(task.every)}`,
    alert: status === 'failed',
  }
}

/**
 * The entry a split list shows: the one picked while it is still in the list, else the first. Not
 * picked means the narrow layout shows the list rather than an entry.
 */
export function shownEntry(open: string | null, ids: readonly string[]): { id: string | null; picked: boolean } {
  if (open !== null && ids.includes(open)) return { id: open, picked: true }
  return { id: ids[0] ?? null, picked: false }
}

/** A skill by the /name that loads it, or by its id when /name would not. */
export function skillTitle(skill: SkillInfo): string {
  return skill.userInvocable && skill.error === null ? `/${skill.id}` : skill.id
}
