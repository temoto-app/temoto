/**
 * Scheduled runs (TODO 323 stage 1, ARCHITECTURE.md 6.2.4 "Scheduled runs (scheduler)").
 *
 * The job type, the interpretation of time notations (the simple form / a 5-field cron expression) and the next-run time calculation.
 * **Pure functions used by both main and the renderer** (while the user is typing, the settings screen shows the next run time and the number of runs per day
 * on the spot. main judges with the same functions). Independent of electron and the DOM.
 *
 * Times are the **local time of this machine** (`Date` getHours etc.). main and the renderer are on the same machine, so they
 * do not disagree. Counted at minute granularity (seconds are 0).
 */
import { isThinkingLevel, type ThinkingLevel } from './agent.js'

/**
 * Minimum interval (minutes). Because just starting a session costs about 21k tokens (Phase 0).
 * Lowered from 15 to 5 by TODO 1220 (owner decision 2026-11-13). Every 5 minutes is 288 runs a day.
 */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 5
/** Default choices for "every n minutes" on the settings screen (minutes, TODO 1220). Free input remains too. */
export const SCHEDULE_INTERVAL_PRESETS: readonly number[] = [5, 15, 30, 60]
/**
 * Upper limit of "every n minutes" (minutes). Widened from 1440 (1 day) to 7 days (168 hours) by TODO 725 (owner decision 2026-10-11).
 * Longer intervals are written as "daily" or a cron expression. The screen lets you choose minutes / hours as the unit, but it is always saved in minutes.
 */
export const MAX_SCHEDULE_INTERVAL_MINUTES = 10_080
/** Upper limit of the job name / prompt length. */
export const MAX_SCHEDULE_NAME = 200
export const MAX_SCHEDULE_PROMPT = 20_000
/** TODO 725: the run-count limit (the largest N that can be specified). Less a designed limit than a guard against mistyped input. */
export const MAX_SCHEDULE_MAX_RUNS = 100_000
/** TODO 1265: upper limit of a reminder's body (it is shown in a desktop notification, so it is kept short). */
export const MAX_REMINDER_BODY = 1_000
/** TODO 1265: the snooze choices (minutes) - the notification's buttons and the editor's buttons offer the same three. */
export const REMINDER_SNOOZE_MINUTES: readonly number[] = [5, 10, 60]
/**
 * TODO 1265: a reminder shown later than this after its time (aios was stopped, or the machine slept) says it is late
 * ("was due at 09:00"). The tick is 30 seconds, so an on-time reminder is never this late.
 */
export const REMINDER_LATE_MS = 2 * 60_000

/**
 * Weekday. **0 = Sunday ... 6 = Saturday** (the same numbers as `Date.getDay()` and the cron weekday field). It is saved
 * in JSON with these numbers (`{"kind":"days","days":[1,3,5],"time":"09:00"}`). The order follows `WEEK_ORDER` (Monday first).
 */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** Order on the screen (the week starts on Monday, TODO 527). The saved order follows it too (`normalizeWeekdays`). */
export const WEEK_ORDER: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0]
/** Weekdays (Mon-Fri). Rows of the old `weekdays` are read as the `days` of this. */
export const WORKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5]

/**
 * Time notation. The UI's main form is the simple one (daily / specified weekdays / every n minutes). `cron` is a 5-field expression accepted in the details field
 * (minute hour day month weekday, local time).
 */
export type ScheduleSpec =
  | { readonly kind: 'daily'; readonly time: string }
  /** HH:MM on the selected weekdays (TODO 527). `days` cannot be empty (`schedule-days-empty`). */
  | { readonly kind: 'days'; readonly days: readonly Weekday[]; readonly time: string }
  /**
   * @deprecated HH:MM on weekdays (Mon-Fri). Absorbed into `days: [1..5]` by TODO 527.
   * Converted to `days` on reading (`readScheduleSpec`), and only `days` is written. Kept in the type only to read old rows.
   */
  | { readonly kind: 'weekdays'; readonly time: string }
  /** Every n minutes. Counted from the last run time (or from the time it was enabled if none). */
  | { readonly kind: 'interval'; readonly minutes: number }
  | { readonly kind: 'cron'; readonly expression: string }
  /**
   * TODO 629: exactly once at this date and time. `at` is a date-time string in this machine's local time (the value of `<input type="datetime-local">`,
   * no time zone, `"YYYY-MM-DDTHH:MM"`). After it runs, the job is disabled (`JobScheduler`, not deleted).
   */
  | { readonly kind: 'once'; readonly at: string }

export type ScheduleSpecKind = ScheduleSpec['kind']
/** Choices on the screen. `weekdays` is not offered (a special form of `days`, TODO 527). */
export const SCHEDULE_SPEC_KINDS: readonly ScheduleSpecKind[] = ['daily', 'days', 'interval', 'cron', 'once']

