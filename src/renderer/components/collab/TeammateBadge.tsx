import type { ReactElement } from 'react'
import { teammateBadgeStyle, teammateInitials } from '../../../shared/collab/collab'
import { useColorScheme } from '../../lib/color-scheme'

interface Props {
  email: string
  /** Where they stand among the people shown beside them: it picks the color. */
  index: number
  /** In color when their room is in use and they are connected; grey otherwise. */
  lit: boolean
  /** The side of the square, in pixels. */
  size?: number
  title?: string
}

/** A teammate, as two letters in a square of their own color. Square, as everything here is. */
export function TeammateBadge({ email, index, lit, size = 20, title }: Props): ReactElement {
  const dark = useColorScheme() === 'dark'
  const colors = teammateBadgeStyle(index, lit, dark)
  return (
    <span
      data-teammate-badge={email}
      data-lit={lit}
      title={title ?? email}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.45)),
        backgroundColor: colors.backgroundColor,
        color: colors.color,
        borderColor: colors.borderColor,
      }}
      className="flex shrink-0 items-center justify-center border leading-none font-semibold tracking-tight select-none"
    >
      {teammateInitials(email)}
    </span>
  )
}
