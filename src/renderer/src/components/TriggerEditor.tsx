/**
 * Editing a trigger rule (main side, TODO 1216, ARCHITECTURE 6.2.6). Same place and look as the scheduled-run editor
 * (`ScheduleEditor.tsx`) (`ScheduleField` = the shape of one Settings item). Opens when a row in the sidebar's "Triggers" section is pressed.
 *
 * Fields: enabled (default disabled), working folder, Model, Thinking, instruction (if empty, the extension's default -> aios's generic one), daily limit,
 * and the tools usable in an unattended turn (TODO 1227: only tools without `sideEffect` from non-bundled extensions are offered as candidates; the user chooses, and main re-checks against the declaration).
 * The frame for "text from outside" and the unattended promises (read only, no sending, no asking) are always attached by aios, so they are not
 * written here (only explained). Saving is re-validated by main (shape, limit, working folder). **No cost is shown** (constraint 4) - only counts.
 */
import { useEffect, useState } from 'react'
import { isThinkingLevel } from '@shared/agent.js'
import type { ThreadCreateOptions } from '@shared/thread.js'
import { DEFAULT_TRIGGER_INSTRUCTIONS, MAX_TRIGGER_DAILY_CAP, type TriggerRow, type TriggerRule } from '@shared/trigger.js'
import { useThreads } from '../threadStore.js'
import { useSchedule } from '../scheduleStore.js'
import { findTrigger, useTriggers } from '../triggerStore.js'
import { listedModelChoices, modelChoiceLabel, thinkingLabel, thinkingSelectLevels } from '../composer-choice.js'
import { describeReason, useT } from '../i18n/index.js'
import { formatScheduleWhen } from '../schedule-format.js'
import { ScheduleField } from './ScheduleEditor.js'
import { describeTriggerToday, useScheduleNow } from './ScheduleList.js'
import { Tooltip } from './Tooltip.js'
import { CloseIcon } from '../icons/CloseIcon.js'

export function TriggerEditor({
  target
}: {
  target: { readonly pluginId: string; readonly triggerId: string }
}): React.JSX.Element | null {
  const t = useT()
  const overview = useTriggers((state) => state.overview)
  const closeEditor = useSchedule((state) => state.closeEditor)
  const row = findTrigger(overview, target.pluginId, target.triggerId)
  // If the extension was removed or dropped from the declaration (the list arrived but it is not found), close.
  const gone = overview !== undefined && row === null
  useEffect(() => {
    if (gone) closeEditor()
  }, [gone, closeEditor])
  if (gone) return null
  const title = row?.name ?? t('trigger.section')
  return (
    <div className="thread-pane settings-editor schedule-editor trigger-editor" role="region" aria-label={title}>
      <div className="settings-editor-header schedule-editor-header">
        <h1 className="schedule-editor-title">{title}</h1>
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
      {row === null ? (
        <p className="schedule-editor-body hint">{t('common.loading')}</p>
      ) : (
        <TriggerBody row={row} autoRun={overview?.autoRun ?? true} />
      )}
    </div>
  )
}

