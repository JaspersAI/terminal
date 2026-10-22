import { TERMS_URL } from '../app/jaspers.ts'
import { HUB_WEB, PUBLISHER_REPRESENTATIONS } from './hub.ts'

// The assistant publishing a plugin or a skill of the user's own to Jaspers Hub. What is checked and
// packed is main's (`publish.ts`); what the user is asked before anything is sent, and how the answer
// is read, is here. The answer is read the strict way an install's is (`assistant-install.ts`): the one
// Publish choice sends, and anything else sends nothing.

export const PUBLISH = 'Publish'

/** What is shown of a plugin or skill before it is sent: its kind, name, and version as Hub reads them, and the handle it is listed under. */
export interface PublishPreview {
  kind?: 'plugin' | 'skill'
  name: string
  version: string
  handle: string
}

/** What the user is asked before a plugin or skill is sent to Hub, and the details shown beside it. */
export function publishQuestion({ kind = 'skill', name, version, handle }: PublishPreview): {
  text: string
  code: string
} {
  const label = kind === 'plugin' ? 'plugin  ' : 'skill   '
  return {
    text: `Publish the ${kind} ${name} ${version} to Jaspers Hub? It is sent as ${handle}/${name} and waits there for review; nothing is sent until you say ${PUBLISH}. By publishing, you agree to the Terms of Use (${TERMS_URL}), ${PUBLISHER_REPRESENTATIONS}`,
    code: [`${label} ${name}`, `version  ${version}`, `page     ${HUB_WEB}/${handle}/${name}`].join('\n'),
  }
}

/** Why nothing was sent, in words for the model: the user did not say Publish, and that is final for this request. */
export function notPublished(name: string, kind: 'plugin' | 'skill' = 'skill'): string {
  return `The user did not approve publishing the ${kind} ${name}, so nothing was sent. Leave it; do not ask again in other words.`
}
