/**
 * Editing a recurring run (the main-body side, TODO 372 / wave 20 bundle B. ARCHITECTURE.md 6.2.4).
 *
 * Pressing a row of the sidebar list (`ScheduleList.tsx`) opens this in **the same place as the settings editor** (the ThreadPane
 * area, `App.tsx`), like pressing an extension in VS Code's Extensions view opens its detail on the editor side.
 * It used to double as the list and the in-place form inside the settings category "Scheduled runs" (`ScheduleSettings.tsx`, wave 18 bundle A).
 * The form (`JobForm`) was carried over as is.
 *
 * - Add / edit form: the time is mainly a simple form (daily / specified weekdays / every n minutes), and "Details" gives a 5-field cron expression.
 *   Specified weekdays is Monday-to-Sunday checkboxes (TODO 527, the week starts on Monday; the old "weekdays" is Monday to Friday of this).
 *   While typing it shows the next planned time and the number of runs per day on the spot (the same pure function as main, `@shared/schedule.ts`).
 *   Main re-validates on save. **Cost is not shown** (constraint 4 / item 165), only the count.
 * - An existing job shows a summary on top (next run, runs per day, last result, running) and Run now / Open thread /
 *   Delete. The summary is redrawn from main's push (the draft is not touched).
 * - Closes on save, cancel and delete. If the open job was deleted from another window, it closes.
 *
 * **TODO 724 (wave 34 bundle A)**: each field of the form was aligned to the shape of a Settings item (`settings-item` /
 * `settings-item-title` / `settings-item-description` / `settings-item-control`, the same look as the VS Code
 * settings editor). The actual input of each field is placed by `ScheduleField` (a local component) inside
 * `settings-item-control`. The CSS classes of the inputs themselves (`schedule-field` / `schedule-when`, etc.)
 * are unchanged (the specificity convention of `test/schedule-form-css.test.ts` is also kept). Since the heading moved out,
 * an input that used to be `<label className="schedule-field"><span>heading</span>...</label>` has its heading
 * `<span>` removed and passed to `ScheduleField`'s `title`.
 *
 * **TODO 725**: a minutes / hours unit choice was added to "fixed interval" (it is always saved in minutes; the limit is 10080 minutes = 7 days).
 * A cap on the run count (unlimited / N times) was added to every kind except "once only". For a plugin's task, only the time and enabled state are
 * user-editable, so the field is visible but on save main (`JobScheduler.update`) ignores it and keeps the current value
 * (the same constraint as TODO 372).
 *
 * **TODO 1265**: a "Type" field (only choosable while adding) picks a scheduled prompt or a reminder. A reminder has only a title (the name)
 * and an optional message - the folder / Model / Thinking / prompt / strict fields are not shown. Its summary has "Test notification" instead of
 * Run now, and the snooze buttons (also the fallback when the OS hides the notification's buttons; clicking the notification opens this).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { isThinkingLevel } from '@shared/agent.js'
import type { ThreadCreateOptions } from '@shared/thread.js'
import {
  MIN_SCHEDULE_INTERVAL_MINUTES,
  SCHEDULE_INTERVAL_PRESETS,
  MAX_SCHEDULE_INTERVAL_MINUTES,
  MAX_SCHEDULE_MAX_RUNS,
  MAX_REMINDER_BODY,
  REMINDER_SNOOZE_MINUTES,
  SCHEDULE_SPEC_KINDS,
  USER_JOB_KINDS,
  WEEK_ORDER,
  checkMaxRuns,
  checkOnceNotPast,
  checkScheduleSpec,
  nextScheduleTime,
  normalizeScheduleSpec,
  runsPerDay,
  type ScheduleOverview,
  type ScheduledJob,
  type ScheduledJobInput,
  type ScheduledPromptAction,
  type ScheduledReminderAction,
  type ScheduleSpecKind
} from '@shared/schedule.js'
import { useThreads } from '../threadStore.js'
import { useSchedule } from '../scheduleStore.js'
import { listedModelChoices, modelChoiceLabel, thinkingLabel, thinkingSelectLevels } from '../composer-choice.js'
import { describeReason, useT } from '../i18n/index.js'
import {
  describeNext,
  describeOutcome,
  describePerDay,
  describeSpec,
  emptyJobDraft,
  formatScheduleWhen,
  jobLabel,
  switchJobKind,
  switchSpecKind,
  toggleWeekday
} from '../schedule-format.js'
import { RunNowButton, useScheduleNow } from './ScheduleList.js'
import { Tooltip } from './Tooltip.js'
import { CloseIcon } from '../icons/CloseIcon.js'
import { TriggerEditor } from './TriggerEditor.js'
import { RoleGrantsTable } from './RoleGrantsTable.js'
import { ReminderIcon } from '../icons/ReminderIcon.js'

export function ScheduleEditor(): React.JSX.Element | null {
  const t = useT()
  const editing = useSchedule((state) => state.editing)
  const overview = useSchedule((state) => state.overview)
  const closeEditor = useSchedule((state) => state.closeEditor)
  const job = editing === null || editing.id === null ? null : (overview?.jobs.find((j) => j.id === editing.id) ?? null)
  // If it was deleted from another window (the list arrived but it is not found), close.
  const gone = editing !== null && editing.id !== null && overview !== undefined && job === null
  useEffect(() => {
    if (gone) closeEditor()
  }, [gone, closeEditor])
  // TODO 1216: editing a trigger rule uses the same place (same exclusivity, same way of closing).
  if (editing !== null && editing.trigger !== undefined) {
    return <TriggerEditor key={`${editing.trigger.pluginId}/${editing.trigger.triggerId}`} target={editing.trigger} />
  }
  if (editing === null || gone) return null
  const title = editing.id === null ? t('schedule.editor.newTitle') : t('schedule.editor.editTitle')
  return (
    <div className="thread-pane settings-editor schedule-editor" role="region" aria-label={title}>
      <div className="settings-editor-header schedule-editor-header">
        <h1 className="schedule-editor-title">{job === null ? title : jobLabel(job)}</h1>
        <Tooltip content={t('common.close')}>
          <button
            type="button"
            className="icon-button settings-editor-close"
            onClick={closeEditor}
            aria-label={t('common.close')}
          >
            <CloseIcon />
          </button>
        </Tooltip>
      </div>
      {editing.id !== null && job === null ? (
        <p className="schedule-editor-body hint">{t('common.loading')}</p>
      ) : (
        // When the open job changes, rebuild the draft (key).
        <EditorBody key={editing.id ?? '(new)'} job={job} autoRun={overview?.autoRun ?? true} />
      )}
    </div>
  )
}

function EditorBody({ job, autoRun }: { job: ScheduledJob | null; autoRun: boolean }): React.JSX.Element {
  const t = useT()
  const settings = useThreads((state) => state.settings)
  const selectThread = useThreads((state) => state.selectThread)
  const setOverview = useSchedule((state) => state.setOverview)
  const closeEditor = useSchedule((state) => state.closeEditor)
  const now = useScheduleNow()
  const [options, setOptions] = useState<ThreadCreateOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // The draft starts from the values at open time. A push from main (e.g. it was run) does not rebuild it.
  const [draft, setDraft] = useState<ScheduledJobInput | null>(() =>
    // An old `weekdays` row is opened as Monday to Friday of `days` (TODO 527. Main also fixes it on load, but just in case).
    // TODO 725: `maxRuns` is also kept in the draft (it always has a value; null means unlimited).
    job === null
      ? null
      : {
          name: job.name,
          enabled: job.enabled,
          spec: normalizeScheduleSpec(job.spec),
          action: job.action,
          maxRuns: job.maxRuns
        }
  )

  useEffect(() => {
    let alive = true
    void window.aios.threads.createOptions().then((next) => {
      if (alive) setOptions(next)
    })
    return () => {
      alive = false
    }
  }, [])

  // The draft for adding is built after the default Model / Thinking are known (settings, then the head of the list, in that order).
  const primary = options?.backends.find((b) => b.id === options.defaultBackend) ?? null
  const promptDefaults = useMemo(
    () => ({
      modelId: settings?.defaultModelId ?? primary?.models[0]?.id ?? null,
      thinking: settings?.defaultThinking ?? null
    }),
    [settings, primary]
  )
  useEffect(() => {
    if (job !== null || draft !== null || options === null) return
    setDraft(emptyJobDraft(promptDefaults))
  }, [job, draft, options, promptDefaults])

  /** Calls main and replaces the list. On failure it shows the reason (the form stays open). */
  const act = useCallback(
    async (key: string, call: () => Promise<ScheduleOverview>): Promise<boolean> => {
      setBusy(key)
      setError(null)
      try {
        setOverview(await call())
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return false
      } finally {
        setBusy(null)
      }
    },
    [setOverview]
  )

  const save = async (): Promise<void> => {
    if (draft === null) return
    const input = draft
    const ok = await act('save', () =>
      job === null ? window.aios.schedule.create(input) : window.aios.schedule.update(job.id, input)
    )
    if (ok) closeEditor()
  }

  return (
    <div className="schedule-editor-body">
      {job === null ? <p className="schedule-editor-description">{t('schedule.description')}</p> : null}
      {job === null ? null : (
        <JobSummary
          job={job}
          now={now}
          autoRun={autoRun}
          busy={busy !== null}
          onRunNow={() => void act('run', () => window.aios.schedule.runNow(job.id))}
          onOpenThread={(threadId) => void selectThread(threadId)}
          onSnooze={(minutes) => void act('snooze', () => window.aios.schedule.snooze(job.id, minutes))}
          onCancelSnooze={() => void act('snooze', () => window.aios.schedule.cancelSnooze(job.id))}
          onRemove={async () => {
            if (await act('remove', () => window.aios.schedule.remove(job.id))) closeEditor()
          }}
        />
      )}
      {draft === null ? (
        <p className="hint">{t('common.loading')}</p>
      ) : (
        <JobForm
          draft={draft}
          isNew={job === null}
          promptDefaults={promptDefaults}
          options={options}
          now={now}
          busy={busy === 'save'}
          error={error}
          onChange={setDraft}
          onSave={() => void save()}
          onCancel={closeEditor}
        />
      )}
      {/* TODO 983 stage 2: only for scheduled-prompt jobs. Permissions accumulated by "allow this role from now on" in the approval frame can be removed one row at a time. */}
      {job === null || job.action.kind !== 'prompt' ? null : <RoleGrantsTable jobId={job.id} />}
    </div>
  )
}

