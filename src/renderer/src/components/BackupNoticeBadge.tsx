/**
 * The BottomBar badge "Backup off" (TODO 1306): the one-time notice that automatic backups wait for a passphrase.
 *
 * It used to be a band at the top of the window; that stole the title bar's drag region and did not match the rest of the UI. It now has
 * the same unobtrusive shape as the agent CLI update notice (`AgentUpdateNotice`), next to the version badge. Pressing it opens the backup
 * item in settings and dismisses the notice for good (`backup.noticeDismissed`, all windows); settings can still set the passphrase later.
 * The urgent states (damaged DB, restore results) stay as bands in `BackupBanner`.
 */
import { useEffect } from 'react'
import { useT } from '../i18n/index.js'
import { backupApi, initBackup, useBackup } from '../backupStore.js'
import { jumpToSetting } from '../settingsJump.js'
import { backupBannerKind } from './BackupBanner.js'
import { Tooltip } from './Tooltip.js'

export function BackupNoticeBadge(): React.JSX.Element | null {
  const t = useT()
  const status = useBackup((state) => state.status)
  useEffect(() => initBackup(), [])
  if (backupBannerKind(status) !== 'notice') return null
  const title = t('backup.banner.notice')
  return (
    <Tooltip content={title}>
      <button
        type="button"
        className="build-badge updated backup-notice-badge"
        aria-label={title}
        onClick={() => {
          void backupApi()?.dismissNotice?.()
          jumpToSetting('backup')
        }}
      >
        <span className="build-badge-updated">{t('backup.badge.text')}</span>
      </button>
    </Tooltip>
  )
}
