import type { SkillInfo } from '../state'

// A skill for tests to put in a tree. Only tests import this; the runner's glob is *.test.ts, so
// importing it runs no test twice.

/** A usable skill: the user's own, or a plugin's when the id has a colon. */
export function skill(id: string, over: Partial<SkillInfo> = {}): SkillInfo {
  const colon = id.indexOf(':')
  return {
    id,
    name: id.slice(colon + 1),
    description: `What ${id} does.`,
    plugin: colon < 0 ? null : id.slice(0, colon),
    origin: colon < 0 ? 'local' : 'plugin',
    modelInvocable: true,
    userInvocable: true,
    argumentHint: null,
    arguments: [],
    license: null,
    compatibility: null,
    allowedTools: [],
    files: [],
    warnings: [],
    error: null,
    install: null,
    ...over,
  }
}
