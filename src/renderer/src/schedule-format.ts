/**
 * Pure display functions for the scheduled-run (TODO 323) settings screen. Independent of React and the DOM
 * (`test/schedule-format.test.ts`). The time computation itself is `@shared/schedule.ts` (the same functions as main).
 */
import type {
  ScheduleSpec,
  ScheduledJob,
  ScheduledJobInput,
  ScheduledPromptAction,
  ScheduledReminderAction,
  Weekday
} from '@shared/schedule.js'
import {
  WEEK_ORDER,
  WORKDAYS,
  formatTimeOfDay,
  isScheduleCompleted,
  normalizeScheduleSpec,
  normalizeWeekdays,
  parseTimeOfDay
} from '@shared/schedule.js'
import type { Translate } from './i18n/index.js'

/**
 * TODO 739: the reason code when main would refuse "Run now" (the same 2 conditions as `ScheduledJobScheduler.runNow`,
 * in the same order), or null if it can be pressed (would not be refused). Both the list and the editor render the button
 * as disabled and show it in a bubble. This treats 629's used-up "once only" and 725's used-up run-count limit
 * the same way (pressing either just produced a failure band).
 */
export function scheduleRunNowBlocked(
  job: Pick<ScheduledJob, 'spec' | 'enabled' | 'maxRuns' | 'runCount'>
): 'schedule-once-used' | 'schedule-max-runs-used' | null {
  if (job.spec.kind === 'once' && !job.enabled) return 'schedule-once-used'
  if (isScheduleCompleted(job)) return 'schedule-max-runs-used'
  return null
}

/** Whether the weekday lists are the same (sorted before comparing). */
function sameDays(a: readonly Weekday[], b: readonly Weekday[]): boolean {
  const left = normalizeWeekdays(a)
  const right = normalizeWeekdays(b)
  return left.length === right.length && left.every((day, i) => day === right[i])
}

/** The short weekday names, ordered Monday-first (the Japanese "Mon, Wed, Fri" form, or "Mon, Wed, Fri" in English; TODO 527). */
export function describeDays(t: Translate, days: readonly Weekday[]): string {
  return normalizeWeekdays(days)
    .map((day) => t(`schedule.day.${day}`))
    .join(t('schedule.daySeparator'))
}

/**
 * One-line summary of the schedule spec ("Every day 08:00", "Mon, Wed, Fri 09:00", "Every 30 minutes", "cron: 0 8 * * 1-5").
 * For weekday specs, all 7 days show "Every day" and Monday to Friday shows "Weekdays" (the old `weekdays` rows also show "Weekdays").
 */
export function describeSpec(t: Translate, raw: ScheduleSpec): string {
  const spec = normalizeScheduleSpec(raw)
  switch (spec.kind) {
    case 'daily':
    case 'weekdays':
    case 'days': {
      const time = parseTimeOfDay(spec.time)
      const text = time === null ? spec.time : formatTimeOfDay(time.hour, time.minute)
      if (spec.kind !== 'days' || sameDays(spec.days, WEEK_ORDER)) return t('schedule.summary.daily', { time: text })
      if (sameDays(spec.days, WORKDAYS)) return t('schedule.summary.weekdays', { time: text })
      return t('schedule.summary.days', { days: describeDays(t, spec.days), time: text })
    }
    case 'interval':
      return t('schedule.summary.interval', { minutes: spec.minutes })
    case 'cron':
      return t('schedule.summary.cron', { expression: spec.expression })
    case 'once': {
      const atMs = Date.parse(spec.at)
      if (Number.isNaN(atMs)) return t('schedule.summary.onceInvalid')
      const date = new Date(atMs)
      return t('schedule.summary.once', {
        month: date.getMonth() + 1,
        day: date.getDate(),
        time: formatTimeOfDay(date.getHours(), date.getMinutes())
      })
    }
  }
}