// Summary of an existing job (the same information as one row of the list + runs per day, strict mode, and actions)

function JobSummary({
  job,
  now,
  autoRun,
  busy,
  onRunNow,
  onOpenThread,
  onSnooze,
  onCancelSnooze,
  onRemove
}: {
  job: ScheduledJob
  now: number
  autoRun: boolean
  busy: boolean
  onRunNow: () => void
  onOpenThread: (threadId: string) => void
  onSnooze: (minutes: number) => void
  onCancelSnooze: () => void
  onRemove: () => void
}): React.JSX.Element {
  const t = useT()
  const outcome = describeOutcome(t, job, now, (code) => describeReason(t, code))
  const reminder = job.action.kind === 'reminder'
  return (
    <section className="schedule-summary" aria-label={t('schedule.editor.summary')}>
      <div className="schedule-row-meta">
        <span>{describeSpec(t, job.spec)}</span>
        <span>{describeNext(t, job, autoRun, now)}</span>
        <span>{describePerDay(t, runsPerDay(job.spec, now))}</span>
        {job.action.kind === 'prompt' && job.action.approvalStrict ? <span>{t('schedule.strictBadge')}</span> : null}
        {job.action.kind === 'plugin' ? <span className="schedule-plugin-badge">{t('schedule.plugin.badge')}</span> : null}
        {reminder ? <span className="schedule-plugin-badge">{t('schedule.reminder.badge')}</span> : null}
        {job.running ? <span className="schedule-running">{t('schedule.running')}</span> : null}
      </div>
      {job.lastRunAt === null ? null : (
        <div className="schedule-row-last">
          <span title={new Date(job.lastRunAt).toLocaleString()}>
            {t('schedule.last', { when: formatScheduleWhen(t, job.lastRunAt, now) })}
          </span>
          {outcome === null ? null : (
            <span className={job.lastOutcome === 'failed' ? 'denied' : ''}>{outcome}</span>
          )}
          {job.lastThreadId === null ? null : (
            <button type="button" className="link" onClick={() => onOpenThread(job.lastThreadId as string)}>
              {t('schedule.openThread')}
            </button>
          )}
        </div>
      )}
      {reminder ? (
        <SnoozeRow
          snoozedUntil={job.snoozedUntil}
          now={now}
          busy={busy}
          onSnooze={onSnooze}
          onCancelSnooze={onCancelSnooze}
        />
      ) : null}
      <div className="settings-actions">
        {reminder ? (
          // TODO 1265: try the notification now (not counted, a one-time reminder is not used up).
          <button type="button" disabled={busy} onClick={onRunNow}>
            {t('schedule.reminder.test')}
          </button>
        ) : (
          <RunNowButton job={job} busy={busy || job.running} onRunNow={onRunNow} />
        )}
        <button type="button" className="danger" disabled={busy} onClick={onRemove}>
          {t('schedule.remove')}
        </button>
      </div>
    </section>
  )
}

