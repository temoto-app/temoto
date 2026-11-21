/**
 * TODO 1265 (ARCHITECTURE 6.2.4, 7.6.9): the entry the gateway's reminder tools (`addReminder` / `listReminders` / `cancelReminder`) call.
 * Independent of electron (tests call it directly).
 *
 * What the AI can make through here is **a one-shot, notification-only reminder** and nothing else: the action kind is fixed in
 * `ScheduledJobStore.createAiReminder` (no prompt, no model, no tool). The text is only shown in a desktop notification; it is never run or sent anywhere.
 * Because the AI could otherwise flood the list, there are caps (`AI_REMINDER_LIMITS`), and every value coming from the gateway is re-validated here
 * (the gateway is not trusted, item 86) with the same job-input check the settings screen uses (`checkJobInput`).
 */
import { checkJobInput } from './input.js'

export const AI_REMINDER_LIMITS = {
  /** Reminders the AI registered that are still waiting to fire, across all conversations. */
  pendingTotal: 20,
  /** The same, per conversation. */
  pendingPerThread: 10,
  /** Registrations one conversation may make over its lifetime in this run of the app (cancelling does not give them back). In memory only. */
  registrationsPerThread: 30,
  /** Length of the text (it becomes the notification title). */
  maxMessageLength: 140,
  /** How far ahead a reminder may be (milliseconds). */
  maxAheadMs: 30 * 24 * 60 * 60 * 1000,
  /** `inMinutes` upper bound (the same 30 days). */
  maxInMinutes: 30 * 24 * 60,
  /**
   * How long a fired (or skipped) AI-registered reminder stays in the list before the scheduler removes it (code-review, wave 96 fix Y).
   * Counted from the last time it was shown or disabled, so the notification's snooze buttons and the editor's snooze keep working
   * for a day; a row with a pending snooze is never removed.
   */
  keepAfterFiredMs: 24 * 60 * 60 * 1000
} as const

/** What the gate needs from the scheduler (a small interface so tests can use the real `JobScheduler` or a stub). */
export interface AiReminderBackend {
  create(name: string, atLocal: string, threadId: string): { readonly id: string } | null
  pending(): readonly { readonly id: string; readonly name: string; readonly threadId: string; readonly atLocal: string }[]
  remove(id: string): void
}

export type AiReminderResult =
  | {
      readonly ok: true
      readonly id?: string
      readonly message?: string
      readonly at?: string
      readonly atLocal?: string
      readonly cancelled?: string
      readonly reminders?: readonly { readonly id: string; readonly message: string; readonly atLocal: string }[]
    }
  | { readonly error: string }

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Epoch ms -> local `YYYY-MM-DDTHH:MM` (the form `ScheduleSpec` `once` takes). */
export function toLocalMinute(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** One line, no control characters, trimmed. */
function tidyMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // Control characters and line / paragraph separators become spaces (the text is one line in a notification title).
  const line = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  return line === '' ? null : line
}

const WITH_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

export class AiReminderGate {
  private readonly registered = new Map<string, number>()

  constructor(
    private readonly backend: AiReminderBackend,
    private readonly now: () => number = Date.now
  ) {}

  /** `args`: `{ message, at? , inMinutes? }` - exactly one of `at` / `inMinutes`. */
  register(threadId: string, args: unknown): AiReminderResult {
    const L = AI_REMINDER_LIMITS
    const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
    const message = tidyMessage(record['message'])
    if (message === null) return { error: 'message is required (a short text shown in the notification).' }
    if (message.length > L.maxMessageLength) {
      return { error: `message is too long (at most ${L.maxMessageLength} characters).` }
    }
    const now = this.now()
    const at = record['at']
    const inMinutes = record['inMinutes']
    if ((at === undefined) === (inMinutes === undefined)) {
      return { error: 'give exactly one of at (a local date-time such as 2026-11-21T15:30) or inMinutes (minutes from now).' }
    }
    let target: number
    if (inMinutes !== undefined) {
      if (typeof inMinutes !== 'number' || !Number.isFinite(inMinutes) || inMinutes <= 0) {
        return { error: 'inMinutes must be a positive number.' }
      }
      if (inMinutes > L.maxInMinutes) return { error: 'inMinutes is too far ahead (at most 30 days).' }
      target = now + inMinutes * 60_000
    } else {
      if (typeof at !== 'string' || !WITH_TIME.test(at.trim())) {
        return {
          error:
            'at must be a date-time such as 2026-11-21T15:30 (local time) or with an offset such as 2026-11-21T15:30+09:00.'
        }
      }
      target = Date.parse(at.trim().replace(' ', 'T'))
      if (!Number.isFinite(target)) return { error: 'at could not be read as a date-time.' }
    }
    // The 30-day bound is checked on the time as asked, before rounding: rounding up to the minute adds up to a minute, and
    // `inMinutes` exactly at its upper bound (30 days) must still be accepted (code-review, wave 96 fix Y).
    if (target - now > L.maxAheadMs) return { error: 'that time is too far ahead (at most 30 days).' }
    // The schedule has minute resolution, so round up: a reminder never fires earlier than asked.
    target = Math.ceil(target / 60_000) * 60_000
    if (target <= now) return { error: 'that time is already past. Pass a time in the future.' }

    const all = this.backend.pending()
    if (all.length >= L.pendingTotal) {
      return {
        error: `too many AI-registered reminders are waiting (limit ${L.pendingTotal}). Ask the user to clear some in the scheduled-runs list in Settings.`
      }
    }
    if (all.filter((job) => job.threadId === threadId).length >= L.pendingPerThread) {
      return { error: `this conversation already has ${L.pendingPerThread} reminders waiting. Cancel one or wait until one fires.` }
    }
    if ((this.registered.get(threadId) ?? 0) >= L.registrationsPerThread) {
      return { error: 'this conversation has registered too many reminders. Ask the user to add further ones themselves.' }
    }

    const atLocal = toLocalMinute(target)
    // The same check the settings screen's input goes through. The kind is a literal here: the AI cannot choose it.
    try {
      checkJobInput(
        { name: message, enabled: true, spec: { kind: 'once', at: atLocal }, maxRuns: null, action: { kind: 'reminder', body: '' } },
        () => undefined,
        now
      )
    } catch {
      return { error: 'the reminder was rejected as invalid.' }
    }
    const job = this.backend.create(message, atLocal, threadId)
    if (job === null) return { error: 'aios is shutting down' }
    this.registered.set(threadId, (this.registered.get(threadId) ?? 0) + 1)
    return { ok: true, id: job.id, message, at: new Date(target).toISOString(), atLocal }
  }

  /** This conversation's reminders that are still waiting. */
  list(threadId: string): AiReminderResult {
    const reminders = this.backend
      .pending()
      .filter((job) => job.threadId === threadId)
      .map((job) => ({ id: job.id, message: job.name, atLocal: job.atLocal }))
    return { ok: true, reminders }
  }

  /** Cancels one of this conversation's own reminders (not other conversations', not ones the user made). */
  cancel(threadId: string, id: unknown): AiReminderResult {
    if (typeof id !== 'string' || id === '' || id.length > 200) return { error: 'id is required (from listReminders).' }
    const found = this.backend.pending().find((job) => job.id === id && job.threadId === threadId)
    if (found === undefined) return { error: 'no such reminder registered by this conversation is waiting.' }
    this.backend.remove(id)
    return { ok: true, cancelled: id }
  }
}
