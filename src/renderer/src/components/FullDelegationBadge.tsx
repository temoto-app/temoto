/**
 * The "full delegation" badge in BottomBar (TODO 1175, ARCHITECTURE 4.2.1 "full delegation mode").
 *
 * Shown only while full delegation mode (`ApprovalPolicy.fullDelegation`) is enabled. The value has a single source in main (`approvals.getPolicy`), and
 * is re-fetched on open and on `settings.onChanged` (the settings screen, the AI's `setSetting`, another window; changing the approval default is broadcast to all windows).
 * Pressing it jumps to that field in the settings screen (`jumpToSetting`). Colors are only CSS variables (`.full-delegation-badge`).
 */
import { useEffect, useState } from 'react'
import { useT } from '../i18n/index.js'
import { jumpToSetting } from '../settingsJump.js'
import { Tooltip } from './Tooltip.js'

export function FullDelegationBadge(): React.JSX.Element | null {
  const t = useT()
  const [on, setOn] = useState(false)
  useEffect(() => {
    const approvals = window.aios?.approvals
    const settings = window.aios?.settings
    if (approvals?.getPolicy === undefined) return
    let alive = true
    const load = (): void => {
      void approvals
        .getPolicy()
        .then((policy) => {
          if (alive) setOn(policy.fullDelegation === true)
        })
        .catch(() => undefined)
    }
    load()
    const off = settings?.onChanged?.(load)
    return () => {
      alive = false
      off?.()
    }
  }, [])
  if (!on) return null
  const title = t('fullDelegation.badgeTitle')
  return (
    <Tooltip content={title}>
      <button type="button" className="full-delegation-badge" aria-label={title} onClick={() => jumpToSetting('fullDelegation')}>
        {t('fullDelegation.badge')}
      </button>
    </Tooltip>
  )
}
