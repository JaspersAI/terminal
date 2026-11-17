import { useState } from 'react'
import { dispatch, useAppState } from '../../lib/state'

/**
 * The user's own first and last name as a form holds it: what Account has until they type, then
 * what they typed, cleared fields included. Main judges the name on save; the form only knows
 * whether there is something to save.
 */
export function useOwnName(): {
  first: string
  last: string
  setFirst(value: string): void
  setLast(value: string): void
  /** Whether Account has both parts. */
  named: boolean
  /** Whether both parts are filled in and are not what Account already has. */
  changed: boolean
  save(): Promise<void>
} {
  const savedFirst = useAppState((s) => s.collab.firstName)
  const savedLast = useAppState((s) => s.collab.lastName)
  const [firstDraft, setFirst] = useState<string | null>(null)
  const [lastDraft, setLast] = useState<string | null>(null)
  const first = firstDraft ?? savedFirst
  const last = lastDraft ?? savedLast
  const filled = first.trim() !== '' && last.trim() !== ''
  return {
    first,
    last,
    setFirst,
    setLast,
    named: savedFirst !== '' && savedLast !== '',
    changed: filled && (first.trim() !== savedFirst || last.trim() !== savedLast),
    async save() {
      await dispatch({ type: 'collab.setProfile', firstName: first, lastName: last })
      setFirst(null)
      setLast(null)
    },
  }
}
