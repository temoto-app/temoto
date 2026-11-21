/**
 * Connects "install a CLI plugin" in Settings Skills (TODO 1099, ARCHITECTURE.md 4.5.3.3) to electron. The
 * bodies are the adapter's `plugin-install.ts` (the entry point that calls the CLI) and `plugin-catalog.ts`
 * (reads the catalog).
 *
 * Even where it does not work (duplicate, dev, fake backend) the IPC is registered; the list is shown, and
 * install / remove return a reason (same as 774). Names and ids coming from the renderer are checked again
 * in main (only those in the catalog or the installed plugin list).
 */
import { ipcMain } from 'electron'
import { IpcChannel } from '@shared/ipc.js'
import type { PluginOpsDisabled } from '@shared/skills.js'
import { guarded } from './handlers.js'
import { CliPluginManager } from '../session/adapter/plugin-install.js'

export interface CliPluginWiring {
  readonly opsDisabled: PluginOpsDisabled | null
  /** Whether a conversation is running (responding, send queue, awaiting approval, ...). null if not running. */
  readonly blocker: () => string | null
}

export function registerCliPluginHandlers(wiring: CliPluginWiring): CliPluginManager {
  const manager = new CliPluginManager({ opsDisabled: wiring.opsDisabled, blocker: wiring.blocker })
  ipcMain.handle(
    IpcChannel.skillsPluginCatalog,
    guarded(IpcChannel.skillsPluginCatalog, (_event: unknown, query: unknown) => manager.catalog(query))
  )
  ipcMain.handle(
    IpcChannel.skillsPluginInstall,
    guarded(IpcChannel.skillsPluginInstall, (_event: unknown, name: unknown) => manager.install(name))
  )
  ipcMain.handle(
    IpcChannel.skillsPluginUninstall,
    guarded(IpcChannel.skillsPluginUninstall, (_event: unknown, id: unknown) => manager.uninstall(id))
  )
  return manager
}
