import { WINDOWS_MAX } from '../../../shared/grid/windows'

// Small coercions and parameter schemas shared by tools. Domain validation belongs to the domain.

/** The window a grid tool acts on, as its parameters say it. `asWindow` reads it. */
export const WINDOW = {
  type: 'integer',
  minimum: 1,
  maximum: WINDOWS_MAX,
  description: 'The window number from the grid map. Default 1.',
}

export function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
  return value === undefined || value === null || value === '' ? undefined : parse(value)
}

export function unstring(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trimStart().startsWith('{')) return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function asPathString(value: unknown): string {
  if (typeof value === 'string' && value) return value
  throw new Error('path must be a path into the app, like panels/e3/state.')
}

export function asOffset(value: unknown): number {
  const offset = typeof value === 'string' ? Number(value) : value
  if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0) return offset
  throw new Error('offset must be a whole number of characters, 0 or more.')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