/**
 * TODO 1265: a reminder's snooze - "Remind me again: 5 min / 10 min / 1 hr", and the pending snooze with a cancel link. The same three choices
 * as the notification's buttons; this row is also where the user snoozes when the OS shows the notification without buttons.
 */
function SnoozeRow({
  snoozedUntil,
  now,
  busy,
  onSnooze,
  onCancelSnooze
}: {
  snoozedUntil: number | null
  now: number
  busy: boolean
  onSnooze: (minutes: number) => void
  onCancelSnooze: () => void
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="schedule-snooze" role="group" aria-label={t('schedule.reminder.snoozeTitle')}>
      <span>{t('schedule.reminder.snoozeTitle')}</span>
      {REMINDER_SNOOZE_MINUTES.map((minutes) => (
        <button key={minutes} type="button" disabled={busy} onClick={() => onSnooze(minutes)}>
          {minutes % 60 === 0
            ? t('schedule.reminder.snoozeHours', { hours: minutes / 60 })
            : t('schedule.reminder.snoozeMinutes', { minutes })}
        </button>
      ))}
      {snoozedUntil === null ? (
        <span className="hint">{t('schedule.reminder.snoozeHint')}</span>
      ) : (
        <>
          <span>{t('schedule.reminder.snoozed', { when: formatScheduleWhen(t, snoozedUntil, now) })}</span>
          <button type="button" className="link" disabled={busy} onClick={onCancelSnooze}>
            {t('schedule.reminder.cancelSnooze')}
          </button>
        </>
      )}
    </div>
  )
}

