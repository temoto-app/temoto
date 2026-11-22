/**
 * The IPC for roles (shown as "Teammates", TODO 972, ARCHITECTURE 4.3.4). Connects `RoleStore` (independent of electron) to ipcMain.
 *
 * Values from the renderer are **re-checked here** (12.7): the shape by `validateRoleInput`, the working folder by `FsAccess.assertAllowed`
 * (as a directory, not hitting an exclusion). Every call returns the whole list, and a change is pushed to all windows (infrequent).
 * Starting a conversation under a role goes through the ordinary `threads.create` with `roleId` (SessionManager checks the role again).
 */
import { ipcMain, type WebContents } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import { validateRoleInput, type Role, type RoleInput } from '@shared/role.js'
import type { DrillReport } from '@shared/drill.js'
import { reasonError } from '@shared/reason.js'
import { log } from '../../common/logger.js'
import { toRole, type RoleStore } from './store.js'

/** Checks a role input from the renderer; throws a reason code. */
export function checkRoleInput(value: unknown, assertDirectory: (uri: string) => void): RoleInput {
  const result = validateRoleInput(value)
  if (result === 'invalid-value') throw reasonError(result, { field: 'role' })
  if (result === 'role-name-empty') throw reasonError(result)
  if (result.cwdUri !== null) assertDirectory(result.cwdUri)
  return result
}

function asRoleId(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > 200) throw reasonError('invalid-value', { field: 'id' })
  return value
}

export interface RoleHandlerDeps {
  readonly store: RoleStore
  readonly assertDirectory: (uri: string) => void
  /** A role was deleted: detach its conversations (`SessionManager.forgetRole`). */
  readonly onRemoved: (roleId: string) => void
  /** TODO 1288: `SessionManager.moveThreadToRole` (it re-checks both ids and refuses a running / unattended conversation). */
  readonly moveThread: (threadId: unknown, roleId: unknown) => void
  /** All windows, for the push. */
  readonly targets: () => readonly WebContents[]
  /** TODO 982 / 1292 item 2: `SessionManager.startDrill` / `drillReport` / `grantDrillOps` (each re-checks its ids). */
  readonly drills?: {
    readonly start: (roleId: unknown, jobId: unknown) => Promise<string>
    readonly report: (threadId: unknown) => DrillReport | null
    readonly grant: (threadId: unknown, opIds: unknown) => DrillReport | null
  }
}

export function registerRoleHandlers(deps: RoleHandlerDeps): void {
  const list = (): readonly Role[] => deps.store.list().map(toRole)
  const changed = (): readonly Role[] => {
    const roles = list()
    pushRoles(roles, deps.targets())
    return roles
  }
  ipcMain.handle(IpcChannel.roleList, (): readonly Role[] => list())
  ipcMain.handle(IpcChannel.roleCreate, (_event, input: unknown): readonly Role[] => {
    const role = deps.store.create(checkRoleInput(input, deps.assertDirectory))
    // Only ids and flags (the name and the instructions are the user's text).
    log.info('role.created', { roleId: role.id, cwd: role.cwd !== null, instructions: role.instructions !== '' })
    return changed()
  })
  ipcMain.handle(IpcChannel.roleUpdate, (_event, id: unknown, input: unknown): readonly Role[] => {
    const roleId = asRoleId(id)
    const role = deps.store.updateRole(roleId, checkRoleInput(input, deps.assertDirectory))
    if (role === null) throw reasonError('role-not-found')
    log.info('role.updated', { roleId, cwd: role.cwd !== null, instructions: role.instructions !== '' })
    return changed()
  })
  // TODO 1288: no confirmation (owner decision: few dialogs). The conversation list is pushed by the manager.
  ipcMain.handle(IpcChannel.roleMoveThread, (_event, threadId: unknown, roleId: unknown): void => {
    deps.moveThread(threadId, roleId)
  })
  // TODO 982 / 1292 item 2: drills. No confirmation (owner decision: few dialogs); the button says the run uses the real model.
  const drills = deps.drills
  if (drills !== undefined) {
    ipcMain.handle(IpcChannel.drillStart, (_event, roleId: unknown, jobId: unknown): Promise<string> => drills.start(roleId, jobId ?? null))
    ipcMain.handle(IpcChannel.drillReport, (_event, threadId: unknown): DrillReport | null => drills.report(threadId))
    ipcMain.handle(IpcChannel.drillGrant, (_event, threadId: unknown, opIds: unknown): DrillReport | null => drills.grant(threadId, opIds))
  }
  ipcMain.handle(IpcChannel.roleRemove, (_event, id: unknown): readonly Role[] => {
    const roleId = asRoleId(id)
    // No confirmation (owner decision: few dialogs). Nothing is lost - the conversations stay, without a role.
    if (deps.store.delete(roleId)) {
      deps.onRemoved(roleId)
      log.info('role.removed', { roleId })
    }
    return changed()
  })
}

/** TODO 982: tells all windows that a drill's list changed (only the thread id). */
export function pushDrillChanged(threadId: string, targets: readonly WebContents[]): void {
  for (const contents of targets) {
    if (!contents.isDestroyed()) contents.send(IpcEvent.drillChanged, threadId)
  }
}

/** Sends the whole list to all windows. */
export function pushRoles(roles: readonly Role[], targets: readonly WebContents[]): void {
  for (const contents of targets) {
    if (!contents.isDestroyed()) contents.send(IpcEvent.roleChanged, roles)
  }
}
