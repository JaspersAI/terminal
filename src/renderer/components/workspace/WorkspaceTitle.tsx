import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { WORKSPACE_NAME_MAX, type Workspace } from '../../../shared/state'
import { errorMessage } from '../../lib/errors'
import { dispatch } from '../../lib/state'

interface Props {
  workspace: Workspace
}

/**
 * The tab name as an absolutely-positioned input overlaid on an invisible sizing span that uses the
 * exact same element and classes as an inactive tab's label, so switching between active and inactive
 * tabs causes zero layout shift. Enter or blur saves; Escape or an empty name reverts.
 */
export function WorkspaceTitle({ workspace }: Props): ReactElement {
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(workspace.name)

  function revert(): void {
    setDraft(workspace.name)
    if (input.current) input.current.value = workspace.name
  }

  async function commit(): Promise<void> {
    const el = input.current
    if (!el) return
    const name = el.value.trim()
    if (!name || name === workspace.name) return revert()
    el.value = name
    setDraft(name)
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
    <span className="relative inline-flex items-center">
      <span
        aria-hidden
        className="invisible inline-block max-w-40 min-w-12 truncate whitespace-pre px-1.5 py-0.5 text-sm font-medium"
      >
        {draft || workspace.name}
      </span>
      <input
        ref={input}
        id="workspace-title"
        aria-label="Workspace name"
        size={1}
        defaultValue={workspace.name}
        maxLength={WORKSPACE_NAME_MAX}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => {
          const el = event.currentTarget
          requestAnimationFrame(() => el.select())
        }}
        onBlur={() => void commit()}
        onKeyDown={onKeyDown}
        className="absolute inset-0 w-full bg-transparent px-1.5 py-0.5 text-sm font-medium outline-none focus:bg-background focus:ring-1 focus:ring-primary"
      />
    </span>
  )
}
