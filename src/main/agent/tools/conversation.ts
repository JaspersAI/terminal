import { cap } from '../../../shared/agent/prompt'
import { askUser, requestSecret, setSecret, waitForSecret } from '../../actions'
import { askedBy } from '../utils/runs'
import type { Tool } from './types'
import { asPathString } from './input'

export const conversationTools: Tool[] = [
  {
    name: 'ask_user',
    description:
      'Ask the user one short question and wait for the answer, when the request is ambiguous in a way you cannot settle by looking. Use it rather than guessing between two readings; do not use it for anything you can find out with get, query, or a source. Offer choices when there are a few obvious ones; they may write their own instead. Answers with what they said, or says they closed it.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: "One sentence. What you need to know, in the user's terms." },
        choices: {
          type: 'array',
          items: { type: 'string' },
          description: 'A few answers to offer as buttons. Optional.',
        },
      },
      required: ['question'],
    },
    async run(input, { signal, runId }) {
      const question = asPathString(input.question).trim()
      if (!question) throw new Error('Ask something.')
      const choices = Array.isArray(input.choices)
        ? input.choices.filter((one): one is string => typeof one === 'string' && one.trim() !== '').slice(0, 5)
        : []
      const answer = await askUser(cap(question, 300), choices, signal, undefined, askedBy(runId))
      return answer === null
        ? 'The user closed the question without answering. Carry on with what you have, or say what you need.'
        : answer
    },
  },
  {
    name: 'set_secret',
    description:
      "Ask the user for a credential a plugin needs, when one of its connections is needs-secret. The app opens a secure field and this call waits until the user saves or cancels and the plugin's connections settle; the value never passes through you. When it returns ready, carry on with what the user asked: the connections' sources are in your tools from the next step. With value, stores a value the user already pasted into the chat, and waits the same way.",
    parameters: {
      type: 'object',
      properties: {
        plugin: {
          type: 'string',
          description: 'The plugin id, as the Connections line names it: set_secret { plugin, key }.',
        },
        key: { type: 'string', description: 'The secret key the plugin declares, from the same line.' },
        value: {
          type: 'string',
          description: 'Only when the user already gave the value in the chat. Leave it out to ask.',
        },
      },
      required: ['plugin', 'key'],
    },
    async run(input, { userSaid }) {
      const plugin = asName(input.plugin, 'plugin')
      const key = asName(input.key, 'key')
      // Models fill in a value they were never given (a placeholder, the key's name). A value is
      // stored only when the user typed it; anything else opens the field, as leaving it out does.
      const value = typeof input.value === 'string' ? input.value.trim() : ''
      if (value.length >= 8 && userSaid(value)) setSecret(plugin, key, value)
      else requestSecret(plugin, key)
      const outcome = await waitForSecret(plugin, key)
      switch (outcome.kind) {
        case 'cancelled':
          return `The user closed the field without saving ${key} for ${plugin}. Its connections stay unavailable; say so, and do not ask again unless they want to.`
        case 'timeout':
          return `The user has not answered yet; the field for ${key} is still open. Say that ${plugin} is waiting for its key and what you will do once it is in.`
        case 'waiting':
          return `Saved ${key}; ${plugin}'s connections are still connecting. They retry on their own; tell the user.`
        case 'settled': {
          if (outcome.connections.length === 0) return `Saved ${key}; no connection was waiting on it.`
          const lines = outcome.connections.map((c) =>
            c.status === 'ready'
              ? `${c.id} is ready with tools ${c.tools.join(', ')}.`
              : `${c.id} is ${c.status}${c.error ? `: ${c.error}` : ''}.`,
          )
          const ready = outcome.connections.some((c) => c.status === 'ready')
          return `Saved. ${lines.join(' ')} ${ready ? "Carry on with the user's request now; its sources are in your tools from the next step." : 'It retries on its own; tell the user.'}`
        }
      }
    },
  },
]

function asName(value: unknown, what: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error(`${what} must be a name, as the Connections line gives it.`)
}