/**
 * TODO 629: how far past its time a "run once" schedule may still be run, when aios was stopped and launched after the time passed.
 * If it is past by more than this, it is not run but skipped and reported (owner decision 2026-10-10).
 */
export const ONCE_CATCH_UP_LIMIT_MS = 24 * 60 * 60 * 1000

function isWeekday(value: unknown): value is Weekday {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6
}

/** Arranges weekdays without duplicates in Monday-first order (makes one form for saving and comparing). */
export function normalizeWeekdays(days: Iterable<Weekday>): Weekday[] {
  const set = new Set(days)
  return WEEK_ORDER.filter((day) => set.has(day))
}

/** Rewrites the old `weekdays` into `days` and arranges the order of `days`. Everything else is as is (TODO 527). */
export function normalizeScheduleSpec(spec: ScheduleSpec): ScheduleSpec {
  if (spec.kind === 'weekdays') return { kind: 'days', days: [...WORKDAYS], time: spec.time }
  if (spec.kind === 'days') return { kind: 'days', days: normalizeWeekdays(spec.days), time: spec.time }
  return spec
}

/**
 * What a job does. (b) a scheduled prompt (`'prompt'`, stage 1) and (a) a periodic task declared by a plugin
 * (`'plugin'`, added by TODO 372 / wave 20 bundle B as **a shape only**. The implementation that starts the plugin-host is Phase 5).
 */
export type ScheduledJobAction = ScheduledPromptAction | ScheduledPluginAction | ScheduledReminderAction
export type ScheduledJobKind = ScheduledJobAction['kind']
/** TODO 1265: the kinds the user can create from the editor (a plugin task is made from its declaration only). */
export const USER_JOB_KINDS: readonly ('prompt' | 'reminder')[] = ['prompt', 'reminder']

/**
 * Scheduled prompt: starts a **new thread every time** with the fixed working folder and Model / Thinking, and
 * sends the prompt (it does not continue with `--resume`, owner decision 2026-10-03).
 */
export interface ScheduledPromptAction {
  readonly kind: 'prompt'
  readonly prompt: string
  /** Working folder (`file://`). null means "no affiliation" (the thread-only scratch area, T19). */
  readonly cwdUri: string | null
  /** null means the backend default. */
  readonly modelId: string | null
  readonly thinking: ThinkingLevel | null
  /** Strict mode (T12). The default (167), the same as ordinary threads, is false. */
  readonly approvalStrict: boolean
  /**
   * TODO 972: the role (Teammate) the job starts its conversation under. While the role exists, its working folder, Model / Thinking and
   * standing instructions are used (the three fields above are kept only as the fallback for a deleted role). Omitted means no role.
   */
  readonly roleId?: string
}

/**
 * A plugin's periodic task (TODO 372, owner decision 2026-10-03). **The plugin only declares it in the manifest**
 * (`scheduledTasks`, 7.2), and it is aios's `JobScheduler` that counts the time. A plugin has neither its own timer nor
 * a runtime registration API. A task is code only (import, indexing, notification) and **has no
 * capability to start a CLI turn** - only the scheduled-prompt jobs the user creates call the model.
 *
 * Rows are made by main from the declarations (`JobScheduler.syncPluginTasks`) - they cannot be created from the renderer, and
 * the user can change only the time notation and enabled. **Disabled on installation**. This wave is a shape only, and a run that comes due is
 * recorded as "unsupported" (`unsupported`) and skipped (starting the plugin-host is Phase 5, `aios.gmail`).
 */
export interface ScheduledPluginAction {
  readonly kind: 'plugin'
  /** Id of the declaring plugin (such as `aios.gmail`). */
  readonly pluginId: string
  /** `scheduledTasks[].id` of the manifest (such as `fetch`). */
  readonly taskId: string
}

/**
 * TODO 1265: a reminder (alarm). When its time comes it **only shows a desktop notification** - it starts no thread, calls no model and
 * does not start the CLI. The title is the job's `name`; `body` is an optional short text (may be empty). Time, repetition and
 * several reminders reuse the scheduled-job mechanism as is (owner decision 2026-11-20). Snoozing is kept per row (`ScheduledJob.snoozedUntil`).
 */
export interface ScheduledReminderAction {
  readonly kind: 'reminder'
  readonly body: string
}

/** Upper limit of a plugin task id (the same as the manifest validation). */
export const MAX_PLUGIN_TASK_ID = 64

/**
 * The shape the renderer sends on add / update. main re-validates it with `validateScheduledJobInput`.
 *
 * `maxRuns` (TODO 725): the upper limit on the number of runs. null = unlimited. **Omitted is read the same as unlimited**
 * (optional for backward compatibility with old callers and tests). Not applied to "run once" (`spec.kind === 'once'`)
 * (the mechanism of 629 already handles once) - it is forced to null when saving.
 */
