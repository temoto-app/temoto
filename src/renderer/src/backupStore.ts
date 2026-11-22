/**
 * The renderer-side mirror of the automatic backup (TODO 1306, wave 99 bundle C, ARCHITECTURE 8.7).
 *
 * **Main is the single source** (`BackupService`). When the state changes, `backup.onChanged` reaches all windows and replaces it here
 * (the same shape as `agentUpdateStore.ts`). Readers are the band at the top of the window (`BackupBanner`) and the settings item
 * (`BackupControl`). With no entry point (an old preload / a test fake), `status` stays null and nothing is drawn.
 * The passphrase is never kept here: the fields that hold it live in the components and are cleared after sending.
 */
import { create } from 'zustand'
import type { BackupActionResult, BackupStatus } from '@shared/backup.js'

type BackupApi = Partial<{
  status(): Promise<BackupStatus>
  setPassphrase(passphrase: string): Promise<BackupActionResult>
  runNow(): Promise<BackupActionResult>
  chooseDir(): Promise<BackupActionResult>
  resetDir(): Promise<BackupActionResult>
  dismissNotice(): Promise<void>
  restore(passphrase: string | null): Promise<BackupActionResult>
  keepCurrent(): Promise<BackupActionResult>
  onChanged(listener: (status: BackupStatus) => void): unknown
}>

export function backupApi(): BackupApi | undefined {
  return (window as unknown as { aios?: { backup?: BackupApi } }).aios?.backup
}

interface BackupState {
  readonly status: BackupStatus | null
}

export const useBackup = create<BackupState>(() => ({ status: null }))

let started = false

/** Subscribes once per window and fetches the first state. Safe to call from several components. */
export function initBackup(): void {
  if (started) return
  const api = backupApi()
  if (api === undefined) return
  started = true
  if (typeof api.onChanged === 'function') api.onChanged((status) => useBackup.setState({ status }))
  if (typeof api.status === 'function') {
    api
      .status()
      .then((status) => useBackup.setState({ status }))
      .catch(() => undefined)
  }
}

/** Calls one operation; a missing entry point or a thrown error is `io` (the state settles with the next notification). */
export async function callBackup(
  name: 'setPassphrase' | 'runNow' | 'chooseDir' | 'resetDir' | 'restore' | 'keepCurrent',
  arg?: string | null
): Promise<BackupActionResult> {
  const api = backupApi()
  try {
    switch (name) {
      case 'setPassphrase':
        if (typeof api?.setPassphrase === 'function') return await api.setPassphrase(arg ?? '')
        break
      case 'restore':
        if (typeof api?.restore === 'function') return await api.restore(arg ?? null)
        break
      default: {
        const fn = api?.[name]
        if (typeof fn === 'function') return await fn()
      }
    }
  } catch {
    // Falls through to `io`.
  }
  return { kind: 'failed', reason: 'io' }
}
