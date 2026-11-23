import { useState, type ReactElement } from 'react'
import { bundledProviderId } from '../../../shared/plugins/icon'
import type { PluginInfo } from '../../../shared/state'
import { initials } from '../../lib/hub-directory'

/**
 * Provider and built-in plugin marks bundled from `assets/providers/<id>.png`. Vite serves each as a
 * static file (`assetsInlineLimit: 0`) so it satisfies the renderer's `img-src 'self'` policy.
 */
const LOGOS = import.meta.glob<string>('../../assets/providers/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
})

export type PluginMarkSize = '2xs' | 'xs' | 'md' | 'sm' | 'lg'

const BOX_CLASS: Record<PluginMarkSize, string> = {
  '2xs': 'h-4 w-4',
  xs: 'h-6 w-6',
  md: 'h-7 w-7',
  sm: 'h-8 w-8',
  lg: 'h-12 w-12',
}

const TEXT_CLASS: Record<PluginMarkSize, string> = {
  '2xs': 'text-[7px]',
  xs: 'text-[8px]',
  md: 'text-[9px]',
  sm: 'text-[9px]',
  lg: 'text-[11px]',
}

interface Props {
  id: string
  title?: string
  plugin?: Pick<PluginInfo, 'icon' | 'iconKey' | 'frames'> | undefined
  size?: PluginMarkSize
}

/**
 * The square mark in front of a plugin's name across Settings, the Hub directory, onboarding, and
 * core/plugins: a bundled provider logo first, then a verified local or service favicon from
 * `jaspers-plugin://<id>/icon`, and finally the plugin's initials.
 */
export function PluginMark({ id, title, plugin, size = 'sm' }: Props): ReactElement {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const providerKey = plugin?.iconKey ?? bundledProviderId(id, plugin?.frames)
  const bundled = providerKey ? LOGOS[`../../assets/providers/${providerKey}.png`] : undefined
  const dynamic = !bundled && plugin?.icon ? plugin.icon : undefined
  const src = bundled ?? (dynamic && failedSrc !== dynamic ? dynamic : undefined)
  const box = BOX_CLASS[size]

  if (src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden
        onError={() => setFailedSrc(src)}
        className={`${box} shrink-0 border border-border ${bundled ? '' : 'bg-white'} object-contain`}
      />
    )
  }

  return (
    <span
      aria-hidden
      className={`${box} flex shrink-0 items-center justify-center border border-border bg-muted font-mono tracking-tight text-muted-foreground ${TEXT_CLASS[size]}`}
    >
      {initials(title ?? id)}
    </span>
  )
}
