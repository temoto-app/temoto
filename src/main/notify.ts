/**
 * Desktop notifications (item 72, ARCHITECTURE.md 3.1, the end "Desktop notifications").
 *
 * There are only two targets: **when a question (awaiting approval, or a multiple-choice question) is queued** and
 * **when an answer (turn) finishes**. No body is shown - so that the contents of a conversation do not remain in the notification center (OS side),
 * the wording is only two fixed kinds ("awaiting approval" / "answered").
 *
 * Only the **electron-independent decisions and coalescing rules** are placed here:
 * - `newApprovalItems` - a pure function that takes from the approval list (all items passed by `ApprovalBroker.onChanged`)
 *   only the difference from last time (newly queued items).
 * - `resolveNotifyTitle` - turns a provisional title (empty string, TODO 66) into the default title's wording.
 * - `DesktopNotifier` - a state machine for "whether to show (`enabled`)" and "whether to coalesce (the same thread is
 *   replaced by one)". **It does not know electron's `Notification` itself** -
 *   creating, showing and discarding are done by the thin layer (`src/main/index.ts`) that injects `create`.
 * - `NotificationPreference` - storing ON/OFF (`notify.enabled` in `app_settings`,
 *   TODO 85). A thin box that only holds a value, like `EditorPreference` / `ThemeController`.
 *
 * "Do not show while displayed" (`ThreadViews.isSeen`) and "do not show auto-approved" (auto-approved
 * requests are not even carried by `ApprovalBroker.onChanged`, T12) are both decided by material the caller
 * (`SessionManager`) already has, so no decision for them is kept here.
 */
import type { Locale } from '@shared/locale.js'
import { formatTimeOfDay, REMINDER_SNOOZE_MINUTES } from '@shared/schedule.js'
import { log } from '../common/logger.js'
import type { ApprovalItem } from '@shared/thread.js'
import type { AppSettingsStore } from '../common/settings.js'
import { NOTIFY_ENABLED } from '../common/settings-keys.js'
import { nativeFormat, nativeText } from './i18n-native.js'
import type { ReminderPresenter, ReminderShow } from './schedule/scheduler.js'

/**
 * Returns, in order, only the items that are not in `previous` (the whole list just before) but are in `next` (the whole list now),
 * that is, **the newly queued ones**. Items that decreased (resolved) are ignored.
 */
export function newApprovalItems(
  previous: readonly ApprovalItem[],
  next: readonly ApprovalItem[]
): readonly ApprovalItem[] {
  if (previous.length === 0) return next
  const seen = new Set(previous.map((item) => item.id))
  return next.filter((item) => !seen.has(item.id))
}

/**
 * The thread name shown in the notification. A provisional title (`UNTITLED_THREAD_TITLE`, an empty string) is turned into the default title's wording.
 * main builds wording only here (an exception for native UI, as in decision 2 of TODO 66).
 */
export function resolveNotifyTitle(threadTitle: string, locale: Locale): string {
  return threadTitle === '' ? nativeText(locale, 'thread.untitled') : threadTitle
}

/** The body for "awaiting approval" / "answered". The wording is built only here. */
export function notifyBody(kind: 'approval' | 'turnEnded', locale: Locale): string {
  return nativeText(locale, kind === 'approval' ? 'notify.approval' : 'notify.turnEnded')
}

/**
 * The heading and body of a notification for a thread of a scheduled run (TODO 323). The heading is the alarm-clock mark + the thread name (= the job name).
 * The body at the end is the start of the response (`excerpt`, already redacted), or a fixed word if empty. Awaiting approval uses a fixed word.
 * **The exception to item 72's "no body is shown"** is only here (the first turn of a scheduled run).
 */
export function scheduledNotifyText(
  kind: 'done' | 'approval',
  threadTitle: string,
  excerpt: string,
  locale: Locale
): { title: string; body: string } {
  const title = `⏰ ${resolveNotifyTitle(threadTitle, locale)}`
  if (kind === 'approval') return { title, body: nativeText(locale, 'notify.scheduledApproval') }
  return { title, body: excerpt === '' ? nativeText(locale, 'notify.scheduledDone') : excerpt }
}