// Form for adding / editing

/**
 * TODO 724: one field = the shape of a Settings `settings-item` (heading + description + control). The heading is `title`, and
 * the input itself is `children` (inside `settings-item-control`). `description` is optional
 * (for a field where the heading is enough, such as "when" or "name").
 */
export function ScheduleField({
  title,
  description,
  children
}: {
  /** If omitted, no heading row is shown (for a field like a checkbox whose control itself carries the text). */
  title?: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-item schedule-field-item">
      {title === undefined ? null : <div className="settings-item-title">{title}</div>}
      {description === undefined ? null : <div className="settings-item-description">{description}</div>}
      <div className="settings-item-control">{children}</div>
    </div>
  )
}

/** TODO 725: the display unit of "fixed interval". The saved value (`spec.minutes`) is always in minutes. */
type IntervalUnit = 'minutes' | 'hours'
const MINUTES_PER_HOUR = 60

/** Converts minutes to the display value for the unit (hours are rounded). */
function intervalDisplayValue(minutes: number, unit: IntervalUnit): number {
  return unit === 'hours' ? Math.round(minutes / MINUTES_PER_HOUR) : minutes
}

/** Converts an input value in the unit to minutes (for saving). */
function intervalMinutesFrom(value: number, unit: IntervalUnit): number {
  return unit === 'hours' ? value * MINUTES_PER_HOUR : value
}

/** The default count for "stop after N runs" (the first value when switching from unlimited). */
const DEFAULT_MAX_RUNS = 1

