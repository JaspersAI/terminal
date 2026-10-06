import { describeEnvelope, type Envelope } from '../../plugins/build-record.ts'
import { BUILD_LIMITS, sizeText } from './files.ts'

// What the user is asked before a plugin the assistant wrote lands, and what counts as yes. The
// question is short; the code block under it holds the envelope the code will be held to, and then
// the files whole as they stand, because approving what you cannot read is not approving. A plugin
// is installed as a shell and filled in after, so the files are its outline and the question says
// the builder goes on writing them: what a yes covers is the envelope, which the app holds every
// later write to. Only the exact word of the button is a yes: a closed question, a stopped run, a
// timeout, and any other wording are no.

export const APPROVE = 'Build it'
export const ALLOW = 'Allow it'
export const DECLINE = 'No'

export function isApproved(answer: string | null, yes: string): boolean {
  return answer === yes
}

export interface TrustInput {
  id: string
  purpose: string
  envelope: Envelope
  files: { path: string; size: number; content: string }[]
  /** The Jaspers home, so the question says where the folder goes. */
  home: string
}

export interface TrustQuestion {
  text: string
  code: string
  choices: string[]
}

export function trustQuestion(input: TrustInput): TrustQuestion {
  const files = input.files.map((file) => `${file.path} ${sizeText(file.size)}`).join(' · ')
  const head = [
    `${input.id} — ${input.purpose}`,
    '',
    describeEnvelope(input.envelope),
    `Files:         ${files || 'none'}`,
    '',
    '',
  ].join('\n')
  let code = head
  let cut = false
  for (const file of input.files) {
    const block = `--- ${file.path} ---\n${file.content}\n\n`
    if (code.length + block.length > BUILD_LIMITS.shownBytes) {
      code += block.slice(0, Math.max(0, BUILD_LIMITS.shownBytes - code.length))
      cut = true
      break
    }
    code += block
  }
  return {
    text: `Build the plugin ${input.id}? It is written to ${input.home}/plugins/${input.id} and runs in the app. The app holds it to what is listed below, and the builder may go on writing its files after you approve.`,
    code: cut ? `${code.trimEnd()}\n… (cut)` : code.trimEnd(),
    choices: [APPROVE, DECLINE],
  }
}

/** A plugin already approved wants more: only what is new is shown, each line as `widened` gave it. */
export function widenQuestion(id: string, lines: string[]): TrustQuestion {
  return {
    text: `Let the plugin ${id} reach more than it was approved for?`,
    code: lines.map((line) => `+ ${line}`).join('\n'),
    choices: [ALLOW, DECLINE],
  }
}