export interface ScheduledJobInput {
  readonly name: string
  readonly enabled: boolean
  readonly spec: ScheduleSpec
  readonly action: ScheduledJobAction
  readonly maxRuns?: number | null
}

/** The previous result. */
export type ScheduledJobOutcome =
  /** Started a thread and sent. */
  | 'started'
  /** Skipped because the previous run was still running. */
  | 'skipped'
  /** Could not start (`lastError` holds a reason code). */
  | 'failed'
  /**
   * The time came, but it was a kind that this version cannot run (a plugin task, TODO 372. Until Phase 5).
   * Like a skipped run, it keeps that run's scheduled time in `lastSkipAt`.
   */
  | 'unsupported'

/** One row of the settings screen's list. */
export interface ScheduledJob extends ScheduledJobInput {
  readonly id: string
  readonly createdAt: number
  readonly updatedAt: number
  /** The last time it ran (both scheduled and run-now). */
  readonly lastRunAt: number | null
  /** The thread started last. */
  readonly lastThreadId: string | null
  readonly lastOutcome: ScheduledJobOutcome | null
  /** The reason for `lastOutcome === 'failed'` (a reason code or raw text). */
  readonly lastError: string | null
  /**
   * When `lastOutcome === 'skipped'`, the scheduled time of **the skipped run itself** (TODO 351).
   * `lastRunAt` stays at the time of the previous run that **ran**, so the two are shown separately.
   */
  readonly lastSkipAt: number | null
  /** The next scheduled time. null if disabled or the expression has no schedule. If in the past, "it catches up at the next check". */
  readonly nextRunAt: number | null
  /** The thread started last is still running (responding or awaiting approval). */
  readonly running: boolean
  /** TODO 725: the run-count limit. null = unlimited (always has a value. main normalizes an omitted input to null). */
  readonly maxRuns: number | null
  /** TODO 725: the number of runs that actually ran (skipped and unsupported runs are not counted). */
  readonly runCount: number
  /**
   * TODO 1265: a reminder's snooze - the time it will notify again (epoch ms), or null. Independent of the repeat's next time
   * (`nextRunAt`). Always null for other kinds.
   */
  readonly snoozedUntil: number | null
  /** TODO 1265: true on a reminder the AI registered through the gateway (shown with a small mark in the list). Absent otherwise. */
  readonly byAi?: boolean
}

/**
 * TODO 725: whether the row was disabled by using up its run count (distinguished from a row disabled by hand - only used-up rows
 * show "done (N/N)" in the list). Always false when `maxRuns` is unlimited (null).
 */
export function isScheduleCompleted(job: Pick<ScheduledJob, 'enabled' | 'maxRuns' | 'runCount'>): boolean {
  return !job.enabled && job.maxRuns !== null && job.runCount >= job.maxRuns
}

/**
 * TODO 628: a reservation to resume a thread after the usage limit is lifted (0 or 1 per thread).
 * It rides on 629's "run once" mechanism inside main (`StoredResumeAction` in `src/main/schedule/store.ts`), but it is passed
 * to the renderer not as a list row but through `ScheduleOverview.resumeReservations`
 * (not shown in `ScheduleList` / `ScheduleEditor` - the place to show it is `ResumeBar`'s own row, per the owner decision).
 */
export interface ResumeReservation {
  readonly id: string
  readonly threadId: string
  /** The time it is scheduled to send (lift + 5 minutes, fixed). */
  readonly at: number
}

/**
 * TODO 989: one message reserved with the Composer's "send later" (any number per thread). When the time comes, it becomes
 * an ordinary send to the same thread (`SessionManager.send`). A different kind from 628's `ResumeReservation` (it does not depend on an interruption mark).
 * Only a `preview` truncated for the list is passed to the renderer (the full text is in main's row).
 */
export interface LaterSend {
  readonly id: string
  readonly threadId: string
  /** The time it is scheduled to send (epoch ms). */
  readonly at: number
  /** The start of the body (newlines become spaces, up to `LATER_PREVIEW_CHARS`). */
  readonly preview: string
  /** Number of attachments. */
  readonly attachments: number
  /**
   * Could not be sent (automatic retries ran out, or it stopped in the middle of the previous launch). The row is kept rather than deleted, and the user
   * chooses "send again" or "put back in the input box" (review, TODO 989).
   */
  readonly failed: boolean
  /** The reason when `failed` (a reason code or a message). */
  readonly error: string | null
}

