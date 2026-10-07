import { HUB_WEB } from './hub.ts'

// The assistant publishing a skill of the user's own to Jaspers Hub. What is checked and packed is
// main's (`publish.ts`); what the user is asked before anything is sent, and how the answer is read,
// is here. The answer is read the strict way an install's is (`assistant-install.ts`): the one
// Publish choice sends, and anything else sends nothing.

export const PUBLISH = 'Publish'

/** What is shown of a skill before it is sent: its name and version as Hub reads them, and the handle it is listed under. */
export interface PublishPreview {
  name: string
  version: string
  handle: string
}

/** What the user is asked before a skill is sent to Hub, and the details shown beside it. */
export function publishQuestion({ name, version, handle }: PublishPreview): { text: string; code: string } {
  return {
    text: `Publish the skill ${name} ${version} to Jaspers Hub? It is sent as ${handle}/${name} and waits there for review; nothing is sent until you say ${PUBLISH}.`,
    code: [`skill    ${name}`, `version  ${version}`, `page     ${HUB_WEB}/${handle}/${name}`].join('\n'),
  }
}

/** Why nothing was sent, in words for the model: the user did not say Publish, and that is final for this request. */
export function notPublished(name: string): string {
  return `The user did not approve publishing the skill ${name}, so nothing was sent. Leave it; do not ask again in other words.`
}
