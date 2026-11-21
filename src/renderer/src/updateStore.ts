/**
 * The renderer-side copy of auto-update (TODO 103 stage 1, wave 28 bundle G).
 *
 * **The source is a single place in main** (`UpdateService`). When the state changes, `update.onChanged` reaches **all windows** and replaces it here
 * (same shape as `autoSaveStore.ts`). Readers are the settings screen (the "Update" section) and the BottomBar version badge ("Updated to version X").
 *
 * When the entry point is missing (an old preload / a test fake), `status` stays null: the settings section shows nothing and the badge behaves as usual.
 */
import { create } from 'zustand'
import type { UpdateStatus } from '@shared/update.js'

type UpdateApi = Partial<{
  status(): Promise<UpdateStatus>
  check(): Promise<UpdateStatus>
  install(): Promise<UpdateStatus>
  restart(): Promise<void>
  setAuto(on: boolean): Promise<UpdateStatus>
  dismissNotice(): Promise<UpdateStatus>
  onChanged(listener: (status: UpdateStatus) => void): unknown
}>

function api(): UpdateApi | undefined {
  return (window as unknown as { aios?: { update?: UpdateApi } }).aios?.update
}

interface UpdateState {
  readonly status: UpdateStatus | null
  check(): Promise<void>
  install(): Promise<void>
  restart(): Promise<void>
  setAuto(on: boolean): Promise<void>
  dismissNotice(): Promise<void>
}

function apply(next: unknown): void {
  if (typeof next === 'object' && next !== null && 'phase' in next) {
    useUpdate.setState({ status: next as UpdateStatus })
  }
}

async function call(name: 'check' | 'install' | 'dismissNotice'): Promise<void> {
  const fn = api()?.[name]
  if (typeof fn !== 'function') return
  try {
    apply(await fn())
  } catch {
    // The state is settled by the next notification (the failure reason is carried in `status.failure`).
  }
}

export const useUpdate = create<UpdateState>(() => ({
  status: null,
  check: () => call('check'),
  install: () => call('install'),
  async restart() {
    const fn = api()?.restart
    if (typeof fn === 'function') await fn().catch(() => undefined)
  },
  async setAuto(on: boolean) {
    const current = useUpdate.getState().status
    if (current !== null) useUpdate.setState({ status: { ...current, auto: on } })
    const fn = api()?.setAuto
    if (typeof fn !== 'function') return
    try {
      apply(await fn(on))
    } catch {
      // Settled by the next notification.
    }
  },
  dismissNotice: () => call('dismissNotice')
}))

let initialized = false

/** Reads the state and subscribes to change notifications. Does nothing from the second call on (called from both the BottomBar and the settings screen). */
export function initUpdate(): void {
  if (initialized) return
  const current = api()
  if (current === undefined) return
  initialized = true
  try {
    if (typeof current.onChanged === 'function') current.onChanged((status) => apply(status))
    if (typeof current.status === 'function') void Promise.resolve(current.status()).then(apply, () => undefined)
  } catch {
    // If the entry point is broken, show nothing.
  }
}