/** Length of `LaterSend.preview`. */
export const LATER_PREVIEW_CHARS = 80
/** Upper limit of a reservation's body (the same as 628's resume sentence). */
export const LATER_MAX_TEXT = 20_000
/** Upper limit of the number of attachments a reservation can hold. */
export const LATER_MAX_ATTACHMENTS = 20

/** An attachment passed to `schedule.reserveLater`. A `file:` URI is re-validated and read by main when sending (989). */
export interface LaterAttachment {
  readonly uri: string
  readonly name: string
  readonly kind: 'image' | 'reference'
  readonly mediaType: string | null
  readonly bytes: number
  /** Only for a pasted image (a URI that does not point to a file). Otherwise it is not held, and is read again when sending. */
  readonly base64?: string
  /** The reduced version shown in the timeline after sending (TODO 550, the same as an ordinary send. main re-validates it when sending). */
  readonly thumbnail?: string
}

/** Per-message model / thinking (the same meaning as `SendInput` of an ordinary send. Omitted means the thread's default). */
export interface LaterSettings {
  readonly modelId?: string | null
  readonly thinking?: ThinkingLevel | null
  readonly settingsScope?: 'message' | 'thread'
}

export interface LaterInput extends LaterSettings {
  readonly text: string
  readonly attachments: readonly LaterAttachment[]
  /** The send time (epoch ms). */
  readonly at: number
}

/** What `schedule.takeLater` returns, to put back in the input box (the row disappears). */
export interface LaterTaken extends LaterSettings {
  readonly text: string
  readonly attachments: readonly LaterAttachment[]
}

/** The information the settings screen fetches at once. */
export interface ScheduleOverview {
  readonly jobs: readonly ScheduledJob[]
  /**
   * Whether this instance runs scheduled jobs. False in a proxy-verification copy (`--user-data-dir` / `AIOS_DISABLE_AGENT`)
   * - so jobs copied from the real DB are not run twice (TODO 323, item 186).
   */
  readonly autoRun: boolean
  /** TODO 628: all resume reservations currently active. */
  readonly resumeReservations: readonly ResumeReservation[]
  /** TODO 989: all "send later" reservations currently active (earliest first). */
  readonly laterSends: readonly LaterSend[]
}

// ---------------------------------------------------------------------------
// Simple form
// ---------------------------------------------------------------------------

const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** Splits `HH:MM` (24-hour) into hour and minute. null if malformed. */
export function parseTimeOfDay(text: string): { hour: number; minute: number } | null {
  const match = TIME_PATTERN.exec(text.trim())
  if (match === null) return null
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

/** Normalizes `H:M` to `HH:MM`. */
export function formatTimeOfDay(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Cron expression (5 fields)
// ---------------------------------------------------------------------------

/** A parsed cron expression. Each field is a set of "matching values". */
export interface CronSchedule {
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly days: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  /** 0 = Sunday ... 6 = Saturday (7 is folded into 0). */
  readonly weekdays: ReadonlySet<number>
  /** Whether the day field is `*` (used for the OR judgment when both day and weekday are specified). */
  readonly anyDay: boolean
  readonly anyWeekday: boolean
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface FieldRange {
  readonly min: number
  readonly max: number
  readonly names?: readonly string[]
  /** The value that name index 0 stands for (months start at 1). */
  readonly nameBase?: number
}

const FIELDS: readonly FieldRange[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  // Weekday accepts 0-7, and 7 (Sunday) is folded into 0.
  { min: 0, max: 7, names: WEEKDAY_NAMES, nameBase: 0 }
]

function parseValue(text: string, field: FieldRange): number | null {
  if (/^\d+$/.test(text)) {
    const value = Number(text)
    return value >= field.min && value <= field.max ? value : null
  }
  const at = field.names?.indexOf(text.toLowerCase()) ?? -1
  return at === -1 ? null : at + (field.nameBase ?? 0)
}

/** One field into a set. null if malformed. */
function parseField(text: string, field: FieldRange): Set<number> | null {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    if (part === '') return null
    const [rangeText, stepText, extra] = part.split('/')
    if (extra !== undefined || rangeText === undefined) return null
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return null
      step = Number(stepText)
      if (step < 1) return null
    }
    let start: number
    let end: number
    if (rangeText === '*') {
      start = field.min
      end = field.max
    } else {
      const bounds = rangeText.split('-')
      if (bounds.length > 2) return null
      const low = parseValue(bounds[0] ?? '', field)
      if (low === null) return null
      start = low
      if (bounds.length === 2) {
        const high = parseValue(bounds[1] ?? '', field)
        if (high === null || high < low) return null
        end = high
      } else {
        // `5/15` means "from 5 up to the maximum, every 15" (the same as Vixie cron).
        end = stepText === undefined ? low : field.max
      }
    }
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return values
}

/** Parses a 5-field cron expression. null if malformed. */
export function parseCron(expression: string): CronSchedule | null {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const sets: Set<number>[] = []
  for (let i = 0; i < 5; i += 1) {
    const set = parseField(parts[i] ?? '', FIELDS[i] as FieldRange)
    if (set === null || set.size === 0) return null
    sets.push(set)
  }
  const weekdays = new Set([...(sets[4] as Set<number>)].map((d) => (d === 7 ? 0 : d)))
  return {
    minutes: sets[0] as Set<number>,
    hours: sets[1] as Set<number>,
    days: sets[2] as Set<number>,
    months: sets[3] as Set<number>,
    weekdays,
    // Vixie cron's DOM_STAR / DOW_STAR: starting with `*` (including `*/2`) is treated as a star (TODO 842).
    anyDay: (parts[2] ?? '').startsWith('*'),
    anyWeekday: (parts[4] ?? '').startsWith('*')
  }
}

/**
 * Whether the day matches. If **both** day and weekday do not start with `*`, **either** is enough. If either starts with `*`
 * (including `*\/2`), the day must satisfy **both** (the same as Vixie cron's DOM_STAR / DOW_STAR. A plain `*` includes every day, so
 * when only one is specified, that one alone decides).
 */
function dayMatches(cron: CronSchedule, date: Date): boolean {
  const dom = cron.days.has(date.getDate())
  const dow = cron.weekdays.has(date.getDay())
  if (cron.anyDay || cron.anyWeekday) return dom && dow
  return dom || dow
}

const MINUTE_MS = 60_000

/** Whether this is the second occurrence of the same wall-clock time on a day the clock goes back (rebuilding from local time resolves it to the first). */
function isRepeatedWallTime(date: Date): boolean {
  const first = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), 0, 0)
  return first.getTime() !== date.getTime()
}

