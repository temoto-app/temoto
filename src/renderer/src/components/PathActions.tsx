/**
 * Two buttons, "copy full path" and "reveal in Finder" (TODO 289).
 * The same component is used in search result rows (on hover) and in the viewer heading.
 *
 * - Copy writes the real path (not folded to `~`) with `navigator.clipboard.writeText` (T17, the same approach as
 *   code copy in `ThreadPane`). After a press it shows a check mark for 1.5 seconds.
 * - Reveal in Finder goes through main's IPC (`editor.reveal`); main re-validates the URI with `assertAllowed`.
 * - A press does not bubble up to the row click (`stopPropagation`).
 */
import { useEffect, useState } from 'react'
import type { Platform } from '@shared/types.js'
import { fullPath } from '@shared/uri.js'
import { useStore } from '../store.js'
import { useT } from '../i18n/index.js'
import { CheckIcon } from '../icons/CheckIcon.js'
import { CopyPathIcon } from '../icons/CopyPathIcon.js'
import { RevealIcon } from '../icons/RevealIcon.js'
import { Tooltip } from './Tooltip.js'

/** Key for the "reveal in Finder" label. Finder is a macOS-only name, so the label differs per OS. */
export function revealLabelKey(
  platform: Platform | undefined
): 'path.revealMac' | 'path.revealWin' | 'path.revealOther' {
  return platform === 'darwin'
    ? 'path.revealMac'
    : platform === 'win32'
      ? 'path.revealWin'
      : 'path.revealOther'
}

/** Writes the real path to the clipboard. The right-click menu (TODO 299) uses the same route. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function PathActions({
  uri,
  asDirectory = false,
  className
}: {
  readonly uri: string
  readonly asDirectory?: boolean
  readonly className?: string
}): React.JSX.Element {
  const t = useT()
  const platform = useStore((state) => state.appInfo?.platform)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const revealLabel = t(revealLabelKey(platform))
  const buttonClass = className === undefined ? 'icon-button' : `icon-button ${className}`
  return (
    <>
      <Tooltip content={copied ? t('common.copied') : t('path.copy')}>
        <button
          type="button"
          className={buttonClass}
          onClick={(event) => {
            event.stopPropagation()
            void writeClipboard(fullPath(uri)).then((ok) => {
              if (ok) setCopied(true)
            })
          }}
          aria-label={t('path.copy')}
        >
          {copied ? <CheckIcon /> : <CopyPathIcon />}
        </button>
      </Tooltip>
      <Tooltip content={revealLabel}>
        <button
          type="button"
          className={buttonClass}
          onClick={(event) => {
            event.stopPropagation()
            void window.aios.editor.reveal(uri, asDirectory)
          }}
          aria-label={revealLabel}
        >
          <RevealIcon />
        </button>
      </Tooltip>
    </>
  )
}
