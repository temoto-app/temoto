/**
 * The renderer-side mirror of the backend (agent CLI) self-update (TODO 774, wave 36 bundle D).
 *
 * **Main is the single source** (`AgentUpdateService`). When the state changes, `agentUpdate.onChanged` reaches **all windows** and replaces it here
 * (same shape as `updateStore.ts`). Readers are the settings screen (the agent CLI row of the "Update" section) and the short notice in BottomBar.
 *
 * When there is no entry point (an old preload / a test fake), `status` stays null: the settings section shows nothing and no notice is shown.
 */
import { create } from 'zustand'
import type { AgentUpdateStatus } from '@shared/agent-update.js'
import { openSettingsEditor } from './settingsEditorStore.js'

type AgentUpdateApi = Partial<{
  status(): Promise<AgentUpdateStatus>
  run(): Promise<AgentUpdateStatus>
  revert(): Promise<AgentUpdateStatus>
  setAuto(on: boolean): Promise<AgentUpdateStatus>
  dismissNotice(): Promise<AgentUpdateStatus>
  onChanged(listener: (status: AgentUpdateStatus) => void): unknown
}>

function api(): AgentUpdateApi | undefined {
  return (window as unknown as { aios?: { agentUpdate?: AgentUpdateApi } }).aios?.agentUpdate
}

interface AgentUpdateState {
  readonly status: AgentUpdateStatus | null
  /** A request from the BottomBar notice to jump to the settings row (on open, scroll to the row and flash it). */
  readonly jumpSeq: number
  readonly jumpPending: boolean
  run(): Promise<void>
  revert(): Promise<void>
  setAuto(on: boolean): Promise<void>
  dismissNotice(): Promise<void>
  consumeJump(): void
}

function apply(next: unknown): void {
  if (typeof next === 'object' && next !== null && 'phase' in next && 'revertTo' in next) {
    useAgentUpdate.setState({ status: next as AgentUpdateStatus })
  }
}

async function call(name: 'run' | 'revert' | 'dismissNotice'): Promise<void> {
  const fn = api()?.[name]
  if (typeof fn !== 'function') return
  try {
    apply(await fn())
  } catch {
    // The state settles with the next notification (the failure reason is carried in `status.failure`).
  }
}

export const useAgentUpdate = create<AgentUpdateState>((set) => ({
  status: null,
  jumpSeq: 0,
  jumpPending: false,
  run: () => call('run'),
  revert: () => call('revert'),
  async setAuto(on: boolean) {
    const current = useAgentUpdate.getState().status
    if (current !== null) set({ status: { ...current, auto: on } })
    const fn = api()?.setAuto
    if (typeof fn !== 'function') return
    try {
      apply(await fn(on))
    } catch {
      // Settles with the next notification.
    }
  },
  dismissNotice: () => call('dismissNotice'),
  consumeJump: () => set({ jumpPending: false })
}))

/** Opens the settings screen and scrolls to the agent CLI update row (the BottomBar notice was pressed). */
export function jumpToAgentUpdate(): void {
  useAgentUpdate.setState((state) => ({ jumpPending: true, jumpSeq: state.jumpSeq + 1 }))
  openSettingsEditor()
}

let initialized = false

/** Reads the state and subscribes to change notifications. Does nothing from the second call on (called from both BottomBar and the settings screen). */
export function initAgentUpdate(): void {
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