function TriggerBody({ row, autoRun }: { row: TriggerRow; autoRun: boolean }): React.JSX.Element {
  const t = useT()
  const now = useScheduleNow()
  const settings = useThreads((state) => state.settings)
  const selectThread = useThreads((state) => state.selectThread)
  const setOverview = useTriggers((state) => state.setOverview)
  const closeEditor = useSchedule((state) => state.closeEditor)
  const [options, setOptions] = useState<ThreadCreateOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The draft starts from the values at the time of opening (not rebuilt on main's push). If Model is undecided, start with the default model.
  const [draft, setDraft] = useState<TriggerRule>(() => ({
    ...row.rule,
    modelId: row.rule.modelId ?? settings?.defaultModelId ?? null,
    thinking: row.rule.thinking ?? settings?.defaultThinking ?? null,
    // Drop names not in the current candidates (tools dropped from the declaration) before starting (main refuses anything outside the candidates).
    allowedTools: row.rule.allowedTools.filter((name) => row.toolChoices.some((tool) => tool.name === name))
  }))

  useEffect(() => {
    let alive = true
    void window.aios.threads.createOptions().then((next) => {
      if (alive) setOptions(next)
    })
    return () => {
      alive = false
    }
  }, [])

  const primary = options?.backends.find((b) => b.id === options.defaultBackend) ?? null
  const history = options?.cwdHistory.filter((entry) => entry.usable) ?? []
  const folderKnown = draft.cwdUri === null || history.some((entry) => entry.uri === draft.cwdUri)
  const capValid = Number.isInteger(draft.dailyCap) && draft.dailyCap >= 1 && draft.dailyCap <= MAX_TRIGGER_DAILY_CAP

  const pickFolder = async (): Promise<void> => {
    setPickError(null)
    const result = await window.aios.fs.pickDirectory()
    if (result.uri !== null) setDraft({ ...draft, cwdUri: result.uri })
    else if (result.reason !== null) setPickError(result.reason)
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setOverview(await window.aios.trigger.update(row.pluginId, row.triggerId, draft, row.autoDisabled))
      closeEditor()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="schedule-editor-body">
      <p className="schedule-editor-description">{t('trigger.description')}</p>
      {autoRun ? null : <p className="schedule-banner">{t('trigger.autoRunOff')}</p>}
      {row.autoDisabled === null ? null : (
        <p className="schedule-banner" data-auto-disabled={row.autoDisabled}>
          {t(row.autoDisabled === 'plugin-missing' ? 'trigger.autoDisabled.missing' : 'trigger.autoDisabled.changed')}
        </p>
      )}
      <section className="schedule-summary" aria-label={t('schedule.editor.summary')}>
        <div className="schedule-row-meta">
          <span>{row.pluginName}</span>
          <span>{describeTriggerToday(t, row)}</span>
          {row.pluginEnabled ? null : <span>{t('trigger.pluginDisabled')}</span>}
          {row.failedRecent > 0 ? <span className="denied">{t('trigger.failedRecent', { count: row.failedRecent })}</span> : null}
        </div>
        {row.description === null ? null : <p className="hint">{row.description}</p>}
        {row.lastAcceptedAt === null ? null : (
          <div className="schedule-row-last">
            <span title={new Date(row.lastAcceptedAt).toLocaleString()}>
              {t('trigger.last', { when: formatScheduleWhen(t, row.lastAcceptedAt, now) })}
            </span>
            {row.lastThreadId === null ? null : (
              <button type="button" className="link" onClick={() => void selectThread(row.lastThreadId as string)}>
                {t('schedule.openThread')}
              </button>
            )}
          </div>
        )}
      </section>
      <form
        className="schedule-form"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <ScheduleField description={t('trigger.field.enabledDescription')}>
          <label className="schedule-check">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            <span>{t('trigger.field.enabled')}</span>
          </label>
        </ScheduleField>

        <ScheduleField title={t('schedule.field.folder')} description={t('trigger.field.folderDescription')}>
          <label className="schedule-field">
            <span className="schedule-folder">
              <select
                value={draft.cwdUri ?? ''}
                onChange={(event) => setDraft({ ...draft, cwdUri: event.target.value === '' ? null : event.target.value })}
              >
                <option value="">{t('schedule.field.folderNone')}</option>
                {history.map((entry) => (
                  <option key={entry.uri} value={entry.uri}>
                    {entry.parentName === '' ? entry.name : `${entry.name} — ${entry.parentName}`}
                  </option>
                ))}
                {folderKnown || draft.cwdUri === null ? null : (
                  <option value={draft.cwdUri}>{decodeURIComponent(draft.cwdUri.replace(/^file:\/\//, ''))}</option>
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
              <select value={draft.modelId ?? ''} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}>
                {listedModelChoices(primary.models, draft.modelId).map((model) => (
                  <option key={model.id} value={model.id}>
                    {modelChoiceLabel(model, t)}
                  </option>
                ))}
                {draft.modelId !== null && !primary.models.some((m) => m.id === draft.modelId) ? (
                  <option value={draft.modelId}>{t('common.modelNotListed', { id: draft.modelId })}</option>
                ) : null}
              </select>
            </label>
          </ScheduleField>
        ) : null}

        {primary !== null && primary.thinkingLevel ? (
          <ScheduleField title={t('schedule.field.thinking')}>
            <label className="schedule-field">
              <select
                value={draft.thinking ?? ''}
                onChange={(event) => {
                  const value = event.target.value
                  setDraft({ ...draft, thinking: isThinkingLevel(value) ? value : null })
                }}
              >
                {draft.thinking === null ? <option value="">{t('schedule.field.thinkingDefault')}</option> : null}
                {thinkingSelectLevels(draft.thinking).map((level) => (
                  <option key={level} value={level}>
                    {thinkingLabel(level, false, t)}
                  </option>
                ))}
              </select>
            </label>
          </ScheduleField>
        ) : null}

        <ScheduleField title={t('trigger.field.instructions')} description={t('trigger.field.instructionsDescription')}>
          <label className="schedule-field">
            <textarea
              className="settings-textarea schedule-prompt"
              rows={10}
              value={draft.instructions ?? ''}
              placeholder={row.defaultPrompt ?? DEFAULT_TRIGGER_INSTRUCTIONS}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value === '' ? null : event.target.value })}
            />
          </label>
        </ScheduleField>

        <ScheduleField title={t('trigger.field.dailyCap')} description={t('trigger.field.dailyCapDescription')}>
          <label className="schedule-field">
            <input
              type="number"
              className="settings-number"
              min={1}
              max={MAX_TRIGGER_DAILY_CAP}
              value={draft.dailyCap}
              onChange={(event) => setDraft({ ...draft, dailyCap: Number(event.target.value) })}
            />
          </label>
        </ScheduleField>

        {row.bundled ? null : row.toolChoices.length === 0 ? null : (
          <ScheduleField title={t('trigger.field.tools')} description={t('trigger.field.toolsDescription')}>
            <div className="schedule-field">
              {row.toolChoices.map((tool) => (
                <label key={tool.name} className="schedule-check" title={tool.description}>
                  <input
                    type="checkbox"
                    checked={draft.allowedTools.includes(tool.name)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        allowedTools: event.target.checked
                          ? [...draft.allowedTools.filter((name) => name !== tool.name), tool.name]
                          : draft.allowedTools.filter((name) => name !== tool.name)
                      })
                    }
                  />
                  <span>{tool.title}</span>
                </label>
              ))}
            </div>
          </ScheduleField>
        )}

        <p className="hint">{t('trigger.readOnlyNote')}</p>
        {row.bundled ? <p className="hint">{t('trigger.field.toolsBundled')}</p> : null}
        {error === null ? null : <p className="denied">{describeReason(t, error)}</p>}
        <div className="settings-actions">
          <button type="submit" disabled={busy || !capValid}>
            {t('schedule.save')}
          </button>
          <button type="button" disabled={busy} onClick={closeEditor}>
            {t('common.cancel')}
          </button>
        </div>
      </form>
    </div>
  )
}