/** Upper limit of the search range (years). So an expression that never matches, such as February 30, does not loop forever. */
const CRON_SEARCH_YEARS = 5

/** The first match **after** `after` (at the start of a minute). null if none. */
export function nextCronTime(cron: CronSchedule, after: number): number | null {
  const start = new Date(after)
  // From the start of the next minute. Minutes advance in epoch milliseconds (TODO 842): rebuilding from local-time fields would,
  // from the second pass of an hour that repeats when DST ends, go back to the first pass (about an hour earlier).
  let date = new Date((Math.floor(after / MINUTE_MS) + 1) * MINUTE_MS)
  const limit = start.getFullYear() + CRON_SEARCH_YEARS
  while (date.getFullYear() <= limit) {
    // Do not use the second pass of an hour that repeats on a day the clock goes back (match the first. Like Vixie cron, do not run twice at the same time).
    if (isRepeatedWallTime(date)) {
      date = new Date(date.getTime() + MINUTE_MS)
      continue
    }
    if (!cron.months.has(date.getMonth() + 1)) {
      date = new Date(date.getFullYear(), date.getMonth() + 1, 1, 0, 0, 0, 0)
      continue
    }
    if (!dayMatches(cron, date)) {
      date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0)
      continue
    }
    if (!cron.hours.has(date.getHours())) {
      const curHour = date.getHours()
      const requestedHour = curHour + 1
      const advanced = new Date(date.getFullYear(), date.getMonth(), date.getDate(), requestedHour, 0, 0, 0)
      // On a day the clock moves forward for DST, if `requestedHour` does not exist, `advanced` is normalized to the first existing
      // time after it (same day, month and year). If there is a time that falls in that "skipped" band,
      // match it once at the existing time right after the jump, like Vixie cron (TODO 540).
      if (
        requestedHour < 24 &&
        advanced.getFullYear() === date.getFullYear() &&
        advanced.getMonth() === date.getMonth() &&
        advanced.getDate() === date.getDate() &&
        advanced.getHours() !== requestedHour
      ) {
        for (let skipped = requestedHour; skipped < advanced.getHours(); skipped++) {
          if (cron.hours.has(skipped)) return advanced.getTime()
        }
      }
      date = advanced
      continue
    }
    if (!cron.minutes.has(date.getMinutes())) {
      date = new Date(date.getTime() + MINUTE_MS)
      continue
    }
    return date.getTime()
  }
  return null
}

// ---------------------------------------------------------------------------
// Common entry points for the notations
// ---------------------------------------------------------------------------

/**
 * Turns the simple form's daily / weekdays into a cron expression (so the calculation is done by cron alone). Weekdays are an ascending list of numbers
 * (`0 9 * * 1,3,5`). An empty `days` cannot be made an expression, so null (the caller turns it into `schedule-days-empty`).
 */
