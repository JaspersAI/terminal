// What the assistant knows about you: one fact a file, in Markdown, in a folder you can open.
//
// The same three tiers a skill uses, for the same reason. The prompt carries each memory's name and
// one line saying what it is about, so a hundred of them cost a hundred short lines; the body is
// read with a tool when the line looks relevant. A memory is not a skill: a skill is how to do a
// kind of work, a memory is something that is true.

/** A name is a file name, so it is kept to what reads and sorts plainly. */
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const NAME_MAX = 64
export const ABOUT_MAX = 200
export const BODY_MAX = 4000
/** Memories in the prompt's index. Past this the newest are listed and the rest are counted. */
export const INDEX_MAX = 60

/** A memory as the tree and the prompt know it: what it is called and what it is about, never its body. */
export interface MemoryInfo {
  /** The file name without .md, which is how a tool names it. */
  name: string
  /** One line: what this is about, which is all the prompt carries. */
  about: string
  at: number
}

/** A memory read off disk, body and all. Main's, and what a tool answers with. */
export interface Memory extends MemoryInfo {
  body: string
}

export function isMemoryName(name: string): boolean {
  return NAME.test(name) && name.length <= NAME_MAX
}

/** What is wrong with a memory the assistant is trying to write, or null. */
export function checkMemory(name: string, about: string, body: string): string | null {
  if (!isMemoryName(name)) return 'A name is lower case letters, digits, and single hyphens, like figures-in-millions.'
  if (!about.trim())
    return 'Say in one line what this is about; that line is what you will see later when deciding whether to read it.'
  if (about.length > ABOUT_MAX)
    return `That line is longer than ${ABOUT_MAX} characters. It is an index entry, not the memory itself.`
  if (!body.trim()) return 'Write the memory itself.'
  if (body.length > BODY_MAX) return `A memory is at most ${BODY_MAX} characters. Keep what is true and drop the rest.`
  return null
}

/** The file a memory is written as. Frontmatter for the one line, Markdown for the rest. */
export function memoryFile(about: string, body: string): string {
  return `---\nabout: ${about.replace(/\n/g, ' ').trim()}\n---\n\n${body.trim()}\n`
}

/** A memory read back off disk. A file without frontmatter is still a memory; its first line says what it is about. */
export function parseMemory(name: string, text: string, at: number): Memory {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (match) {
    const about = /^about:\s*(.*)$/m.exec(match[1] ?? '')?.[1]?.trim() ?? ''
    const body = normalized.slice(match[0].length).trim()
    return { name, about: about || firstLine(body), body, at }
  }
  const body = normalized.trim()
  return { name, about: firstLine(body), body, at }
}

function firstLine(body: string): string {
  return (body.split('\n').find((line) => line.trim()) ?? '').trim().slice(0, ABOUT_MAX)
}

/**
 * The index the prompt carries: every memory's name and what it is about, newest first, and nothing
 * at all when there are none.
 */
export function memoryIndex(memories: MemoryInfo[]): string {
  if (memories.length === 0) return ''
  const newest = [...memories].sort((a, b) => b.at - a.at)
  const shown = newest.slice(0, INDEX_MAX)
  const rest = newest.length - shown.length
  return [
    'What you know about this user, from earlier. Read one with recall { name } when its line looks like it bears on the request; write one with remember { name, about, text } when the user tells you something worth keeping, like a preference or a fact about how they work. Do not read them all.',
    ...shown.map((one) => `- ${one.name}: ${one.about}`),
    ...(rest > 0 ? [`… and ${rest} more; get memories lists them.`] : []),
  ].join('\n')
}