/**
 * The notification for the end of the first turn of a conversation started by a trigger (TODO 1216). The heading is the trigger's name and title (lightning mark + name - title), the body is
 * the start of the response (`excerpt`, already redacted), or a fixed word if empty. Like scheduled runs, an exception to item 72's "no body is shown".
 */
export function triggerNotifyText(
  triggerName: string,
  threadTitle: string,
  excerpt: string,
  locale: Locale
): { title: string; body: string } {
  const title = `⚡ ${triggerName} — ${resolveNotifyTitle(threadTitle, locale)}`
  return { title, body: excerpt === '' ? nativeText(locale, 'notify.triggerDone') : excerpt }
}

/**
 * The heading and body of the notification for an outbound operation (TODO 959) awaiting approval. The destination and body are not shown (item 72's "no body is shown").
 * For an unattended turn of a scheduled run the heading is the alarm-clock mark + the thread name. Clicking it opens that thread and the approval frame appears (5.4).
 */
export function outboundNotifyText(
  threadTitle: string,
  scheduled: boolean,
  locale: Locale
): { title: string; body: string } {
  const name = resolveNotifyTitle(threadTitle, locale)
  return scheduled
    ? { title: `⏰ ${name}`, body: nativeText(locale, 'notify.scheduledOutboundApproval') }
    : { title: name, body: nativeText(locale, 'notify.outboundApproval') }
}

/**
 * The entry point for one native notification, implemented by the thin layer (`index.ts`). The handle returned by `create`
 * is promised not to appear on screen until `show` is called (the same as electron's `Notification`).
 */
export interface DesktopNotification {
  show(): void
  close(): void
  onClick(callback: () => void): void
  /**
   * TODO 1265: one of the action buttons was pressed (the index into the `actions` passed to `create`). macOS shows the buttons only for a
   * signed app whose notifications are in the "Alerts" style; otherwise they never fire and the click (opening the editor) is the way to snooze.
   */
  onAction?(callback: (index: number) => void): void
}

/** `actions` (TODO 1265) are button labels; only reminders pass them. */
export type CreateDesktopNotification = (
  title: string,
  body: string,
  actions?: readonly string[]
) => DesktopNotification

export interface DesktopNotifierDeps {
  readonly create: CreateDesktopNotification
  /** Whether it is ON now (`NotificationPreference.get()`). Looked at on every call - the setting can change midway. */
  readonly enabled: () => boolean
  /** The notification was clicked. The argument is that thread's id. */
  readonly onClick: (threadId: string) => void
}

/**
 * A state machine that holds at most one notification per thread ("coalescing", item 72).
 * Even for rapid repeats in a short time, such as a parent stacking turns at each subagent end (item 93),
 * the previous one is closed before the next is shown for the same thread, so only one remains on screen.
 */
export class DesktopNotifier {
  private readonly active = new Map<string, DesktopNotification>()

  constructor(private readonly deps: DesktopNotifierDeps) {}

  notify(threadId: string, title: string, body: string): void {
    if (!this.deps.enabled()) return
    // Item 240: make "shown" / "closed the previous" traceable in main's log (no body is logged).
    // In an environment without OS permission it disappears right after being shown, so the log is the only evidence that "it tried to show".
    const replaced = this.active.get(threadId)
    replaced?.close()
    const notification = this.deps.create(title, body)
    notification.onClick(() => this.deps.onClick(threadId))
    this.active.set(threadId, notification)
    notification.show()
    log.info('notify.shown', { threadId, replaced: replaced !== undefined, bodyChars: body.length })
  }
}

/**
 * TODO 1265: the heading and body of a reminder's notification. The heading is the alarm-clock mark + the user's title; the body is the user's
 * text (an exception to item 72's "no body is shown", like 323's scheduled runs - the user wrote it to be shown), or a fixed word when empty.
 * A late reminder (aios was stopped or the machine slept) says when it was due on the first line.
 */