export function specToCron(spec: ScheduleSpec): string | null {
  switch (spec.kind) {
    case 'daily':
    case 'weekdays':
    case 'days': {
      const time = parseTimeOfDay(spec.time)
      if (time === null) return null
      let days = '*'
      if (spec.kind === 'weekdays') days = '1-5'
      else if (spec.kind === 'days') {
        if (spec.days.length === 0) return null
        days = [...new Set(spec.days)].sort((a, b) => a - b).join(',')
      }
      return `${time.minute} ${time.hour} * * ${days}`
    }
    case 'cron':
      return spec.expression
    case 'interval':
    case 'once':
      return null
  }
}

/** Turns `at` of `once` into epoch milliseconds in local time. null if unreadable. */
function parseOnceAt(at: string): number | null {
  // `Date.parse` reads a date-time string without a time zone (the value of `datetime-local`) as this machine's local time.
  const ms = Date.parse(at)
  return Number.isFinite(ms) ? ms : null
}

/** The result of validating a notation. */
export type ScheduleSpecProblem =
  /** Cannot be read as HH:MM. */
  | 'schedule-time-invalid'
  /** Cannot be read as a cron expression (not 5 fields, out of range, or no matching time). */
  | 'schedule-cron-invalid'
  /** The interval is shorter than the minimum (for a cron expression, some gap between 2 consecutive runs is shorter than the minimum). */
  | 'schedule-too-frequent'
  /** The interval is longer than the maximum or not an integer. */
  | 'schedule-interval-invalid'
  /** No weekday is selected (TODO 527). */
  | 'schedule-days-empty'
  /** TODO 629: the "run once" date and time cannot be read. */
  | 'schedule-once-invalid'
  /** TODO 629 (code-review): a valid "run once" date and time is in the past (saving it would not run, and it would stay enabled). */
  | 'schedule-once-past'
  /** TODO 725: the run-count limit is not an integer of at least 1, or exceeds the limit (`MAX_SCHEDULE_MAX_RUNS`). */
  | 'schedule-max-runs-invalid'

/** One notation in a form that allows time calculation. */
type CompiledSpec =
  | { readonly kind: 'interval'; readonly minutes: number }
  | { readonly kind: 'cron'; readonly cron: CronSchedule }
  | { readonly kind: 'once'; readonly at: number }

function compile(spec: ScheduleSpec): CompiledSpec | ScheduleSpecProblem {
  if (spec.kind === 'interval') {
    const minutes = spec.minutes
    if (!Number.isInteger(minutes) || minutes > MAX_SCHEDULE_INTERVAL_MINUTES) return 'schedule-interval-invalid'
    if (minutes < MIN_SCHEDULE_INTERVAL_MINUTES) return 'schedule-too-frequent'
    return { kind: 'interval', minutes }
  }
  if (spec.kind === 'once') {
    const at = parseOnceAt(spec.at)
    return at === null ? 'schedule-once-invalid' : { kind: 'once', at }
  }
  if (spec.kind === 'days' && spec.days.length === 0) return 'schedule-days-empty'
  const expression = specToCron(spec)
  if (expression === null) return 'schedule-time-invalid'
  const cron = parseCron(expression)
  if (cron === null) return spec.kind === 'cron' ? 'schedule-cron-invalid' : 'schedule-time-invalid'
  return { kind: 'cron', cron }
}

/**
 * The first schedule after `anchor`. `interval` is `anchor + n minutes`, otherwise it is the cron's next match.
 * null if the notation is broken.
 */
export function nextScheduleTime(spec: ScheduleSpec, anchor: number): number | null {
  const compiled = compile(spec)
  if (typeof compiled === 'string') return null
  if (compiled.kind === 'interval') return anchor + compiled.minutes * 60_000
  // TODO 629: "run once" has no repetition. If the anchor is before that time, return it just once.
  if (compiled.kind === 'once') return anchor < compiled.at ? compiled.at : null
  return nextCronTime(compiled.cron, anchor)
}

/**
 * TODO 629 (wave 29 code-review): if a **valid** "run once" date and time is at or before `from`, `schedule-once-past`.
 * `nextScheduleTime` returns null for a past `at`, so saving it as is would not run and would stay enabled.
 * Disabled rows (such as fixing only the name of a row that ran and was disabled) are not checked. Unreadable date-times are on `checkScheduleSpec`'s side.
 */
export function checkOnceNotPast(
  spec: ScheduleSpec,
  enabled: boolean,
  from: number = Date.now()
): 'schedule-once-past' | null {
  if (!enabled || spec.kind !== 'once') return null
  const at = parseOnceAt(spec.at)
  return at !== null && at <= from ? 'schedule-once-past' : null
}

/**
 * TODO 725: validates the run-count limit. `null` / `undefined` mean unlimited and are fine. null if there is no problem.
 * The callers (main / the renderer's form) stop before saving with the same function.
 */
