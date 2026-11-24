/**
 * The BottomBar badge about automatic backups (TODO 1306, TODO 1318). At most one of:
 *
 * - "Backup off": the one-time notice that automatic backups wait for a passphrase. Pressing it opens the backup item in settings and
 *   dismisses the notice for good (`backup.noticeDismissed`, all windows); settings can still set the passphrase later.
 * - "Backup failed" (TODO 1318): backups are not being made, and until then that was only visible in the settings item:
 *   - the last automatic / manual backup failed and none has succeeded since (`BackupStatus.lastFailure`, which main already limits to
 *     failures after the newest generation). It goes away with the next backup that succeeds (the next attempt is at most an hour later);
 *   - or there are backups of ours but no usable passphrase any more (the keychain item was lost): nothing runs and nothing is recorded
 *     as a failure, and the one-time notice may have been dismissed long ago.
 *   The tooltip says why; pressing it opens the backup item. It cannot be dismissed.
 *
 * It used to be a band at the top of the window; that stole the title bar's drag region and did not match the rest of the UI. It has
 * the same unobtrusive shape as the agent CLI update notice (`AgentUpdateNotice`), next to the version badge.
 * The urgent states (damaged DB, restore results) stay as bands in `BackupBanner`.
 */
import { useEffect } from 'react'
import { DATA_TRANSFER_MIN_PASSPHRASE } from '@shared/data-transfer.js'
import type { BackupFailure, BackupStatus } from '@shared/backup.js'
import { useT } from '../i18n/index.js'
import { backupApi, initBackup, useBackup } from '../backupStore.js'
import { jumpToSetting } from '../settingsJump.js'
import { backupBannerKind } from './BackupBanner.js'
import { Tooltip } from './Tooltip.js'

export type BackupBadge = { readonly kind: 'notice' } | { readonly kind: 'failed'; readonly reason: BackupFailure }

/** Which badge to show for a state (null = none). Pure, for tests. */
export function backupBadge(status: BackupStatus | null): BackupBadge | null {
  if (backupBannerKind(status) === 'notice') return { kind: 'notice' }
  if (status === null || !status.supported) return null
  if (status.passphraseSet && status.lastFailure !== null) return { kind: 'failed', reason: status.lastFailure.reason }
  if (!status.passphraseSet && status.generations.length > 0) return { kind: 'failed', reason: 'no-passphrase' }
  return null
}

export function BackupNoticeBadge(): React.JSX.Element | null {
  const t = useT()
  const status = useBackup((state) => state.status)
  useEffect(() => initBackup(), [])
  const badge = backupBadge(status)
  if (badge === null) return null
  if (badge.kind === 'failed') {
    const title = t('backup.badge.failedTitle', {
      reason: t(`settings.backup.error.${badge.reason}`, { min: DATA_TRANSFER_MIN_PASSPHRASE })
    })
    return (
      <Tooltip content={title}>
        <button type="button" className="build-badge backup-notice-badge failed" aria-label={title} onClick={() => jumpToSetting('backup')}>
          <span className="build-badge-updated">{t('backup.badge.failed')}</span>
        </button>
      </Tooltip>
    )
  }
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
