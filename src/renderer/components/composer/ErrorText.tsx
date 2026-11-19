import type { ReactElement } from 'react'
import { isConnectivityMessage } from '../../../shared/llm/connectivity'
import { linkPieces } from '../../lib/links'
import { ExternalLink } from './MarkdownText'

/**
 * Why a run failed, where a reply would be: in amber caution tone when the failure is a network or
 * internet connectivity issue so the user is not alarmed, and in red otherwise. A link in it opens
 * in the browser: a service's refusal often says where to go, as Account's out-of-credits one does.
 */
export function ErrorText({ text, className = '' }: { text: string; className?: string }): ReactElement {
  const connectivity = isConnectivityMessage(text)
  const tone = connectivity ? 'text-warning' : 'text-destructive'
  return (
    <p
      data-connectivity-notice={connectivity ? '' : undefined}
      className={`text-sm break-words ${tone} ${className}`.trim()}
    >
      {linkPieces(text).map((piece, i) =>
        piece.href === undefined ? (
          piece.text
        ) : (
          <ExternalLink key={i} href={piece.href}>
            {piece.text}
          </ExternalLink>
        ),
      )}
    </p>
  )
}