export function checkMaxRuns(maxRuns: number | null | undefined): 'schedule-max-runs-invalid' | null {
  if (maxRuns === null || maxRuns === undefined) return null
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > MAX_SCHEDULE_MAX_RUNS) return 'schedule-max-runs-invalid'
  return null
}

/** How far ahead the interval check looks (days). 7 days, the full cycle of the weekday order, plus some margin. */
const GAP_CHECK_DAYS = 8
/** Upper limit of matches counted in the interval check (with the 5-minute minimum, 8 days gives 2304 runs; a cron expression stepping every minute is refused earlier by the minimum). */
const GAP_CHECK_MAX_HITS = 1000

/**
 * Validates a notation. null if there is no problem. `from` is the time to start examining the cron expression's intervals (default now).
 * A cron expression is refused if **anywhere two consecutive runs are closer than the minimum** within 8 days
 * (`*\/5 * * * *` or `0,5 9 * * *`).
 */
export function checkScheduleSpec(spec: ScheduleSpec, from: number = Date.now()): ScheduleSpecProblem | null {
  const compiled = compile(spec)
  if (typeof compiled === 'string') return compiled
  if (compiled.kind === 'interval' || compiled.kind === 'once') return null
  const first = nextCronTime(compiled.cron, from)
  if (first === null) return 'schedule-cron-invalid'
  const end = from + GAP_CHECK_DAYS * 86_400_000
  let previous = first
  for (let hits = 0; hits < GAP_CHECK_MAX_HITS; hits += 1) {
    const next = nextCronTime(compiled.cron, previous)
    if (next === null || next > end) return null
    if (next - previous < MIN_SCHEDULE_INTERVAL_MINUTES * 60_000) return 'schedule-too-frequent'
    previous = next
  }
  return null
}

/**
 * The number of runs per day (shown on the settings screen; the cost itself is not shown - constraint 4 / item 165).
 * **The count of the busiest day within 7 days from today** (a weekday-only job is also shown as 1).
 * `interval` is the number that fits in 1 day (1440 minutes) - **since TODO 725 widened the limit to 7 days, less than once a day
 * (`minutes > 1440`) returns 0** (this used to be floored with `Math.max(1, …)`, but in the range of 15 to 1440 minutes
 * the floor was already 1 or more, so the floor never took effect. The caller (`describePerDay` in `schedule-format.ts`)
 * words 0 as "less than once a day"). A broken notation is also 0 (as before).
 */
export function runsPerDay(spec: ScheduleSpec, from: number = Date.now()): number {
  const compiled = compile(spec)
  if (typeof compiled === 'string') return 0
  if (compiled.kind === 'interval') return Math.floor(1440 / compiled.minutes)
  // TODO 629: "run once" is 1 if it comes within the next 7 days, otherwise (past or further ahead) 0.
  if (compiled.kind === 'once') return compiled.at >= from && compiled.at < from + 7 * 86_400_000 ? 1 : 0
  const start = new Date(from)
  let most = 0
  for (let day = 0; day < 7; day += 1) {
    const dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day, 0, 0, 0, 0)
    const dayEnd = new Date(start.getFullYear(), start.getMonth(), start.getDate() + day + 1, 0, 0, 0, 0)
    let count = 0
    // Search from 1 ms earlier so a match exactly at 0:00 is also counted.
    let at = nextCronTime(compiled.cron, dayStart.getTime() - 1)
    while (at !== null && at < dayEnd.getTime() && count < 1440) {
      count += 1
      at = nextCronTime(compiled.cron, at)
    }
    most = Math.max(most, count)
  }
  return most
}

// ---------------------------------------------------------------------------
// Input validation (main re-validates IPC values; the renderer stops with the same judgment before saving)
// ---------------------------------------------------------------------------

/** Input problems (reason codes, listed under the same names in `shared/reason.ts`). */
export type ScheduledJobProblem =
  | ScheduleSpecProblem
  | 'schedule-name-empty'
  | 'schedule-prompt-empty'
  | 'invalid-value'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads a value from IPC / the table's JSON as a `ScheduleSpec` (shape only. The time contents and empty weekdays are for `checkScheduleSpec`).
 * **The old `weekdays` is converted here to `days: [1..5]`** (TODO 527) - table rows are not rewritten, they are fixed on every read.
 * The next time that row is saved, it is written with `days`. `days` is deduplicated and arranged in Monday-first order.
 */
