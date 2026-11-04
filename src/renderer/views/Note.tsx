import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { usePanelState, usePublish, usePublishText, type PanelRef } from '@jaspers-ai/sdk'
import { settled } from '../../shared/agent/citations'
import { MarkdownText } from '../components/composer/MarkdownText'
import { hasRichNoteContent } from '../components/composer/markdown'

/**
 * The one built-in view: a square text area filling its element, or rendered Markdown and LaTeX
 * math when the note holds formatted content and is not actively being edited. What it holds is
 * the panel's state, so the orchestrator can write it and the box follows; what it shows is the
 * panel's output, so the orchestrator can read what is on screen without being told.
 */
export function Note({ panel }: { panel: PanelRef }): ReactElement {
  const [text, setText] = usePanelState(panel, 'text', '')
  const [editing, setEditing] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const rich = useMemo(() => hasRichNoteContent(settled(text)), [text])
  usePublish(panel, { text })
  usePublishText(panel, text.trim() === '' ? null : text)

  useEffect(() => {
    if (editing) textareaRef.current?.focus()
  }, [editing])

  if (rich && !editing) {
    return (
      <div
        role="region"
        aria-label="Note"
        data-note-rendered=""
        tabIndex={0}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('a, button, summary')) return
          if ((window.getSelection()?.toString() ?? '').length > 0) return
          setEditing(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.target === event.currentTarget) {
            event.preventDefault()
            setEditing(true)
          }
        }}
        className="group relative h-full w-full overflow-y-auto bg-background p-3 font-prose text-prose outline-none select-text"
      >
        <MarkdownText source={text} />
        <button
          type="button"
          aria-label="Edit note"
          onClick={(event) => {
            event.stopPropagation()
            setEditing(true)
          }}
          className="absolute top-2 right-3 border border-border bg-background px-2 py-0.5 font-sans text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground"
        >
          Edit
        </button>
      </div>
    )
  }

  return (
    <textarea
      ref={textareaRef}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && rich) {
          event.stopPropagation()
          setEditing(false)
        }
      }}
      placeholder="Write…"
      spellCheck={false}
      aria-label="Note"
      className="h-full w-full resize-none bg-background p-3 text-sm outline-none"
    />
  )
}
