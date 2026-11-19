import type { ReactElement } from 'react'
import { connectivityBannerText, isLoopbackUrl } from '../../../shared/llm/connectivity'
import { dismissConnectivityBanner, useConnectivityState } from '../../lib/connectivity'
import { useAppState } from '../../lib/state'

/**
 * Calm, non-modal connectivity banner below the top command bar when the machine goes offline or a
 * cloud request hits a network connectivity failure, reassuring the user that their workspace and
 * rooms are safe and clearing automatically once connectivity recovers.
 */
export function ConnectivityBanner(): ReactElement | null {
  const { browserOnline, recentConnectivityIssue, dismissed } = useConnectivityState()
  const llm = useAppState((s) => s.llm)
  const localLlm = llm !== null && isLoopbackUrl(llm.baseUrl)
  const text = connectivityBannerText({
    browserOnline,
    recentConnectivityIssue,
    dismissed,
    localLlm,
  })
  if (text === null) return null

  return (
    <div
      role="status"
      aria-live="polite"
      data-connectivity-banner=""
      className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-1 text-xs"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="h-2 w-2 shrink-0 bg-warning" />
        <span className="text-foreground">{text}</span>
      </div>
      <button
        type="button"
        data-connectivity-banner-dismiss=""
        onClick={dismissConnectivityBanner}
        className="h-5 shrink-0 px-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        Dismiss
      </button>
    </div>
  )
}