export function readScheduleSpec(value: unknown): ScheduleSpec | null {
  if (!isRecord(value)) return null
  switch (value['kind']) {
    case 'daily':
      return typeof value['time'] === 'string' ? { kind: 'daily', time: value['time'].trim() } : null
    case 'weekdays':
      return typeof value['time'] === 'string'
        ? normalizeScheduleSpec({ kind: 'weekdays', time: value['time'].trim() })
        : null
    case 'days': {
      const days = value['days']
      if (typeof value['time'] !== 'string' || !Array.isArray(days) || !days.every(isWeekday)) return null
      return { kind: 'days', days: normalizeWeekdays(days), time: value['time'].trim() }
    }
    case 'interval':
      return typeof value['minutes'] === 'number' ? { kind: 'interval', minutes: value['minutes'] } : null
    case 'cron':
      return typeof value['expression'] === 'string'
        ? { kind: 'cron', expression: value['expression'].trim().replace(/\s+/g, ' ') }
        : null
    case 'once':
      return typeof value['at'] === 'string' ? { kind: 'once', at: value['at'].trim() } : null
    default:
      return null
  }
}

/** Validates a job input that came through IPC. A reason code if there is a problem, otherwise the cleaned-up input. */
export function validateScheduledJobInput(
  value: unknown,
  from: number = Date.now()
): ScheduledJobInput | ScheduledJobProblem {
  if (!isRecord(value)) return 'invalid-value'
  const name = typeof value['name'] === 'string' ? value['name'].trim().slice(0, MAX_SCHEDULE_NAME) : null
  if (name === null) return 'invalid-value'
  if (name === '') return 'schedule-name-empty'
  const spec = readScheduleSpec(value['spec'])
  if (spec === null) return 'invalid-value'
  const problem = checkScheduleSpec(spec, from)
  if (problem !== null) return problem
  const enabled = value['enabled'] !== false
  const past = checkOnceNotPast(spec, enabled, from)
  if (past !== null) return past
  // TODO 725: the run-count limit. Omitted / null means unlimited. Not applied to "run once" (629 already handles it) -
  // always saved as null (whatever is in the input is ignored).
  const maxRunsRaw = value['maxRuns']
  const maxRunsProblem = checkMaxRuns(typeof maxRunsRaw === 'number' ? maxRunsRaw : maxRunsRaw == null ? null : NaN)
  if (maxRunsProblem !== null) return maxRunsProblem
  const maxRuns = spec.kind === 'once' || maxRunsRaw == null ? null : (maxRunsRaw as number)
  const action = value['action']
  if (!isRecord(action)) return 'invalid-value'
  if (action['kind'] === 'plugin') {
    // Only the shape is validated. A plugin job cannot be created from the renderer, and even on update main uses the table's values
    // (`JobScheduler.create` / `update`, TODO 372).
    const pluginId = action['pluginId']
    const taskId = action['taskId']
    if (typeof pluginId !== 'string' || pluginId === '' || pluginId.length > MAX_PLUGIN_TASK_ID) return 'invalid-value'
    if (typeof taskId !== 'string' || taskId === '' || taskId.length > MAX_PLUGIN_TASK_ID) return 'invalid-value'
    return { name, enabled, spec, action: { kind: 'plugin', pluginId, taskId }, maxRuns }
  }
  if (action['kind'] === 'reminder') {
    // TODO 1265: only a title (the name) and an optional short body. No folder, model or approval fields exist for this kind.
    const body = action['body'] === undefined ? '' : action['body']
    if (typeof body !== 'string' || body.length > MAX_REMINDER_BODY) return 'invalid-value'
    return { name, enabled, spec, maxRuns, action: { kind: 'reminder', body: body.trim() } }
  }
  if (action['kind'] !== 'prompt') return 'invalid-value'
  const prompt = typeof action['prompt'] === 'string' ? action['prompt'] : null
  if (prompt === null) return 'invalid-value'
  if (prompt.trim() === '') return 'schedule-prompt-empty'
  if (prompt.length > MAX_SCHEDULE_PROMPT) return 'invalid-value'
  const cwdUri = action['cwdUri']
  if (cwdUri !== null && typeof cwdUri !== 'string') return 'invalid-value'
  const modelId = action['modelId']
  if (modelId !== null && typeof modelId !== 'string') return 'invalid-value'
  const thinking = action['thinking']
  if (thinking !== null && !isThinkingLevel(thinking)) return 'invalid-value'
  // TODO 972: omitted / null / '' means no role. main checks nothing more here: a role that does not exist is "no role" at launch.
  const roleId = action['roleId'] ?? null
  if (roleId !== null && (typeof roleId !== 'string' || roleId.length > 200)) return 'invalid-value'
  return {
    name,
    enabled,
    spec,
    maxRuns,
    action: {
      kind: 'prompt',
      prompt,
      cwdUri,
      modelId,
      thinking,
      // TODO 1015: the default is OFF (omitted is also false). The "default ON" of 959 was overturned.
      approvalStrict: action['approvalStrict'] === true,
      ...(roleId === null || roleId === '' ? {} : { roleId })
    }
  }
}
