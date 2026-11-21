/**
 * The IPC for scheduled runs (TODO 323, wave 18 bundle A). Connects `JobScheduler` (independent of electron) to ipcMain.
 *
 * Values from the renderer are **re-checked here** (12.7): the shape and how times are written by `validateScheduledJobInput`,
 * the working folder by `FsAccess.assertAllowed` (as a directory, not hitting an exclusion).
 * When the list changes, the whole list is sent to all windows (infrequent - only on add, edit, run and result).
 */
import { ipcMain, type WebContents } from 'electron'
import { IpcChannel, IpcEvent } from '@shared/ipc.js'
import type { LaterSend, LaterTaken, ResumeReservation, ScheduleOverview } from '@shared/schedule.js'
import { reasonError } from '@shared/reason.js'
import type { JobScheduler } from './scheduler.js'
import { asId, checkJobInput, checkLaterInput } from './input.js'

const MAX_RESUME_PROMPT = 20_000

/** TODO 628: check the arguments that came over IPC. */
function checkResumeInput(threadId: unknown, prompt: unknown, at: unknown): { threadId: string; prompt: string; at: number } {
  if (typeof threadId !== 'string' || threadId === '') throw reasonError('invalid-value', { field: 'threadId' })
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > MAX_RESUME_PROMPT) {
    throw reasonError('invalid-value', { field: 'prompt' })
  }
  if (typeof at !== 'number' || !Number.isFinite(at)) throw reasonError('invalid-value', { field: 'at' })
  return { threadId, prompt, at }
}

export function registerScheduleHandlers(
  scheduler: JobScheduler,
  assertDirectory: (uri: string) => void
): void {
  ipcMain.handle(IpcChannel.scheduleList, (): ScheduleOverview => scheduler.overview())
  ipcMain.handle(IpcChannel.scheduleCreate, (_event, input: unknown) =>
    scheduler.create(checkJobInput(input, assertDirectory))
  )
  ipcMain.handle(IpcChannel.scheduleUpdate, (_event, id: unknown, input: unknown) =>
    scheduler.update(asId(id), checkJobInput(input, assertDirectory))
  )
  ipcMain.handle(IpcChannel.scheduleRemove, (_event, id: unknown) => scheduler.remove(asId(id)))
  ipcMain.handle(IpcChannel.scheduleRunNow, (_event, id: unknown) => {
    scheduler.runNow(asId(id))
    return scheduler.overview()
  })
  ipcMain.handle(
    IpcChannel.scheduleReserveResume,
    (_event, threadId: unknown, prompt: unknown, at: unknown): ResumeReservation => {
      const checked = checkResumeInput(threadId, prompt, at)
      return scheduler.reserveResume(checked.threadId, checked.prompt, checked.at)
    }
  )
  ipcMain.handle(
    IpcChannel.scheduleReserveLater,
    (_event, threadId: unknown, input: unknown): LaterSend => {
      const checked = checkLaterInput(threadId, input)
      return scheduler.reserveLater(checked.threadId, checked.input)
    }
  )
  ipcMain.handle(IpcChannel.scheduleRetryLater, (_event, id: unknown): void => scheduler.retryLater(asId(id)))
  ipcMain.handle(IpcChannel.scheduleTakeLater, (_event, id: unknown): LaterTaken | null =>
    scheduler.takeLater(asId(id))
  )
  // TODO 1265: a reminder's snooze. `minutes` is re-checked by `JobScheduler.snooze` (only `REMINDER_SNOOZE_MINUTES`).
  ipcMain.handle(IpcChannel.scheduleSnooze, (_event, id: unknown, minutes: unknown): ScheduleOverview => {
    if (typeof minutes !== 'number') throw reasonError('invalid-value', { field: 'minutes' })
    scheduler.snooze(asId(id), minutes)
    return scheduler.overview()
  })
  ipcMain.handle(IpcChannel.scheduleCancelSnooze, (_event, id: unknown): ScheduleOverview => {
    scheduler.cancelSnooze(asId(id))
    return scheduler.overview()
  })
}

/** When the list changes, to all windows (`JobSchedulerOptions.onChanged`). */
export function pushScheduleOverview(
  overview: ScheduleOverview,
  targets: readonly WebContents[]
): void {
  for (const contents of targets) {
    if (!contents.isDestroyed()) contents.send(IpcEvent.scheduleChanged, overview)
  }
}