export function reminderNotifyText(
  reminder: Pick<ReminderShow, 'title' | 'body' | 'lateSince'>,
  locale: Locale,
  now: number
): { title: string; body: string } {
  const lines: string[] = []
  if (reminder.lateSince !== null) {
    lines.push(nativeFormat(locale, 'notify.reminderLate', { time: formatReminderTime(reminder.lateSince, now) }))
  }
  if (reminder.body !== '') lines.push(reminder.body)
  return {
    title: `⏰ ${reminder.title}`,
    body: lines.length === 0 ? nativeText(locale, 'notify.reminder') : lines.join('\n')
  }
}

/** "09:00" for today, "10/7 09:00" for another day (local time, the same shape as the renderer's list). */
function formatReminderTime(at: number, now: number): string {
  const date = new Date(at)
  const time = formatTimeOfDay(date.getHours(), date.getMinutes())
  return date.toDateString() === new Date(now).toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

/** TODO 1265: the snooze buttons' labels, in the order of `REMINDER_SNOOZE_MINUTES` (the action index maps back to the minutes). */
export function snoozeActionLabels(locale: Locale): string[] {
  return REMINDER_SNOOZE_MINUTES.map((minutes) =>
    minutes % 60 === 0
      ? nativeFormat(locale, 'notify.snoozeHours', { hours: minutes / 60 })
      : nativeFormat(locale, 'notify.snoozeMinutes', { minutes })
  )
}

export interface ReminderNotifierDeps {
  readonly create: CreateDesktopNotification
  readonly locale: () => Locale
  readonly now?: () => number
  /** The notification was clicked: bring up a window and open that job's editor (where the snooze buttons also are). */
  readonly onClick: (jobId: string) => void
  /** A snooze button was pressed. */
  readonly onSnooze: (jobId: string, minutes: number) => void
}

/**
 * TODO 1265: shows reminders (`ReminderPresenter` of `JobScheduler`). One notification per job at most - a newer one (the next repeat, a snooze)
 * closes the previous. The handles are kept here until clicked or replaced, so electron keeps delivering their events.
 * **It does not look at the notification ON/OFF (`notify.enabled`)**: that setting covers conversation events (approval / answers), while a
 * reminder exists only to notify - the user turns a reminder off by disabling it. Nor does it look at whether a window is in front.
 */
export class ReminderNotifier implements ReminderPresenter {
  private readonly active = new Map<string, DesktopNotification>()

  constructor(private readonly deps: ReminderNotifierDeps) {}

  show(reminder: ReminderShow): void {
    const locale = this.deps.locale()
    const replaced = this.active.get(reminder.jobId)
    replaced?.close()
    const text = reminderNotifyText(reminder, locale, (this.deps.now ?? Date.now)())
    const notification = this.deps.create(text.title, text.body, snoozeActionLabels(locale))
    const forget = (): void => {
      if (this.active.get(reminder.jobId) === notification) this.active.delete(reminder.jobId)
    }
    notification.onClick(() => {
      forget()
      this.deps.onClick(reminder.jobId)
    })
    notification.onAction?.((index) => {
      forget()
      const minutes = REMINDER_SNOOZE_MINUTES[index]
      if (minutes !== undefined) this.deps.onSnooze(reminder.jobId, minutes)
    })
    this.active.set(reminder.jobId, notification)
    notification.show()
    // The title and body are the user's text: only their lengths are logged.
    log.info('notify.reminder.shown', { jobId: reminder.jobId, replaced: replaced !== undefined, bodyChars: text.body.length })
  }
}

/**
 * Desktop notification ON/OFF (`notify.enabled` in `app_settings`, TODO 85).
 * The same shape as `EditorPreference` - the default is true, and from then on it is its own only writer.
 */
export class NotificationPreference {
  private current: boolean

  constructor(private readonly settings: AppSettingsStore) {
    this.current = settings.readTyped(NOTIFY_ENABLED)
  }

  get(): boolean {
    return this.current
  }

  set(enabled: boolean): boolean {
    this.current = enabled
    this.settings.writeTyped(NOTIFY_ENABLED, enabled)
    return this.current
  }
}
