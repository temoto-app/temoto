/**
 * The band about backups at the top of the window (TODO 1306, wave 99 bundle C, ARCHITECTURE 8.7). No modal (owner decision 2026-11-22).
 *
 * At most one of, in this order:
 * 1. The result of a restore done at this launch (closable). A failed one that can be tried again shows as 2 instead.
 * 2. The DB is damaged / cannot be opened, or a restore did not finish, and there is a backup: "Restore from the most recent backup…"
 *    (`BackupRestoreAction`, shared with the settings item). The confirmation is main's native dialog (the only confirmation of the
 *    feature). If the stored passphrase does not open the backup, a passphrase field appears here.
 * 3. The DB is damaged and there is no backup: say so (closable for this window).
 * 4. No passphrase yet and the band was never closed: "Decide a backup passphrase" (opens the settings item). Closing it is remembered
 *    (`backup.noticeDismissed`) and it is not shown again; settings can still set it.
 *
 * Nothing in a verification launch (`supported: false`).
 */
import { useEffect, useState } from 'react'
import { backupRestorable, type BackupStatus } from '@shared/backup.js'
import { useT } from '../i18n/index.js'
import { CloseIcon } from '../icons/CloseIcon.js'
import { backupApi, initBackup, useBackup } from '../backupStore.js'
import { jumpToSetting } from '../settingsJump.js'
import { BackupRestoreAction } from './BackupRestoreAction.js'

export type BackupBannerKind = 'restore' | 'restorable' | 'corruptNoBackup' | 'notice'

/** Which band to show for a state (null = none). Pure, for tests. */
export function backupBannerKind(status: BackupStatus | null): BackupBannerKind | null {
  if (status === null || !status.supported) return null
  // A restore that did not finish keeps "restore again" / "keep the current database" in reach (even with no backup left to offer).
  const retry = backupRestorable(status) || status.health === 'restore-incomplete'
  if (status.restore !== null && !(status.restore.kind === 'failed' && retry)) return 'restore'
  if (retry) return 'restorable'
  if (status.health === 'corrupt') return 'corruptNoBackup'
  if (!status.passphraseSet && !status.noticeDismissed && status.health !== 'unopenable') return 'notice'
  return null
}

export function BackupBanner(): React.JSX.Element | null {
  const t = useT()
  const status = useBackup((state) => state.status)
  const [hidden, setHidden] = useState<ReadonlySet<BackupBannerKind>>(new Set())
  useEffect(() => initBackup(), [])

  const kind = backupBannerKind(status)
  if (status === null || kind === null || hidden.has(kind)) return null

  const hide = (): void => setHidden(new Set([...hidden, kind]))
  const close = (onClose: () => void = hide): React.JSX.Element => (
    <button type="button" className="icon-button backup-banner-close" aria-label={t('common.close')} onClick={onClose}>
      <CloseIcon />
    </button>
  )

  if (kind === 'restore' && status.restore !== null) {
    const text =
      status.restore.kind === 'restored'
        ? t('backup.banner.restored', { file: status.restore.fileName, threads: status.restore.threads, settings: status.restore.settings })
        : `${t('backup.banner.restoreFailed', { file: status.restore.fileName })} ${t(`settings.backup.error.${status.restore.reason}`)}`
    return (
      <div className={`backup-banner${status.restore.kind === 'failed' ? ' error' : ''}`} role="status">
        <span className="backup-banner-text">{text}</span>
        {close()}
      </div>
    )
  }

  if (kind === 'restorable') {
    const failed = status.restore?.kind === 'failed' ? status.restore : null
    const text =
      status.health === 'restore-incomplete'
        ? t('backup.banner.restoreIncomplete')
        : t(status.health === 'corrupt' ? 'backup.banner.corrupt' : 'backup.banner.unopenable')
    return (
      <div className="backup-banner error" role="alert">
        <span className="backup-banner-text">
          {text}
          {failed !== null ? ` ${t(`settings.backup.error.${failed.reason}`)}` : ''}
        </span>
        <BackupRestoreAction status={status} variant="banner" />
        {close()}
      </div>
    )
  }

  if (kind === 'corruptNoBackup') {
    return (
      <div className="backup-banner error" role="alert">
        <span className="backup-banner-text">{t('backup.banner.corruptNoBackup')}</span>
        {close()}
      </div>
    )
  }

  return (
    <div className="backup-banner" role="status">
      <span className="backup-banner-text">{t('backup.banner.notice')}</span>
      <button type="button" onClick={() => jumpToSetting('backup')}>
        {t('backup.banner.decide')}
      </button>
      {close(() => {
        hide()
        void backupApi()?.dismissNotice?.()
      })}
    </div>
  )
}
