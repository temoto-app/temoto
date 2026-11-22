/**
 * "Restore from the most recent backup…" with its passphrase field (TODO 1306, ARCHITECTURE 8.7). Shared by the band at the top of the
 * window (`BackupBanner`) and the settings item (`BackupControl`), so both ask for the passphrase the same way.
 *
 * - The first press sends no passphrase (main uses the remembered one). If main answers `passphrase-needed` / `decrypt-failed`, a
 *   passphrase field appears and the next press sends what was typed. It is used for this restore only (main does not change the
 *   remembered passphrase) and the field is cleared after sending.
 * - After a restore that did not finish (`restore-incomplete`), "Keep the Current Database" is offered next to it.
 * - The confirmation is main's native dialog (the only confirmation of the feature).
 */
import { useState } from 'react'
import type { BackupFailure, BackupStatus } from '@shared/backup.js'
import { DATA_TRANSFER_MIN_PASSPHRASE } from '@shared/data-transfer.js'
import { useT } from '../i18n/index.js'
import { callBackup } from '../backupStore.js'

export function BackupRestoreAction({
  status,
  variant
}: {
  readonly status: BackupStatus
  readonly variant: 'banner' | 'settings'
}): React.JSX.Element {
  const t = useT()
  const [needPassphrase, setNeedPassphrase] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<BackupFailure | null>(null)

  const restore = (): void => {
    setBusy(true)
    setError(null)
    void callBackup('restore', needPassphrase ? passphrase : null).then((result) => {
      setBusy(false)
      setPassphrase('')
      if (result.kind !== 'failed') return
      if (result.reason === 'passphrase-needed' || result.reason === 'decrypt-failed') setNeedPassphrase(true)
      setError(result.reason)
    })
  }

  const keepCurrent = (): void => {
    setBusy(true)
    setError(null)
    void callBackup('keepCurrent').then((result) => {
      setBusy(false)
      if (result.kind === 'failed') setError(result.reason)
    })
  }

  const input = needPassphrase ? (
    <input
      type="password"
      className={variant === 'banner' ? 'backup-banner-passphrase' : undefined}
      autoComplete="off"
      placeholder={variant === 'banner' ? t('backup.banner.passphrase') : undefined}
      aria-label={t('backup.banner.passphrase')}
      value={passphrase}
      disabled={busy}
      onChange={(event) => setPassphrase(event.target.value)}
      spellCheck={false}
    />
  ) : null
  const buttons = (
    <>
      <button
        type="button"
        className={variant === 'settings' ? 'danger' : undefined}
        disabled={busy || status.running || (needPassphrase && passphrase === '')}
        onClick={restore}
      >
        {t('backup.banner.restore')}
      </button>
      {status.health === 'restore-incomplete' ? (
        <button type="button" disabled={busy} onClick={keepCurrent}>
          {t('backup.banner.keepCurrent')}
        </button>
      ) : null}
    </>
  )
  const errorText = error === null ? null : t(`settings.backup.error.${error}`, { min: DATA_TRANSFER_MIN_PASSPHRASE })

  if (variant === 'banner') {
    return (
      <>
        {input}
        {buttons}
        {errorText !== null ? <span className="backup-banner-error">{errorText}</span> : null}
      </>
    )
  }
  return (
    <>
      {input !== null ? (
        <label className="data-transfer-field">
          <span>{t('backup.banner.passphrase')}</span>
          {input}
        </label>
      ) : null}
      <div className="settings-actions">{buttons}</div>
      {errorText !== null ? (
        <p className="data-transfer-status error" role="status">
          {errorText}
        </p>
      ) : null}
    </>
  )
}