function JobForm({
  draft,
  isNew,
  promptDefaults,
  options,
  now,
  busy,
  error,
  onChange,
  onSave,
  onCancel
}: {
  draft: ScheduledJobInput
  /** TODO 1265: the kind can be chosen only while adding (main refuses changing the kind of an existing job). */
  isNew: boolean
  promptDefaults: { modelId: ScheduledPromptAction['modelId']; thinking: ScheduledPromptAction['thinking'] }
  options: ThreadCreateOptions | null
  now: number
  busy: boolean
  error: string | null
  onChange: (input: ScheduledJobInput) => void
  onSave: () => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useT()
  const { spec, action } = draft
  const maxRuns = draft.maxRuns ?? null
  // TODO 725: the display unit (minutes / hours). Decided once from the value at mount (not rebuilt on draft updates,
  // so the user can type in the unit they chose). If the existing value is a multiple of 60 (an hour or more), hours is the default.
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(() =>
    spec.kind === 'interval' && spec.minutes >= MINUTES_PER_HOUR && spec.minutes % MINUTES_PER_HOUR === 0
      ? 'hours'
      : 'minutes'
  )
  // TODO 629 (code-review): main also refuses a past "once only" (`schedule-once-past`). Stop it before saving with the same check.
  // TODO 725: the run-count cap check rides on the same gate.
  const problem = useMemo(
    () => checkScheduleSpec(spec, now) ?? checkOnceNotPast(spec, draft.enabled, now) ?? checkMaxRuns(maxRuns),
    [spec, draft.enabled, now, maxRuns]
  )
  const next = problem === null ? nextScheduleTime(spec, now) : null
  const perDay = problem === null ? runsPerDay(spec, now) : 0
  const intervalMax =
    intervalUnit === 'hours' ? Math.floor(MAX_SCHEDULE_INTERVAL_MINUTES / MINUTES_PER_HOUR) : MAX_SCHEDULE_INTERVAL_MINUTES
  const intervalMin = intervalUnit === 'hours' ? 1 : MIN_SCHEDULE_INTERVAL_MINUTES

  return (
    <form
      className="schedule-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSave()
      }}
    >
      {action.kind === 'plugin' ? null : (
        <ScheduleField title={t('schedule.field.jobKind')} description={t('schedule.field.jobKindDescription')}>
          <label className="schedule-field">
            <span className="schedule-kind">
              {action.kind === 'reminder' ? <ReminderIcon size={14} /> : null}
              <select
                aria-label={t('schedule.field.jobKind')}
                value={action.kind}
                disabled={!isNew}
                onChange={(event) =>
                  onChange(switchJobKind(draft, event.target.value === 'reminder' ? 'reminder' : 'prompt', promptDefaults))
                }
              >
                {USER_JOB_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`schedule.jobKind.${kind}`)}
                  </option>
                ))}
              </select>
            </span>
          </label>
        </ScheduleField>
      )}

      <ScheduleField title={action.kind === 'reminder' ? t('schedule.field.title') : t('schedule.field.name')}>
        <label className="schedule-field">
          <input
            type="text"
            value={draft.name}
            placeholder={
              action.kind === 'reminder' ? t('schedule.field.titlePlaceholder') : t('schedule.field.namePlaceholder')
            }
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            // A plugin task's name is the declared one (TODO 372). Main also uses the table's value.
            readOnly={action.kind === 'plugin'}
            spellCheck={false}
          />
        </label>
      </ScheduleField>

      <ScheduleField title={t('schedule.field.when')}>
        <div className="schedule-field">
          <div className="schedule-when">
            <select
              aria-label={t('schedule.field.when')}
              value={spec.kind}
              onChange={(event) => {
                const kind = event.target.value as ScheduleSpecKind
                onChange({
                  ...draft,
                  spec: switchSpecKind(spec, kind),
                  // TODO 725: the run-count cap does not apply to "once only".
                  maxRuns: kind === 'once' ? null : draft.maxRuns
                })
              }}
            >
              {SCHEDULE_SPEC_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`schedule.kind.${kind}`)}
                </option>
              ))}
            </select>
            {spec.kind === 'daily' || spec.kind === 'weekdays' || spec.kind === 'days' ? (
              <input
                type="time"
                aria-label={t('schedule.field.time')}
                value={spec.time.padStart(5, '0')}
                onChange={(event) => onChange({ ...draft, spec: { ...spec, time: event.target.value } })}
              />
            ) : null}
            {spec.kind === 'interval' ? (
              <>
                <input
                  type="number"
                  className="settings-number"
                  aria-label={t('schedule.field.minutes')}
                  min={intervalMin}
                  max={intervalMax}
                  step={intervalUnit === 'hours' ? 1 : 5}
                  value={intervalDisplayValue(spec.minutes, intervalUnit)}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      spec: { kind: 'interval', minutes: intervalMinutesFrom(Number(event.target.value), intervalUnit) }
                    })
                  }
                />
                <select
                  aria-label={t('schedule.field.intervalUnit')}
                  value={intervalUnit}
                  onChange={(event) => {
                    const unit = event.target.value as IntervalUnit
                    // code-review (TODO 725): in the hours unit, minutes were only rounded for display and disagreed with the saved value
                    // (spec.minutes) (90 minutes shown as "2 hours" but saved as 90; 15 minutes as "0 hours"). When the unit is switched,
                    // write the visible value (rounded up, minimum 1) back to spec.minutes, so that the visible value = the saved value.
                    const shown =
                      unit === 'hours' ? Math.max(1, Math.ceil(spec.minutes / MINUTES_PER_HOUR)) : spec.minutes
                    setIntervalUnit(unit)
                    onChange({ ...draft, spec: { kind: 'interval', minutes: intervalMinutesFrom(shown, unit) } })
                  }}
                >
                  <option value="minutes">{t('schedule.unit.minutes')}</option>
                  <option value="hours">{t('schedule.unit.hours')}</option>
                </select>
                <span className="hint">
                  {intervalUnit === 'hours' ? t('schedule.field.hoursUnit') : t('schedule.field.minutesUnit')}
                </span>
                {/* TODO 1220: preset values (5 / 15 / 30 / 60 minutes). Pressing one fills in that number of minutes (free input remains).
  If 60 is pressed while in the hours unit, it is shown as "1 hour"; otherwise the unit goes back to minutes. */}
                <span className="schedule-presets" role="group" aria-label={t('schedule.preset.group')}>
                  {SCHEDULE_INTERVAL_PRESETS.map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      aria-pressed={spec.minutes === minutes}
                      onClick={() => {
                        if (!(intervalUnit === 'hours' && minutes % MINUTES_PER_HOUR === 0)) setIntervalUnit('minutes')
                        onChange({ ...draft, spec: { kind: 'interval', minutes } })
                      }}
                    >
                      {t('schedule.preset.minutes', { n: minutes })}
                    </button>
                  ))}
                </span>
              </>
            ) : null}
            {spec.kind === 'cron' ? (
              <input
                type="text"
                className="schedule-cron"
                aria-label={t('schedule.field.cron')}
                value={spec.expression}
                placeholder="0 8 * * 1-5"
                onChange={(event) => onChange({ ...draft, spec: { kind: 'cron', expression: event.target.value } })}
                spellCheck={false}
              />
            ) : null}
            {spec.kind === 'once' ? (
              <input
                type="datetime-local"
                aria-label={t('schedule.field.at')}
                value={spec.at}
                onChange={(event) => onChange({ ...draft, spec: { kind: 'once', at: event.target.value } })}
              />
            ) : null}
          </div>
          {spec.kind === 'days' ? (
            <div className="schedule-days" role="group" aria-label={t('schedule.field.days')}>
              {WEEK_ORDER.map((day) => (
                <label key={day} className="schedule-day">
                  <input
                    type="checkbox"
                    checked={spec.days.includes(day)}
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        spec: { ...spec, days: toggleWeekday(spec.days, day, event.target.checked) }
                      })
                    }
                  />
                  <span>{t(`schedule.day.${day}`)}</span>
                </label>
              ))}
            </div>
          ) : null}
          {spec.kind === 'cron' ? <span className="hint">{t('schedule.field.cronHint')}</span> : null}
          <span className={problem === null ? 'hint' : 'denied'} aria-live="polite">
            {problem !== null
              ? t(`reason.${problem}`, { minutes: MIN_SCHEDULE_INTERVAL_MINUTES })
              : next === null
                ? t('schedule.nextNone')
                : `${t('schedule.next', { when: formatScheduleWhen(t, next, now) })} · ${describePerDay(t, perDay)}`}
          </span>
        </div>
      </ScheduleField>

      {/* TODO 725 / 827: the run-count cap (for all of daily / weekdays / fixed interval / cron; not shown for "once only", since
  the mechanism of 629 already handles once-only). Placed right under the repeat-kind field so it is easy to find.
  For a plugin's task, only the time and enabled state are user-editable (TODO 372), so even if it is changed here, main
  keeps the current value on save. */}
      {spec.kind === 'once' ? null : (
        <ScheduleField title={t('schedule.field.maxRuns')}>
          <div className="schedule-max-runs">
            <select
              aria-label={t('schedule.field.maxRuns')}
              value={maxRuns === null ? 'unlimited' : 'limited'}
              onChange={(event) =>
                onChange({ ...draft, maxRuns: event.target.value === 'unlimited' ? null : DEFAULT_MAX_RUNS })
              }
            >
              <option value="unlimited">{t('schedule.field.maxRunsUnlimited')}</option>
              <option value="limited">{t('schedule.field.maxRunsLimited')}</option>
            </select>
            {maxRuns === null ? null : (
              <input
                type="number"
                className="settings-number"
                aria-label={t('schedule.field.maxRunsCount')}
                min={1}
                max={MAX_SCHEDULE_MAX_RUNS}
                value={maxRuns}
                onChange={(event) => onChange({ ...draft, maxRuns: Number(event.target.value) })}
              />
            )}
          </div>
        </ScheduleField>
      )}

      {action.kind === 'prompt' ? (
        <PromptFields
          action={action}
          options={options}
          onChange={(nextAction) => onChange({ ...draft, action: nextAction })}
        />
      ) : action.kind === 'reminder' ? (
        <ReminderFields action={action} onChange={(nextAction) => onChange({ ...draft, action: nextAction })} />
      ) : (
        <PluginTaskInfo pluginId={action.pluginId} taskId={action.taskId} />
      )}

      <ScheduleField>
        <label className="schedule-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          />
          <span>{t('schedule.field.enabled')}</span>
        </label>
      </ScheduleField>

      {error === null ? null : <p className="denied">{describeReason(t, error)}</p>}
      <div className="settings-actions">
        <button type="submit" disabled={busy || problem !== null}>
          {t('schedule.save')}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  )
}

