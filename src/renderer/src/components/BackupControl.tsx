/**
 * The "Automatic Backup" item of the settings screen (TODO 1306, wave 99 bundle C, ARCHITECTURE 8.7).
 *
 * - The passphrase: two fields (the second confirms) and "Set". Once set, only "set (kept in the keychain)" and "Change". The fields are cleared
 *   after sending; main never sends it back.
 * - The state: the newest backup and how many are kept, the last failure, the folder (path for display, "Change…" opens main's dialog,
 *   "Use Default"), "Back Up Now".
 * - "Restore from the most recent backup…" only when the DB is damaged / cannot be opened or a restore did not finish (the same
 *   `BackupRestoreAction` as the band, with the passphrase field when the remembered one does not open the backup).
 * - Only this profile's backups are listed. One made by another Mac / profile (or before the data folder was lost) is brought in with
 *   "Export and Import" > "Import…" (the hint says so).
 */
import { useEffect, useState } from 'react'
import { DATA_TRANSFER_MIN_PASSPHRASE } from '@shared/data-transfer.js'
import { backupRestorable, type BackupActionResult } from '@shared/backup.js'
import { useT, type Translate } from '../i18n/index.js'
import { callBackup, initBackup, useBackup } from '../backupStore.js'
import { formatBytes } from '../thread/timeline.js'
import { BackupRestoreAction } from './BackupRestoreAction.js'

type Message = { readonly text: string; readonly error: boolean } | null

function resultMessage(t: Translate, result: BackupActionResult, done: string): Message {
  if (result.kind === 'canceled') return null
  if (result.kind === 'failed') return { text: t(`settings.backup.error.${result.reason}`, { min: DATA_TRANSFER_MIN_PASSPHRASE }), error: true }
  return { text: done, error: false }
}

function dateText(at: number): string {
  return new Date(at).toLocaleString()
}

export function BackupControl(): React.JSX.Element | null {
  const t = useT()
  const status = useBackup((state) => state.status)
  const [editing, setEditing] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message>(null)
  useEffect(() => initBackup(), [])

  if (status === null) return null
  if (!status.supported) {
    return <p className="hint">{t(`settings.backup.unsupported.${status.unsupportedReason ?? 'instance'}`)}</p>
  }

  const run = (action: () => Promise<BackupActionResult>, done: string, after?: (result: BackupActionResult) => void): void => {
    setBusy(true)
    setMessage(null)
    void action().then((result) => {
      setBusy(false)
      setMessage(resultMessage(t, result, done))
      after?.(result)
    })
  }

  const savePassphrase = (): void => {
    if ([...passphrase].length < DATA_TRANSFER_MIN_PASSPHRASE) {
      setMessage({ text: t('settings.backup.error.passphrase-short', { min: DATA_TRANSFER_MIN_PASSPHRASE }), error: true })
      return
    }
    if (confirm !== passphrase) {
      setMessage({ text: t('settings.transfer.mismatch'), error: true })
      return
    }
    run(() => callBackup('setPassphrase', passphrase), t('settings.backup.passphraseSaved'), (result) => {
      setPassphrase('')
      setConfirm('')
      if (result.kind === 'done') setEditing(false)
    })
  }

  const newest = status.generations[0]
  const showFields = !status.passphraseSet || editing

  return (
    <div className="backup-control">
      <p className="data-transfer-hint">{t('settings.backup.hint', { keep: status.keep })}</p>
      {showFields ? (
        <>
          <label className="data-transfer-field">
            <span>{t('settings.transfer.passphrase')}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={passphrase}
              disabled={busy}
              onChange={(event) => setPassphrase(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="data-transfer-field">
            <span>{t('settings.backup.confirm')}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              disabled={busy}
              aria-invalid={confirm !== '' && confirm !== passphrase ? 'true' : undefined}
              onChange={(event) => setConfirm(event.target.value)}
              spellCheck={false}
            />
          </label>
          {status.passphraseSet ? <p className="data-transfer-hint">{t('settings.backup.changeHint')}</p> : null}
          <div className="settings-actions">
            <button type="button" disabled={busy || passphrase === ''} onClick={savePassphrase}>
              {t('settings.backup.setPassphrase')}
            </button>
            {editing ? (
              <button type="button" disabled={busy} onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <div className="settings-actions">
          <span>{t('settings.backup.passphraseSet')}</span>
          <button type="button" disabled={busy} onClick={() => setEditing(true)}>
            {t('settings.backup.changePassphrase')}
          </button>
        </div>
      )}
      <p className="backup-control-line">
        {newest === undefined
          ? t('settings.backup.none')
          : t('settings.backup.newest', { date: dateText(newest.at), size: formatBytes(newest.bytes), count: status.generations.length })}
        {status.running ? ` ${t('settings.backup.running')}` : ''}
      </p>
      {status.lastFailure !== null ? (
        <p className="data-transfer-status error">
          {t('settings.backup.lastFailure', { date: dateText(status.lastFailure.at) })}{' '}
          {t(`settings.backup.error.${status.lastFailure.reason}`, { min: DATA_TRANSFER_MIN_PASSPHRASE })}
        </p>
      ) : null}
      <p className="backup-control-line">
        {t(status.dirIsDefault ? 'settings.backup.dirDefault' : 'settings.backup.dir')} <code className="backup-control-dir">{status.dir}</code>
      </p>
      <div className="settings-actions">
        <button
          type="button"
          disabled={busy || status.running || !status.passphraseSet}
          onClick={() => run(() => callBackup('runNow'), t('settings.backup.saved'))}
        >
          {t('settings.backup.runNow')}
        </button>
        <button type="button" disabled={busy} onClick={() => run(() => callBackup('chooseDir'), t('settings.backup.dirChanged'))}>
          {t('settings.backup.chooseDir')}
        </button>
        {status.dirIsDefault ? null : (
          <button type="button" disabled={busy} onClick={() => run(() => callBackup('resetDir'), t('settings.backup.dirChanged'))}>
            {t('settings.backup.resetDir')}
          </button>
        )}
      </div>
      {backupRestorable(status) || status.health === 'restore-incomplete' ? <BackupRestoreAction status={status} variant="settings" /> : null}
      <p className="data-transfer-hint">{t('settings.backup.otherOwnersHint')}</p>
      {message !== null && message.text !== '' ? (
        <p className={`data-transfer-status${message.error ? ' error' : ''}`} role="status">
          {message.text}
        </p>
      ) : null}
    </div>
  )
}
