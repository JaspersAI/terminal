import type { ReactElement } from 'react'
import { personDetail, teammateBadgeStyle, teammateInitials } from '../../../shared/collab/collab'
import { useColorScheme } from '../../lib/color-scheme'
import { openSettings } from '../../lib/settings-nav'

interface Props {
  email: string
  firstName?: string | null
  lastName?: string | null
  /** In color when their room is in use, they are connected, or their message is shown; grey otherwise. */
  lit: boolean
  /** Diameter of the circle, in pixels. */
  size?: number
  title?: string
  className?: string
}

/**
 * A person, as two letters in a circle of their own color: round, like the orb, so a person never
 * reads as a control. Double-clicking or right-clicking any user circle opens Settings > Team.
 */
export function TeammateBadge({
  email,
  firstName,
  lastName,
  lit,
  size = 20,
  title,
  className = '',
}: Props): ReactElement {
  const dark = useColorScheme() === 'dark'
  const colors = teammateBadgeStyle(email, lit, dark)
  const label = personDetail({ email, firstName, lastName })
  return (
    <span
      data-teammate-badge={email}
      data-lit={lit}
      title={title ?? label}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openSettings('team')
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        openSettings('team')
      }}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.45)),
        backgroundColor: colors.backgroundColor,
        color: colors.color,
        borderColor: colors.borderColor,
      }}
      className={`flex shrink-0 cursor-pointer items-center justify-center rounded-full border leading-none font-semibold tracking-tight select-none ${className}`}
    >
      {teammateInitials({ email, firstName, lastName })}
    </span>
  )
}
