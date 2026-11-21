/**
 * The "Export and import" of the settings screen (TODO 1088, wave 64 bundle A, ARCHITECTURE 8.6).
 *
 * Just two passphrase fields (the second is a confirmation when exporting) and the "Export..." and "Import..." buttons. Main asks for the destination / source
 * with a native dialog, so this holds no path. The result is shown in one line (no dialog is shown).
 * The passphrase is cleared from the field after pressing (it is not left on screen).
 */
import { useState } from 'react'
import {
  DATA_TRANSFER_MIN_PASSPHRASE,
  type DataExportResult,
  type DataImportResult,
  type DataTransferFailure,
  type DataTransferFailureAt
} from '@shared/data-transfer.js'
import { useT, type Translate } from '../i18n/index.js'

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'message'; readonly text: string; readonly error: boolean }

function failureText(t: Translate, reason: DataTransferFailure, at?: DataTransferFailureAt): string {
  const text = t(`settings.transfer.error.${reason}`, { min: DATA_TRANSFER_MIN_PASSPHRASE })
  if (at === undefined) return text
  // Attach the place where the import refused (which thread's which item).
  const where =
    at.event === undefined
      ? t('settings.transfer.at.thread', { thread: at.thread })
      : t('settings.transfer.at.event', { thread: at.thread, event: at.event })
  return `${text} (${where})`
}

export function describeExport(t: Translate, result: DataExportResult): Status {
  if (result.kind === 'canceled') return { kind: 'idle' }
  if (result.kind === 'failed') return { kind: 'message', text: failureText(t, result.reason, result.at), error: true }
  const done = t('settings.transfer.exported', { file: result.fileName, threads: result.threads, settings: result.settings })
  const skipped =
    result.skippedThreads > 0 || result.skippedEvents > 0
      ? ` ${t('settings.transfer.exportSkipped', { threads: result.skippedThreads, events: result.skippedEvents })}`
      : ''
  return { kind: 'message', error: false, text: done + skipped }
}

export function describeImport(t: Translate, result: DataImportResult): Status {
  if (result.kind === 'canceled') return { kind: 'idle' }
  if (result.kind === 'failed') return { kind: 'message', text: failureText(t, result.reason, result.at), error: true }
  const done = t('settings.transfer.imported', { file: result.fileName, threads: result.threads, settings: result.settings })
  const skipped =
    result.skippedEvents > 0 || result.skippedSettings > 0
      ? ` ${t('settings.transfer.skipped', { events: result.skippedEvents, settings: result.skippedSettings })}`
      : ''
  return { kind: 'message', error: false, text: done + skipped }
}

export function DataTransferControl(): React.JSX.Element {
  const t = useT()
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const busy = status.kind === 'busy'
  const tooShort = [...passphrase].length < DATA_TRANSFER_MIN_PASSPHRASE
  const mismatch = confirm !== '' && confirm !== passphrase

  const clear = (): void => {
    setPassphrase('')
    setConfirm('')
  }
  const runExport = (): void => {
    if (tooShort) {
      setStatus({ kind: 'message', text: failureText(t, 'passphrase-short'), error: true })
      return
    }
    if (confirm !== passphrase) {
      setStatus({ kind: 'message', text: t('settings.transfer.mismatch'), error: true })
      return
    }
    setStatus({ kind: 'busy' })
    window.aios.data
      .export(passphrase)
      .then((result) => {
        if (result.kind === 'done') clear()
        setStatus(describeExport(t, result))
      })
      .catch(() => setStatus({ kind: 'message', text: failureText(t, 'io'), error: true }))
  }
  const runImport = (): void => {
    setStatus({ kind: 'busy' })
    window.aios.data
      .import(passphrase)
      .then((result) => {
        if (result.kind === 'done') clear()
        setStatus(describeImport(t, result))
      })
      .catch(() => setStatus({ kind: 'message', text: failureText(t, 'io'), error: true }))
  }

  return (
    <div className="data-transfer">
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
        <span>{t('settings.transfer.confirm')}</span>
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          disabled={busy}
          aria-invalid={mismatch ? 'true' : undefined}
          onChange={(event) => setConfirm(event.target.value)}
          spellCheck={false}
        />
      </label>
      <p className="data-transfer-hint">{t('settings.transfer.hint', { min: DATA_TRANSFER_MIN_PASSPHRASE })}</p>
      <div className="settings-actions">
        <button type="button" disabled={busy || passphrase === ''} onClick={runExport}>
          {t('settings.transfer.export')}
        </button>
        <button type="button" disabled={busy || passphrase === ''} onClick={runImport}>
          {t('settings.transfer.import')}
        </button>
      </div>
      {status.kind === 'busy' ? (
        <p className="data-transfer-status" role="status">
          {t('settings.transfer.working')}
        </p>
      ) : status.kind === 'message' ? (
        <p className={`data-transfer-status${status.error ? ' error' : ''}`} role="status">
          {status.text}
        </p>
      ) : null}
    </div>
  )
}
