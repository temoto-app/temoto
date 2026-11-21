/**
 * The recurring-run list (sidebar, TODO 372 / wave 20 bundle B. ARCHITECTURE.md 6.2.4 / 5.3).
 *
 * The list that used to be in the settings category "Scheduled runs" (`ScheduleSettings.tsx`) was moved into an activity bar
 * mode. **It follows the shape of VS Code's Extensions view**: the list is in the sidebar, and pressing a row opens the editor on the main side
 * (`ScheduleEditor.tsx`, the same place as the settings editor).
 *
 * One row = enable toggle, name, next run, last result (+ running), run now. **Cost is not shown**
 * (constraint 4 / item 165). The list is redrawn from main's push (`schedule.onChanged`); it also receives the release of "running" when a turn ends or
 * the process dies (reusing the fix of TODO 351-2 as is).
 */
import { useCallback, useEffect, useState } from 'react'
import type { ScheduleOverview, ScheduledJob } from '@shared/schedule.js'
import { useSchedule } from '../scheduleStore.js'
import { describeReason, useT } from '../i18n/index.js'
import {
  describeNext,
  describeOutcome,
  describeSpec,
  formatScheduleWhen,
  jobLabel,
  scheduleRunNowBlocked
} from '../schedule-format.js'
import { Tooltip } from './Tooltip.js'
import { ScheduleAddIcon } from '../icons/ScheduleAddIcon.js'
import { TriggerIcon } from '../icons/TriggerIcon.js'
import { ReminderIcon } from '../icons/ReminderIcon.js'
import type { TriggerRow } from '@shared/trigger.js'
import { useTriggers } from '../triggerStore.js'
import { TeammateSection } from './TeammateSection.js'

/** Interval for redrawing the next-run display. */
export const SCHEDULE_NOW_TICK_MS = 30_000

/** Advances "now" every 30 seconds (for the switch of the next run between "today / tomorrow" and "soon"). */
export function useScheduleNow(): number {
  const [now, setNow] = useState(() => Date.now())
  const overview = useSchedule((state) => state.overview)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), SCHEDULE_NOW_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])
  // When a push arrives, re-take now as well (so the "next run" right after a run is not off).
  useEffect(() => setNow(Date.now()), [overview])
  return now
}

export function ScheduleList(): React.JSX.Element {
  const t = useT()
  const overview = useSchedule((state) => state.overview)
  const editing = useSchedule((state) => state.editing)
  const openEditor = useSchedule((state) => state.openEditor)
  const setOverview = useSchedule((state) => state.setOverview)
  const markSeen = useSchedule((state) => state.markSeen)
  const now = useScheduleNow()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // A result that arrives while the list is visible counts as seen (clears the dot on the activity bar).
  useEffect(() => {
    if (overview !== undefined) markSeen()
  }, [overview, markSeen])

  /** Calls main and replaces the list. On failure it shows the reason above the list. */
  const act = useCallback(
    async (key: string, call: () => Promise<ScheduleOverview>): Promise<void> => {
      setBusy(key)
      setError(null)
      try {
        setOverview(await call())
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(null)
      }
    },
    [setOverview]
  )

  return (
    <div className="schedule-panel">
      <div className="schedule-panel-header">
        <span className="schedule-panel-title">{t('sidebar.mode.schedule')}</span>
        <Tooltip content={t('schedule.add')}>
          <button
            type="button"
            className="icon-button schedule-add"
            aria-label={t('schedule.add')}
            aria-pressed={
              editing !== null && editing.id === null && editing.trigger === undefined && editing.role === undefined
            }
            onClick={() => openEditor(null)}
          >
            <ScheduleAddIcon />
          </button>
        </Tooltip>
      </div>
      {overview === undefined ? (
        <p className="schedule-panel-hint">{t('common.loading')}</p>
      ) : (
        <>
          {overview.autoRun ? null : <p className="schedule-banner">{t('schedule.autoRunOff')}</p>}
          {error === null ? null : <p className="schedule-panel-error">{describeReason(t, error)}</p>}
          {overview.jobs.length === 0 ? (
            <div className="schedule-panel-hint">
              <p>{t('schedule.empty')}</p>
              <p>{t('schedule.description')}</p>
            </div>
          ) : (
            <ul className="schedule-items" aria-label={t('sidebar.mode.schedule')}>
              {overview.jobs.map((job) => (
                <ScheduleItem
                  key={job.id}
                  job={job}
                  now={now}
                  autoRun={overview.autoRun}
                  selected={editing?.id === job.id}
                  busy={busy === job.id}
                  onOpen={() => openEditor(job.id)}
                  onToggle={(enabled) =>
                    void act(job.id, () =>
                      window.aios.schedule.update(job.id, {
                        name: job.name,
                        enabled,
                        spec: job.spec,
                        action: job.action,
                        // TODO 725: the run-count cap is sent as it is (when re-enabled, main recounts run_count).
                        maxRuns: job.maxRuns
                      })
                    )
                  }
                  onRunNow={() => void act(job.id, () => window.aios.schedule.runNow(job.id))}
                />
              ))}
            </ul>
          )}
        </>
      )}
      <TriggerSection />
      <TeammateSection />
    </div>
  )
}

