import { useRef, type KeyboardEvent, type ReactElement } from 'react'
import { WORKSPACE_NAME_MAX, type Workspace } from '../../../shared/state'
import { errorMessage } from '../../lib/errors'
import { dispatch } from '../../lib/state'

interface Props {
  workspace: Workspace
}

/**
 * The workspace name as an input that reads as text and sizes to its content. Enter or blur saves,
 * Escape or an empty name reverts. Uncontrolled: the value is read at commit time, so cancelling
 * cannot race a pending state update.
 */
export function WorkspaceTitle({ workspace }: Props): ReactElement {
  const input = useRef<HTMLInputElement>(null)

  function revert(): void {
    if (input.current) input.current.value = workspace.name
  }

  async function commit(): Promise<void> {
    const el = input.current
    if (!el) return
    const name = el.value.trim()
    if (!name || name === workspace.name) return revert()
    el.value = name
    try {
      await dispatch({ type: 'workspace.rename', id: workspace.id, name })
    } catch (err) {
      console.error('[workspace] rename failed:', errorMessage(err))
      revert()
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') revert()
    if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur()
  }

  return (
    <input
      ref={input}
      id="workspace-title"
      aria-label="Workspace name"
      defaultValue={workspace.name}
      maxLength={WORKSPACE_NAME_MAX}
      autoComplete="off"
      spellCheck={false}
      onFocus={(event) => {
        // After the click that focused it has placed the caret, so the selection sticks.
        const el = event.currentTarget
        requestAnimationFrame(() => el.select())
      }}
      onBlur={() => void commit()}
      onKeyDown={onKeyDown}
      className="field-sizing-content min-w-8 bg-transparent px-1.5 py-0.5 text-sm font-medium outline-none hover:bg-muted focus:bg-background focus:ring-1 focus:ring-primary"
    />
  )
}