/** The default "once only" date and time (1 hour from now, in the form of an `<input type="datetime-local">` value). */
export function defaultOnceAt(now: number = Date.now()): string {
  const date = new Date(now + 60 * 60_000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The scheduled time ("Today 08:00", "Tomorrow 08:00", "10/7 08:00"). */
export function formatScheduleWhen(t: Translate, at: number, now: number = Date.now()): string {
  const date = new Date(at)
  const time = formatTimeOfDay(date.getHours(), date.getMinutes())
  const today = new Date(now)
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
  if (date.toDateString() === today.toDateString()) return t('schedule.when.today', { time })
  if (date.toDateString() === tomorrow.toDateString()) return t('schedule.when.tomorrow', { time })
  return t('schedule.when.date', { month: date.getMonth() + 1, day: date.getDate(), time })
}

/** The draft for adding. Model / Thinking come from the new-thread defaults (settings). The run count is unlimited by default (TODO 725). */
export function emptyJobDraft(defaults: {
  modelId: ScheduledPromptAction['modelId']
  thinking: ScheduledPromptAction['thinking']
}): ScheduledJobInput {
  return {
    name: '',
    enabled: true,
    spec: { kind: 'daily', time: '08:00' },
    maxRuns: null,
    action: {
      kind: 'prompt',
      prompt: '',
      cwdUri: null,
      modelId: defaults.modelId,
      thinking: defaults.thinking,
      // TODO 1015: the default is OFF. The 959 "default ON" was overturned (it can be enabled per job).
      approvalStrict: false
    }
  }
}

/**
 * TODO 1265: the draft after switching the job's kind in the editor (only while adding). Name, time, repeat count and enabled stay; the
 * action is replaced, so a reminder carries no prompt / folder / model and a prompt starts from the defaults (`emptyJobDraft`).
 */
export function switchJobKind(
  draft: ScheduledJobInput,
  kind: 'prompt' | 'reminder',
  defaults: { modelId: ScheduledPromptAction['modelId']; thinking: ScheduledPromptAction['thinking'] }
): ScheduledJobInput {
  if (draft.action.kind === kind) return draft
  const action: ScheduledPromptAction | ScheduledReminderAction =
    kind === 'reminder' ? { kind: 'reminder', body: '' } : (emptyJobDraft(defaults).action as ScheduledPromptAction)
  return { ...draft, action }
}

/**
 * The new spec when the kind of spec is switched. The time is carried over where possible (every day <-> weekdays; for cron it is converted to
 * an expression with the same time and weekdays), so that merely re-choosing does not lose the time already entered. The first switch
 * to weekdays is Monday to Friday (the same as the old "weekdays"). There is no way to choose the old `weekdays`, but if one arrives it becomes Monday to Friday in `days` (TODO 527).
 */
export function switchSpecKind(raw: ScheduleSpec, kind: ScheduleSpec['kind'], now: number = Date.now()): ScheduleSpec {
  const spec = normalizeScheduleSpec(raw)
  const target = kind === 'weekdays' ? 'days' : kind
  if (spec.kind === target) return spec
  const time = spec.kind === 'daily' || spec.kind === 'days' ? spec.time : '08:00'
  switch (target) {
    case 'daily':
      return { kind: 'daily', time }
    case 'days':
      return { kind: 'days', days: [...WORKDAYS], time }
    case 'interval':
      return { kind: 'interval', minutes: 60 }
    case 'cron': {
      const parsed = parseTimeOfDay(time) ?? { hour: 8, minute: 0 }
      const days =
        spec.kind === 'days' && spec.days.length > 0 ? [...spec.days].sort((a, b) => a - b).join(',') : '*'
      return { kind: 'cron', expression: `${parsed.minute} ${parsed.hour} * * ${days}` }
    }
    case 'once':
      return { kind: 'once', at: defaultOnceAt(now) }
  }
}

/** The list after toggling one weekday checkbox (sorted Monday-first). */
export function toggleWeekday(days: readonly Weekday[], day: Weekday, checked: boolean): Weekday[] {
  return normalizeWeekdays(checked ? [...days, day] : days.filter((d) => d !== day))
}

/**
 * The name in the list and headings. A timed prompt gets ⏰ (same as the mark in the thread list); a plugin task is just the name (the badge is separate, TODO 372).
 * A reminder (TODO 1265) is also just the name - the list row shows its bell icon separately.
 */
export function jobLabel(job: Pick<ScheduledJob, 'name' | 'action'>): string {
  return job.action.kind === 'prompt' ? `⏰ ${job.name}` : job.name
}

/**
 * The "next" line in the list (TODO 372: used by both the sidebar list and the editor in the main area). Disabled jobs and an
 * instance that does not run on schedule (a duplicate) show "stopped".
 *
 * TODO 725: a row disabled because the run-count limit was used up shows "Done (N/N)" (different wording from a row disabled by hand:
 * `isScheduleCompleted` tells them apart by `runCount >= maxRuns`).
 */
export function describeNext(
  t: Translate,
  job: Pick<ScheduledJob, 'enabled' | 'nextRunAt' | 'maxRuns' | 'runCount'>,
  autoRun: boolean,
  now: number
): string {
  if (isScheduleCompleted(job)) return t('schedule.completed', { count: job.runCount, max: job.maxRuns ?? 0 })
  if (!job.enabled || !autoRun) return t('schedule.disabled')
  if (job.nextRunAt === null) return t('schedule.nextNone')
  // TODO 827: for a job with a run-count limit, append the remaining count after the next run.
  const remaining =
    job.maxRuns === null ? '' : ` · ${t('schedule.remaining', { count: Math.max(0, job.maxRuns - job.runCount) })}`
  if (job.nextRunAt <= now) return `${t('schedule.nextCatchUp')}${remaining}`
  return `${t('schedule.next', { when: formatScheduleWhen(t, job.nextRunAt, now) })}${remaining}`
}

/**
 * TODO 725: the wording for runs per day. If `runsPerDay` is 0 (the interval is longer than 1 day, which can happen because TODO 725 widened the
 * interval limit to 7 days), "less than once a day"; otherwise, as before, "{count}× a day".
 */
export function describePerDay(t: Translate, count: number): string {
  return count > 0 ? t('schedule.perDay', { count }) : t('schedule.perDayLessThanOne')
}

/**
 * One line for the previous result. A failure gets its reason (turning the reason into text is the caller's `describeReason`).
 * For a skipped run, show **that run's scheduled time** (`lastSkipAt`, TODO 351), which is a different run from "previous" (`lastRunAt`).
 */
export function describeOutcome(
  t: Translate,
  job: Pick<ScheduledJob, 'lastOutcome' | 'lastError' | 'lastSkipAt'>,
  now: number,
  reason: (code: string | null) => string
): string | null {
  switch (job.lastOutcome) {
    case null:
      return null
    case 'failed':
      return t('schedule.outcome.failed', { reason: reason(job.lastError) })
    case 'skipped':
      return job.lastSkipAt !== null
        ? t('schedule.outcome.skippedAt', { when: formatScheduleWhen(t, job.lastSkipAt, now) })
        : t('schedule.outcome.skipped')
    case 'started':
      return t('schedule.outcome.started')
    case 'unsupported':
      // TODO 372: a run of a plugin task (not executed in this version).
      return job.lastSkipAt !== null
        ? t('schedule.outcome.unsupportedAt', { when: formatScheduleWhen(t, job.lastSkipAt, now) })
        : t('schedule.outcome.unsupported')
  }
}
