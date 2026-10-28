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

/** Owns the files attached to a conversation input before they are sent. */
export function useAttachments(): AttachmentsControl {
  const [files, setFiles] = useState<AttachedFile[]>([])
  const [reading, setReading] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const attach = useCallback((incoming: Iterable<File> | ArrayLike<File>): void => {
    const list = Array.from(incoming)
    if (list.length === 0) return
    setError(null)
    for (const file of list) {
      if (file.size > UPLOAD_MAX) {
        setError(`${file.name} is larger than 20 MB.`)
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
          setError(errorMessage(err))
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
    hasAny: files.length > 0 || reading > 0 || error !== null,
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

/** A paperclip button and hidden file input for picking one or more files to attach. */
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
        aria-label="Attach file"
        title="Attach file"
        disabled={disabled}
        onClick={() => input.current?.click()}
        className={`flex shrink-0 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40 ${
          compact ? 'h-6 w-6' : 'h-7 w-7'
        }`}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden className={compact ? 'h-3.5 w-3.5' : 'h-4 w-4'}>
          <path
            d="M13.2 7.3 7.6 12.9a3.2 3.2 0 0 1-4.5-4.5l6.1-6.1a2.1 2.1 0 0 1 3 3L6.4 11.1a1 1 0 0 1-1.4-1.4l5.3-5.3"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="square"
          />
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

/** Shows attached file chips with a remove button for each, plus reading or parse error status. */
export function AttachmentChips({
  attachments,
  className = '',
}: {
  attachments: AttachmentsControl
  className?: string
}): ReactElement | null {
  const { files, reading, error, remove } = attachments
  if (files.length === 0 && reading === 0 && error === null) return null
  return (
    <div data-attachments className={`flex flex-col gap-1 ${className}`}>
      {(files.length > 0 || reading > 0) && (
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
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
