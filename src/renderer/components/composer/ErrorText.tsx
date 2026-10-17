import type { ReactElement } from 'react'
import { linkPieces } from '../../lib/links'
import { ExternalLink } from './MarkdownText'

/**
 * Why a run failed, in red where a reply would be. A link in it opens in the browser: a service's
 * refusal often says where to go, as Account's out-of-credits one does with the page that sells credits.
 */
export function ErrorText({ text, className = '' }: { text: string; className?: string }): ReactElement {
  return (
    <p className={`text-sm break-words text-destructive ${className}`.trim()}>
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
