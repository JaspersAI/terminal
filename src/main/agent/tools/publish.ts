import { notPublished, PUBLISH, publishQuestion } from '../../../shared/hub/assistant-publish'
import { approvedInstall, CANCEL } from '../../../shared/plugins/assistant-install'
import { askUser } from '../../actions'
import { NoHandleError, preparePublish, sendPublish } from '../../hub/publish'
import { publishing } from '../../hub/publishing'
import { askedBy } from '../utils/runs'
import type { Tool, ToolContext } from './types'

// The assistant publishing a plugin or a skill of the user's own to Jaspers Hub, when they ask for
// that. It goes through the same checks and packing the Settings button uses, and asks the user with
// what will be sent in front of them: only their Publish sends, and a closed question, a stopped run,
// or any other answer sends nothing. A scheduled task's run has nobody to say it, so the tools do
// nothing there.

export const publishTools: Tool[] = [
  {
    name: 'publish_plugin',
    description:
      "Publishes or updates a plugin of the user's own on Jaspers Hub when they ask for that: one they wrote in ~/Jaspers/plugins or one the assistant built for them, named by its plugin id. When the plugin is already on Hub under their handle, its version in package.json is raised past the highest published version automatically if it was not raised already. The app checks it and asks the user, showing the id, the version, and where it will be listed; nothing is sent unless they press Publish, and a no is final for this request. Hub keeps the version pending until it is reviewed and lists it once approved. A plugin installed from elsewhere is not the user's to publish. It needs the sign-in with Jaspers, which the user does in Settings.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The plugin id, as Plugins lists it.' },
      },
      required: ['id'],
    },
    async run(input, context) {
      refuseUnattended(context, 'a plugin')
      const id = asId(input.id, 'Name the plugin by its id, as Plugins lists it.')
      const prepared = await preparePublish({ kind: 'plugin', id }, publishing).catch((err: unknown) => {
        if (err instanceof NoHandleError) {
          throw new Error(
            `${err.message} The user claims it in Settings > Plugins, from Publish to Hub on the plugin's page, which asks for it the first time; then ask again.`,
          )
        }
        throw err
      })
      const question = publishQuestion(prepared)
      const answer = await askUser(
        question.text,
        [PUBLISH, CANCEL],
        context.signal,
        question.code,
        askedBy(context.runId),
      )
      if (!approvedInstall(answer, PUBLISH)) return notPublished(id, 'plugin')
      const { handle, version, page } = await sendPublish(prepared, publishing)
      return `Published ${prepared.name} ${version} to Jaspers Hub as ${handle}/${prepared.name}, pending review; once approved it is listed at ${page}. The user can follow the review under Your Hub items in Settings > Plugins.`
    },
  },
  {
    name: 'publish_skill',
    description:
      "Publishes a skill of the user's own to Jaspers Hub when they ask for that: one they wrote or one written for them, named as available_skills lists it, with a version in its SKILL.md frontmatter under metadata. The app checks it and asks the user, showing the name, the version, and where it will be listed; nothing is sent unless they press Publish, and a no is final for this request. Hub keeps the version pending until it is reviewed and lists it once approved. A skill that came with a plugin or was installed from elsewhere is not the user's to publish. It needs the sign-in with Jaspers, which the user does in Settings.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill, as available_skills lists it.' },
      },
      required: ['name'],
    },
    async run(input, context) {
      refuseUnattended(context, 'a skill')
      const name = asId(input.name, 'Name the skill as available_skills lists it.')
      const prepared = await preparePublish({ kind: 'skill', id: name }, publishing).catch((err: unknown) => {
        if (err instanceof NoHandleError) {
          throw new Error(
            `${err.message} The user claims it in Settings > Skills, from Publish to Hub on the skill's page, which asks for it the first time; then ask again.`,
          )
        }
        throw err
      })
      const question = publishQuestion(prepared)
      const answer = await askUser(
        question.text,
        [PUBLISH, CANCEL],
        context.signal,
        question.code,
        askedBy(context.runId),
      )
      if (!approvedInstall(answer, PUBLISH)) return notPublished(name, 'skill')
      const { handle, version, page } = await sendPublish(prepared, publishing)
      return `Published ${prepared.name} ${version} to Jaspers Hub as ${handle}/${prepared.name}, pending review; once approved it is listed at ${page}. The user can follow the review under Your Hub items in Settings > Plugins.`
    },
  },
]

function refuseUnattended(context: ToolContext, what: string): void {
  if (context.task !== undefined) {
    throw new Error(
      `A scheduled task's run cannot publish ${what}: nobody is there to approve it. Tell the user to ask for it in a conversation.`,
    )
  }
}

function asId(value: unknown, message: string): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name) return name
  throw new Error(message)
}