/**
 * TODO 1216 (6.2.6): the "Triggers" section. Rows of triggers that extensions declared (enabled, name, extension, today's count, last run).
 * Pressing a row opens the rule editor (`TriggerEditor`) on the main side. If there is no declaration, the whole section is hidden. **Cost is not shown** (constraint 4).
 */
function TriggerSection(): React.JSX.Element | null {
  const t = useT()
  const overview = useTriggers((state) => state.overview)
  const setOverview = useTriggers((state) => state.setOverview)
  const editing = useSchedule((state) => state.editing)
  const openTrigger = useSchedule((state) => state.openTrigger)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (overview === undefined || overview.triggers.length === 0) return null
  const toggle = async (row: TriggerRow, enabled: boolean): Promise<void> => {
    const key = `${row.pluginId}/${row.triggerId}`
    setBusy(key)
    setError(null)
    try {
      // Fix X: toggling in the list does not count as having seen the "reason aios disabled it" (the reason and the action to re-enable are on the editor screen).
      setOverview(await window.aios.trigger.update(row.pluginId, row.triggerId, { ...row.rule, enabled }, null))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  return (
    <section className="trigger-section" aria-label={t('trigger.section')}>
      <div className="schedule-panel-header trigger-section-header">
        <span className="schedule-panel-title trigger-section-title">
          <TriggerIcon size={12} />
          {t('trigger.section')}
        </span>
        {overview.queued > 0 ? <span className="trigger-queued">{t('trigger.queued', { count: overview.queued })}</span> : null}
      </div>
      {error === null ? null : <p className="schedule-panel-error">{describeReason(t, error)}</p>}
      <ul className="schedule-items trigger-items" aria-label={t('trigger.section')}>
        {overview.triggers.map((row) => {
          const key = `${row.pluginId}/${row.triggerId}`
          const selected = editing?.trigger?.pluginId === row.pluginId && editing.trigger.triggerId === row.triggerId
          return (
            <li
              key={key}
              className={`schedule-item${selected ? ' selected' : ''}${row.rule.enabled && row.pluginEnabled ? '' : ' disabled'}`}
              data-trigger={key}
            >
              <input
                type="checkbox"
                className="schedule-item-enabled"
                checked={row.rule.enabled}
                disabled={busy === key}
                aria-label={t('trigger.enabledFor', { name: row.name })}
                onChange={(event) => {
                  // Fix X: a rule disabled because the extension changed or was not found is re-enabled on the editor screen, which shows the reason.
                  if (event.target.checked && row.autoDisabled !== null) openTrigger(row.pluginId, row.triggerId)
                  else void toggle(row, event.target.checked)
                }}
              />
              <button
                type="button"
                className="schedule-item-main"
                aria-current={selected ? 'true' : undefined}
                onClick={() => openTrigger(row.pluginId, row.triggerId)}
              >
                <span className="schedule-item-name">{row.name}</span>
                <span className="schedule-item-meta">{row.pluginName}</span>
                <span className="schedule-item-meta">{describeTriggerToday(t, row)}</span>
                {row.pluginEnabled ? null : <span className="schedule-item-meta">{t('trigger.pluginDisabled')}</span>}
                {row.autoDisabled === null ? null : <span className="schedule-item-meta">{t('trigger.autoDisabled.short')}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** "3 / 20 today" (+ n skipped because of the limit). */
export function describeTriggerToday(t: ReturnType<typeof useT>, row: TriggerRow): string {
  const base = t('trigger.today', { count: row.today.accepted, cap: row.rule.dailyCap })
  return row.today.capped > 0 ? `${base} · ${t('trigger.capped', { count: row.today.capped })}` : base
}

function ScheduleItem({
  job,
  now,
  autoRun,
  selected,
  busy,
  onOpen,
  onToggle,
  onRunNow
}: {
  job: ScheduledJob
  now: number
  autoRun: boolean
  selected: boolean
  busy: boolean
  onOpen: () => void
  onToggle: (enabled: boolean) => void
  onRunNow: () => void
}): React.JSX.Element {
  const t = useT()
  const outcome = describeOutcome(t, job, now, (code) => describeReason(t, code))
  const reminder = job.action.kind === 'reminder'
  return (
    <li
      className={`schedule-item${selected ? ' selected' : ''}${job.enabled ? '' : ' disabled'}`}
      data-job={job.id}
    >
      <input
        type="checkbox"
        className="schedule-item-enabled"
        checked={job.enabled}
        disabled={busy}
        aria-label={t('schedule.enabledFor', { name: job.name })}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <button
        type="button"
        className="schedule-item-main"
        aria-current={selected ? 'true' : undefined}
        onClick={onOpen}
      >
        <span className="schedule-item-name">
          {/* TODO 1265: a reminder (notification only) is marked with a bell. */}
          {reminder ? (
            <span className="schedule-reminder-mark" role="img" aria-label={t('schedule.reminder.badge')}>
              <ReminderIcon size={12} />
            </span>
          ) : null}
          {jobLabel(job)}
          {/* TODO 372: a task declared by a plugin (disabled at install, not run in this version). */}
          {job.action.kind === 'plugin' ? (
            <span className="schedule-plugin-badge">{t('schedule.plugin.badge')}</span>
          ) : null}
          {/* TODO 1265: a reminder the AI registered through the gateway. */}
          {job.byAi === true ? <span className="schedule-plugin-badge">{t('schedule.reminder.byAi')}</span> : null}
        </span>
        {/* TODO 527: a summary of how the time is written ("Mon, Wed, Fri 09:00", "weekdays 08:00"). */}
        <span className="schedule-item-meta schedule-item-spec">{describeSpec(t, job.spec)}</span>
        <span className="schedule-item-meta">{describeNext(t, job, autoRun, now)}</span>
        {outcome === null ? null : (
          <span className={`schedule-item-meta${job.lastOutcome === 'failed' ? ' denied' : ''}`}>{outcome}</span>
        )}
        {job.snoozedUntil === null ? null : (
          <span className="schedule-item-meta">
            {t('schedule.reminder.snoozed', { when: formatScheduleWhen(t, job.snoozedUntil, now) })}
          </span>
        )}
      </button>
      {reminder ? (
        // TODO 1265: a reminder's "Run now" is a test of the notification (never blocked, not counted).
        <button type="button" className="schedule-item-run" disabled={busy} onClick={onRunNow}>
          {t('schedule.reminder.test')}
        </button>
      ) : job.running ? (
        <span className="schedule-running">{t('schedule.running')}</span>
      ) : (
        <RunNowButton job={job} busy={busy} onRunNow={onRunNow} className="schedule-item-run" />
      )}
    </li>
  )
}

/**
 * The "Run now" button (TODO 739). Used by both the list row and the editor (`JobSummary`). A used-up job
 * (a "once only" already used, 629; a run-count cap already used, 725) is shown disabled with a tooltip giving the reason.
 * Before, the user only learned of it from the strip text after main refused (`scheduleRunNowBlocked` checks the same
 * two conditions as main's `runNow`). Chromium sometimes does not deliver mouseenter / focus to a disabled button, so
 * the tooltip's receiver is a span wrapping the button (the same approach as `composer-icon-tip` in `Composer.tsx`).
 */
export function RunNowButton({
  job,
  busy,
  onRunNow,
  className = ''
}: {
  job: Pick<ScheduledJob, 'spec' | 'enabled' | 'maxRuns' | 'runCount'>
  busy: boolean
  onRunNow: () => void
  className?: string
}): React.JSX.Element {
  const t = useT()
  const blocked = scheduleRunNowBlocked(job)
  const button = (
    <button type="button" className={className} disabled={busy || blocked !== null} onClick={onRunNow}>
      {t('schedule.runNow')}
    </button>
  )
  if (blocked === null) return button
  return (
    <Tooltip content={describeReason(t, blocked)}>
      <span className="composer-icon-tip" aria-disabled>
        {button}
      </span>
    </Tooltip>
  )
}
