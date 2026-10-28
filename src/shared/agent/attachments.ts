// Attached files in a conversation turn: how they are wrapped for the model, summarized for the
// chat bubble and log, and taken out when reading what the user typed. Pure.

export interface AttachedFile {
  name: string
  text: string
}

const ATTACHED_BLOCK = /<attached_file\b[^>]*>[\s\S]*?<\/attached_file>/g
const ATTACHED_OPEN = /<attached_file\b([^>]*)>/g
const NAME_ATTR = /\bname="([^"]*)"/

/**
 * Wraps each attached file in a sealed `<attached_file name="...">` block and appends the blocks
 * after the user's message, or returns the blocks alone when no message was typed.
 */
export function withAttachments(text: string, files: readonly AttachedFile[]): string {
  const trimmed = text.trim()
  if (files.length === 0) return trimmed
  const blocks = files.map(
    (file) => `<attached_file name="${escapeAttribute(cleanName(file.name))}">\n${sealed(file.text)}\n</attached_file>`,
  )
  return [trimmed, ...blocks].filter(Boolean).join('\n\n')
}

/** A user turn with every `<attached_file>` block taken out. */
export function stripAttachedFiles(text: string): string {
  return text.replace(ATTACHED_BLOCK, '')
}

/** Separates the user's prompt text from any `<attached_file>` blocks in the turn. */
export function splitAttachments(text: string): { text: string; attachments: string[] } {
  const attachments = text.match(ATTACHED_BLOCK) ?? []
  return { text: stripAttachedFiles(text).trim(), attachments }
}

/** The file names from every `<attached_file>` block in a turn, in order. */
export function attachedFileNames(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(ATTACHED_OPEN)) {
    const attr = NAME_ATTR.exec(match[1] ?? '')?.[1]
    if (attr !== undefined) names.push(unescapeAttribute(attr))
  }
  return names
}

/**
 * What the chat bubble and log show for a question: the user's words and `[Attached: ...]` in place
 * of any `<attached_file>` blocks.
 */
export function shownQuestion(text: string): string {
  const names = attachedFileNames(text)
  if (names.length === 0) return text
  const body = stripAttachedFiles(text).trim()
  const line = `[Attached: ${names.join(', ')}]`
  return body ? `${body}\n${line}` : line
}

function cleanName(name: string): string {
  return name.replace(/[\r\n\0]+/g, ' ').trim() || 'attachment'
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function unescapeAttribute(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

/** A file's own text cannot close `<attached_file>` early or open `<skill_content>` / `<skill_resources>`. */
function sealed(text: string): string {
  return text.replace(/<(\/?)(attached|skill)_(file|content|resources)/gi, '<$1$2-$3')
}
