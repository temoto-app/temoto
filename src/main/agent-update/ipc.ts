/**
 * Connects the update of the CLI itself (TODO 774, ARCHITECTURE.md 4.6.6) to electron. The body is `service.ts`.
 *
 * The IPC is registered even in forms where updating does not run (duplicate, dev, fake backend), and returns `supported: false` with a reason (the settings screen shows it).
 */
import { ipcMain, type WebContents } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import type { AgentStatus } from '@shared/agent.js'
import type { AgentUpdateUnsupportedReason } from '@shared/agent-update.js'
import type { AppSettingsStore } from '../../common/settings.js'
import { guarded } from '../ipc/handlers.js'
import type { AgentSelfUpdate } from '../session/types.js'
import { AgentUpdateService } from './service.js'

export interface AgentUpdateWiring {
  readonly settings: AppSettingsStore
  readonly unsupportedReason: AgentUpdateUnsupportedReason | null
  readonly backend: AgentSelfUpdate | undefined
  readonly getTargets: () => readonly WebContents[]
  readonly blocker: () => string | null
  readonly redetect: () => Promise<AgentStatus>
  /** TODO 943: after raising the version, start a probe in the background. */
  readonly prewarm?: () => void
  readonly closing: () => boolean
}

export function registerAgentUpdateHandlers(wiring: AgentUpdateWiring): AgentUpdateService {
  const service = new AgentUpdateService({
    settings: wiring.settings,
    unsupportedReason: wiring.unsupportedReason,
    backend: wiring.backend,
    blocker: wiring.blocker,
    redetect: wiring.redetect,
    ...(wiring.prewarm === undefined ? {} : { prewarm: wiring.prewarm }),
    closing: wiring.closing,
    onChanged: (status) => {
      for (const contents of wiring.getTargets()) {
        if (!contents.isDestroyed()) contents.send(IpcEvent.agentUpdateChanged, status)
      }
    }
  })

  ipcMain.handle(IpcChannel.agentUpdateStatus, guarded(IpcChannel.agentUpdateStatus, () => service.status()))
  ipcMain.handle(
    IpcChannel.agentUpdateRun,
    guarded(IpcChannel.agentUpdateRun, async () => {
      // A failure is recorded in the state (`failure`), so it is not thrown. Only `agent-update-unsupported` (a form where updating does not run) is thrown.
      await service.updateNow()
      return service.status()
    })
  )
  ipcMain.handle(
    IpcChannel.agentUpdateRevert,
    guarded(IpcChannel.agentUpdateRevert, async () => {
      await service.revert()
      return service.status()
    })
  )
  ipcMain.handle(
    IpcChannel.agentUpdateSetAuto,
    guarded(IpcChannel.agentUpdateSetAuto, (_event: unknown, on: unknown) => service.setAuto(on === true))
  )
  ipcMain.handle(
    IpcChannel.agentUpdateDismissNotice,
    guarded(IpcChannel.agentUpdateDismissNotice, () => service.dismissNotice())
  )
  return service
}
