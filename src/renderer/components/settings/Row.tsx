import type { ReactElement, ReactNode } from 'react'

/** A text field or select in a settings row. */
export const FIELD =
  'w-full border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-foreground'

/** A secondary button: Reconnect, a secret's Save. */
export const BUTTON =
  'shrink-0 border border-border px-2.5 py-1 text-sm hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent'

/** The button that does what a question asks: Save, Create, Claim. */
export const PRIMARY =
  'shrink-0 border border-foreground bg-foreground px-2.5 py-1 text-sm text-background disabled:opacity-50'

interface Props {
  label: string
  /** The control the label names, when there is one to focus. */
  htmlFor?: string
  /** A muted line under the label: what the setting is, or a link. */
  hint?: ReactNode
  children: ReactNode
}

/**
 * One setting: its name on the left, its control on the right, a rule under it. The control drops
 * under the name where the space is narrow, as in a Plugins view on a small element.
 */
export function Row({ label, htmlFor, hint, children }: Props): ReactElement {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border py-3">
      <div className="min-w-0 text-sm">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex min-w-0 flex-[0_1_20rem] flex-col gap-1">{children}</div>
    </div>
  )
}
