import { useCallback, useRef, useState, type DragEvent, type ReactElement } from 'react'
import type { AttachedFile } from '../../../shared/agent/attachments'
import { errorMessage } from '../../lib/errors'

const UPLOAD_MAX = 20 * 1024 * 1024

export interface AttachmentsControl {
  files: AttachedFile[]
  reading: number
  error: string | null
  hasAny: boolean
  attach: (incoming: Iterable<File> | ArrayLike<File>) => void
  remove: (name: string) => void
  clear: () => void
}

/** True when a drag event carries one or more files from the OS. */
export function hasDroppedFiles(
  dataTransfer: { types?: readonly string[] | DOMStringList } | null | undefined,
): boolean {
  return Array.from(dataTransfer?.types ?? []).includes('Files')
}

/**
 * Owns the files attached to a conversation input before they are sent.
 * Any parse or size error is forwarded to `onError` so it appears as a regular LLM response in the
 * conversation rather than sticking on top of the command line.
 */
export function useAttachments(onError?: (message: string, fileName: string) => void): AttachmentsControl {
  const [files, setFiles] = useState<AttachedFile[]>([])
  const [reading, setReading] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const attach = useCallback((incoming: Iterable<File> | ArrayLike<File>): void => {
    const list = Array.from(incoming)
    if (list.length === 0) return
    setError(null)
    for (const file of list) {
      if (file.size > UPLOAD_MAX) {
        const msg = `${file.name} is larger than 20 MB.`
        setError(msg)
        onErrorRef.current?.(msg, file.name)
        continue
      }
      setReading((n) => n + 1)
      file
        .arrayBuffer()
        .then((bytes) => window.app.agent.parseFile(file.name, bytes))
        .then((parsed) => {
          setFiles((current) => [...current.filter((one) => one.name !== parsed.name), parsed])
        })
        .catch((err: unknown) => {
          const msg = errorMessage(err)
          setError(msg)
          onErrorRef.current?.(msg, file.name)
        })
        .finally(() => {
          setReading((n) => Math.max(0, n - 1))
        })
    }
  }, [])

  const remove = useCallback((name: string): void => {
    setFiles((current) => current.filter((one) => one.name !== name))
    setError(null)
  }, [])

  const clear = useCallback((): void => {
    setFiles([])
    setError(null)
  }, [])

  return {
    files,
    reading,
    error,
    hasAny: files.length > 0 || reading > 0,
    attach,
    remove,
    clear,
  }
}

/** Drag-and-drop state and handlers for a conversation container. */
export function useFileDrop(onFiles: (files: File[]) => void): {
  dropping: boolean
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDragLeave: (event: DragEvent<HTMLElement>) => void
  onDrop: (event: DragEvent<HTMLElement>) => void
} {
  const [dropping, setDropping] = useState(false)
  return {
    dropping,
    onDragOver: (event) => {
      if (!hasDroppedFiles(event.dataTransfer)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'copy'
      setDropping(true)
    },
    onDragLeave: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false)
    },
    onDrop: (event) => {
      if (!hasDroppedFiles(event.dataTransfer)) return
      event.preventDefault()
      event.stopPropagation()
      setDropping(false)
      const list = Array.from(event.dataTransfer.files)
      if (list.length > 0) onFiles(list)
    },
  }
}

/** A "+" button placed inside the left of a command line and hidden file input for picking files to attach. */
export function AttachButton({
  disabled = false,
  compact = false,
  onFiles,
}: {
  disabled?: boolean
  compact?: boolean
  onFiles: (files: FileList) => void
}): ReactElement {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button
        type="button"
        data-attach-button
        aria-label="Attach file"
        title="Attach file"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className={`flex shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 ${
          compact ? 'h-5 w-5' : 'h-6 w-6'
        }`}
      >
        <svg viewBox="0 0 12 12" fill="none" aria-hidden className="h-3 w-3 stroke-current stroke-[1.5]">
          <path d="M6 2v8M2 6h8" />
        </svg>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const picked = event.target.files
          if (picked && picked.length > 0) onFiles(picked)
          event.target.value = ''
        }}
      />
    </>
  )
}

/** Shows attached file chips with a remove button for each. Errors are surfaced as regular LLM responses in the conversation. */
export function AttachmentChips({
  attachments,
  className = '',
}: {
  attachments: AttachmentsControl
  className?: string
}): ReactElement | null {
  const { files, reading, remove } = attachments
  if (files.length === 0 && reading === 0) return null
  return (
    <div data-attachments className={`flex flex-col gap-1 ${className}`}>
      <div className="flex flex-wrap items-center gap-1">
        {files.map((file) => (
          <span
            key={file.name}
            data-attachment={file.name}
            className="inline-flex max-w-full items-center gap-1 border border-border bg-muted px-1.5 py-0.5 text-xs"
          >
            <span className="truncate">{file.name}</span>
            <button
              type="button"
              aria-label={`Remove ${file.name}`}
              onClick={() => remove(file.name)}
              className="text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </span>
        ))}
        {reading > 0 && <span className="text-xs text-muted-foreground">Reading file…</span>}
      </div>
    </div>
  )
}
