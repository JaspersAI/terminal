import { CollabError, readCommand, readManifest, readState, type CollabApi } from './wire.ts'

// Jaspers Account's /v1/collab, as calls. Every request goes out as the signed-in account (`send`)
// and names this terminal (`X-Jaspers-Client`): the account may run several, and only the one that
// holds a room writes it.

type Send = (url: string, init?: RequestInit) => Promise<Response>

export const CLIENT_HEADER = 'x-jaspers-client'

export function collabApi(base: () => string, send: Send, clientId: string): CollabApi {
  async function call(path: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
    const response = await send(`${base()}/collab${path}`, {
      method,
      headers: { [CLIENT_HEADER]: clientId, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    let answer: unknown = null
    try {
      answer = text ? JSON.parse(text) : {}
    } catch {
      // Not JSON: a gateway's page. The status says the rest.
    }
    const record = typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {}
    if (response.ok) return record
    const error =
      typeof record.error === 'object' && record.error !== null ? (record.error as Record<string, unknown>) : {}
    throw new CollabError(
      typeof error.code === 'string' ? error.code : `http_${response.status}`,
      typeof error.message === 'string' ? error.message : `Jaspers answered ${response.status}.`,
    )
  }

  const idOf = (answer: Record<string, unknown>, field: string): string => {
    const inner = answer[field]
    const id = typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>)[`${field}_id`] : null
    if (typeof id === 'string' && id) return id
    throw new CollabError('invalid', 'Jaspers answered without an id.')
  }
  const share = (id: string): string => `/shares/${encodeURIComponent(id)}`

  return {
    state: async () => readState(await call('/state'), clientId),
    invite: async (email) => void (await call('/teammates', 'POST', { email })),
    accept: async (invite) => void (await call('/teammates/accept', 'POST', { invite })),
    decline: async (invite) => void (await call('/teammates/decline', 'POST', { invite })),
    removeTeammate: async (accountId) => void (await call(`/teammates/${encodeURIComponent(accountId)}`, 'DELETE')),
    createShare: async ({ kind, localId, title }) =>
      idOf(await call('/shares', 'POST', { kind, local_id: localId, title }), 'share'),
    manifest: async (id) => readManifest((await call(share(id))).manifest),
    setMembers: async (id, members) => void (await call(`${share(id)}/members`, 'PUT', { members })),
    deleteShare: async (id) => void (await call(share(id), 'DELETE')),
    leaveShare: async (id) => void (await call(`${share(id)}/members/me`, 'DELETE')),
    writeParts: async (id, body) => readManifest((await call(`${share(id)}/parts`, 'PUT', body)).manifest),
    readParts: async (id, keys) => {
      const parts = (await call(`${share(id)}/parts/read`, 'POST', { keys })).parts
      return typeof parts === 'object' && parts !== null ? (parts as Record<string, unknown>) : {}
    },
    sendCommand: async (id, kind, payload) =>
      idOf(await call(`${share(id)}/commands`, 'POST', { kind, payload }), 'command'),
    claim: async (fresh) => {
      const commands = (await call('/commands/claim', 'POST', { fresh })).commands
      return (Array.isArray(commands) ? commands : []).flatMap((one) => readCommand(one) ?? [])
    },
    complete: async (commandId, outcome) =>
      void (await call(`/commands/${encodeURIComponent(commandId)}/complete`, 'POST', outcome)),
  }
}