// Fields for a scheduled prompt (working folder, Model, Thinking, prompt, strict mode)

function PromptFields({
  action,
  options,
  onChange
}: {
  action: ScheduledPromptAction
  options: ThreadCreateOptions | null
  onChange: (action: ScheduledPromptAction) => void
}): React.JSX.Element {
  const t = useT()
  const [pickError, setPickError] = useState<string | null>(null)
  const primary = options?.backends.find((b) => b.id === options.defaultBackend) ?? null
  const setAction = (patch: Partial<ScheduledPromptAction>): void => onChange({ ...action, ...patch })

  // Choices for the working folder: no affiliation + history + the current value (if it is not in the history).
  const history = options?.cwdHistory.filter((entry) => entry.usable) ?? []
  const folderKnown = action.cwdUri === null || history.some((entry) => entry.uri === action.cwdUri)

  const pickFolder = async (): Promise<void> => {
    setPickError(null)
    const result = await window.aios.fs.pickDirectory()
    if (result.uri !== null) setAction({ cwdUri: result.uri })
    else if (result.reason !== null) setPickError(result.reason)
  }

  return (
    <>
      <ScheduleField title={t('schedule.field.folder')}>
        <label className="schedule-field">
          <span className="schedule-folder">
            <select
              value={action.cwdUri ?? ''}
              onChange={(event) => setAction({ cwdUri: event.target.value === '' ? null : event.target.value })}
            >
              <option value="">{t('schedule.field.folderNone')}</option>
              {history.map((entry) => (
                <option key={entry.uri} value={entry.uri}>
                  {entry.parentName === '' ? entry.name : `${entry.name} — ${entry.parentName}`}
                </option>
              ))}
              {folderKnown || action.cwdUri === null ? null : (
                <option value={action.cwdUri}>{decodeURIComponent(action.cwdUri.replace(/^file:\/\//, ''))}</option>
              )}
            </select>
            <button type="button" onClick={() => void pickFolder()}>
              {t('schedule.field.folderPick')}
            </button>
          </span>
          {pickError === null ? null : <span className="denied">{describeReason(t, pickError)}</span>}
        </label>
      </ScheduleField>

      {primary !== null && primary.modelSelect ? (
        <ScheduleField title={t('common.model')}>
          <label className="schedule-field">
            <select value={action.modelId ?? ''} onChange={(event) => setAction({ modelId: event.target.value })}>
              {/* TODO 1204: a version-pinned choice (sameAs) that points to the same model as the one above is shown with a "pinned" mark only when it is selected. */}
              {listedModelChoices(primary.models, action.modelId).map((model) => (
                <option key={model.id} value={model.id}>
                  {modelChoiceLabel(model, t)}
                </option>
              ))}
              {action.modelId !== null && !primary.models.some((m) => m.id === action.modelId) ? (
                <option value={action.modelId}>{t('common.modelNotListed', { id: action.modelId })}</option>
              ) : null}
            </select>
          </label>
        </ScheduleField>
      ) : null}

      {primary !== null && primary.thinkingLevel ? (
        <ScheduleField title={t('schedule.field.thinking')}>
          <label className="schedule-field">
            <select
              value={action.thinking ?? ''}
              onChange={(event) => {
                const value = event.target.value
                setAction({ thinking: isThinkingLevel(value) ? value : null })
              }}
            >
              {action.thinking === null ? <option value="">{t('schedule.field.thinkingDefault')}</option> : null}
              {thinkingSelectLevels(action.thinking).map((level) => (
                <option key={level} value={level}>
                  {thinkingLabel(level, false, t)}
                </option>
              ))}
            </select>
          </label>
        </ScheduleField>
      ) : null}

      <ScheduleField title={t('schedule.field.prompt')}>
        <label className="schedule-field">
          <textarea
            className="settings-textarea schedule-prompt"
            rows={12}
            value={action.prompt}
            placeholder={t('schedule.field.promptPlaceholder')}
            onChange={(event) => setAction({ prompt: event.target.value })}
          />
        </label>
      </ScheduleField>

      <ScheduleField description={t('schedule.field.strictDescription')}>
        <label className="schedule-check">
          <input
            type="checkbox"
            checked={action.approvalStrict}
            onChange={(event) => setAction({ approvalStrict: event.target.checked })}
          />
          <span>{t('schedule.field.strict')}</span>
        </label>
        {/* TODO 994: say in advance, under the checkbox, that in the first unattended turn all Bash / writes are stopped. */}
        <span className="hint schedule-strict-note">{t('schedule.field.strictUnattended')}</span>
      </ScheduleField>
    </>
  )
}

// A reminder's message (TODO 1265). The title is the name field above.

function ReminderFields({
  action,
  onChange
}: {
  action: ScheduledReminderAction
  onChange: (action: ScheduledReminderAction) => void
}): React.JSX.Element {
  const t = useT()
  return (
    <ScheduleField title={t('schedule.field.reminderBody')}>
      <label className="schedule-field">
        <textarea
          className="settings-textarea schedule-reminder-body"
          rows={3}
          maxLength={MAX_REMINDER_BODY}
          value={action.body}
          placeholder={t('schedule.field.reminderBodyPlaceholder')}
          onChange={(event) => onChange({ ...action, body: event.target.value })}
        />
      </label>
    </ScheduleField>
  )
}

// A plugin's recurring task (TODO 372, shape only; running it is Phase 5)

function PluginTaskInfo({ pluginId, taskId }: { pluginId: string; taskId: string }): React.JSX.Element {
  const t = useT()
  return (
    <ScheduleField title={t('schedule.plugin.title')}>
      <div className="schedule-field schedule-plugin-info">
        <span className="schedule-plugin-id">
          {pluginId} / {taskId}
        </span>
        <span className="hint">{t('schedule.plugin.note')}</span>
      </div>
    </ScheduleField>
  )
}
