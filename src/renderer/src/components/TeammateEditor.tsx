/**
 * Editing a role, shown as a "Teammate" (main side, TODO 972, ARCHITECTURE 4.3.4). Same place and look as the scheduled-run editor
 * (`ScheduleEditor.tsx`, `ScheduleField` = the shape of one Settings item). Opens from a row of the "Teammates" section of the
 * scheduled-run view, from + there, and from "Edit Teammate" on a role heading of the thread list.
 *
 * Fields: name, working folder, Model, Thinking, standing instructions. An existing Teammate also shows how many conversations and
 * scheduled runs it has, "New conversation" (no dialog: main takes the folder and Model / Thinking from the role) and "Delete" (no
 * confirmation - nothing is lost; its conversations stay without a Teammate). Saving is re-validated by main (shape, working folder).
 * TODO 983 stage 4: the strict-mode toggle (default OFF; ON starts every conversation of the Teammate strict) and, for an existing
 * Teammate, "what this Teammate is allowed" (`RoleGrantsTable` with `role:<id>`; the job editor keeps the job's own rows).
 */
import { useEffect, useState } from 'react'
import { isThinkingLevel } from '@shared/agent.js'
import type { ThreadCreateOptions } from '@shared/thread.js'
import { MAX_ROLE_INSTRUCTIONS, emptyRoleInput, roleInputOf, type Role, type RoleInput } from '@shared/role.js'
import { useThreads } from '../threadStore.js'
import { useSchedule } from '../scheduleStore.js'
import { findRole, useRoles } from '../roleStore.js'
import { listedModelChoices, modelChoiceLabel, thinkingLabel, thinkingSelectLevels } from '../composer-choice.js'
import { describeReason, useT } from '../i18n/index.js'
import { ScheduleField } from './ScheduleEditor.js'
import { RoleGrantsTable } from './RoleGrantsTable.js'
import { DrillButton } from './DrillPanel.js'
import { Tooltip } from './Tooltip.js'
import { CloseIcon } from '../icons/CloseIcon.js'

export function TeammateEditor({ roleId }: { roleId: string | null }): React.JSX.Element | null {
  const t = useT()
  const roles = useRoles((state) => state.roles)
  const closeEditor = useSchedule((state) => state.closeEditor)
  const role = roleId === null ? null : findRole(roles, roleId)
  // Deleted from another window (the list arrived but it is not found): close.
  const gone = roleId !== null && roles !== undefined && role === null
  useEffect(() => {
    if (gone) closeEditor()
  }, [gone, closeEditor])
  if (gone) return null
  const title = role?.name ?? t('roles.editor.newTitle')
  return (
    <div className="thread-pane settings-editor schedule-editor teammate-editor" role="region" aria-label={title}>
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
      {roleId !== null && role === null ? (
        <p className="schedule-editor-body hint">{t('common.loading')}</p>
      ) : (
        <TeammateBody key={roleId ?? '(new)'} role={role} />
      )}
    </div>
  )
}

function TeammateBody({ role }: { role: Role | null }): React.JSX.Element {
  const t = useT()
  const setRoles = useRoles((state) => state.setRoles)
  const closeEditor = useSchedule((state) => state.closeEditor)
  const overview = useSchedule((state) => state.overview)
  const createThreadInRole = useThreads((state) => state.createThreadInRole)
  const conversations = useThreads((state) =>
    role === null ? 0 : state.threadOrder.filter((id) => state.threadsById[id]?.thread.roleId === role.id).length
  )
  const jobs = role === null ? 0 : (overview?.jobs.filter((job) => job.action.kind === 'prompt' && job.action.roleId === role.id).length ?? 0)
  const [options, setOptions] = useState<ThreadCreateOptions | null>(null)
  const [draft, setDraft] = useState<RoleInput>(() => (role === null ? emptyRoleInput() : roleInputOf(role)))
  const [error, setError] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Set while "New conversation" is in flight so that a double click does not create two conversations.
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let alive = true
    void window.aios.threads.createOptions().then((next) => {
      if (alive) setOptions(next)
    })
    return () => {
      alive = false
    }
  }, [])

  const run = async (call: () => Promise<readonly Role[]>, close: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setRoles(await call())
      if (close) closeEditor()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const primary = options?.backends.find((b) => b.id === options.defaultBackend) ?? null
  const history = options?.cwdHistory.filter((entry) => entry.usable) ?? []
  const folderKnown = draft.cwdUri === null || history.some((entry) => entry.uri === draft.cwdUri)
  const set = (patch: Partial<RoleInput>): void => setDraft({ ...draft, ...patch })

  const pickFolder = async (): Promise<void> => {
    setPickError(null)
    const result = await window.aios.fs.pickDirectory()
    if (result.uri !== null) set({ cwdUri: result.uri })
    else if (result.reason !== null) setPickError(result.reason)
  }

  return (
    <div className="schedule-editor-body">
      {role === null ? <p className="schedule-editor-description">{t('roles.editor.description')}</p> : null}
      {role === null ? null : (
        <section className="schedule-summary" aria-label={t('schedule.editor.summary')}>
          <div className="schedule-row-meta">
            <span>{t(conversations === 1 ? 'roles.conversations.one' : 'roles.conversations.other', { count: conversations })}</span>
            {jobs === 0 ? null : <span>{t(jobs === 1 ? 'roles.jobs.one' : 'roles.jobs.other', { count: jobs })}</span>}
          </div>
          <div className="settings-actions">
            <button
              type="button"
              disabled={busy || creating}
              onClick={() => {
                if (creating) return
                setCreating(true)
                void createThreadInRole(role.id).finally(() => setCreating(false))
              }}
            >
              {t('roles.newThread')}
            </button>
            {/* TODO 982: a drill conversation under this Teammate (the person types the one message). */}
            <DrillButton roleId={role.id} jobId={null} disabled={busy || creating} />
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void run(() => window.aios.roles.remove(role.id), true)}
            >
              {t('roles.remove')}
            </button>
          </div>
          <span className="hint">{t('drill.startLine')}</span>
          <span className="hint">{t('roles.removeHint')}</span>
        </section>
      )}
      <form
        className="schedule-form"
        onSubmit={(event) => {
          event.preventDefault()
          const input = draft
          void run(() => (role === null ? window.aios.roles.create(input) : window.aios.roles.update(role.id, input)), true)
        }}
      >
        <ScheduleField title={t('roles.field.name')}>
          <label className="schedule-field">
            <input
              type="text"
              value={draft.name}
              placeholder={t('roles.field.namePlaceholder')}
              onChange={(event) => set({ name: event.target.value })}
              spellCheck={false}
            />
          </label>
        </ScheduleField>

        <ScheduleField title={t('roles.field.folder')} description={t('roles.field.folderDescription')}>
          <label className="schedule-field">
            <span className="schedule-folder">
              <select
                value={draft.cwdUri ?? ''}
                onChange={(event) => set({ cwdUri: event.target.value === '' ? null : event.target.value })}
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
              <select
                value={draft.modelId ?? ''}
                onChange={(event) => set({ modelId: event.target.value === '' ? null : event.target.value })}
              >
                <option value="">{t('roles.field.modelDefault')}</option>
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
          <ScheduleField title={t('roles.field.thinking')}>
            <label className="schedule-field">
              <select
                value={draft.thinking ?? ''}
                onChange={(event) => {
                  const value = event.target.value
                  set({ thinking: isThinkingLevel(value) ? value : null })
                }}
              >
                <option value="">{t('roles.field.modelDefault')}</option>
                {thinkingSelectLevels(draft.thinking).map((level) => (
                  <option key={level} value={level}>
                    {thinkingLabel(level, false, t)}
                  </option>
                ))}
              </select>
            </label>
          </ScheduleField>
        ) : null}

        <ScheduleField title={t('roles.field.instructions')} description={primary?.standingInstructions === false ? `${t('roles.field.instructionsDescription')} ${t('roles.field.instructionsIgnored')}` : t('roles.field.instructionsDescription')}>
          <label className="schedule-field">
            <textarea
              className="settings-textarea schedule-prompt teammate-instructions"
              rows={8}
              maxLength={MAX_ROLE_INSTRUCTIONS}
              value={draft.instructions}
              placeholder={t('roles.field.instructionsPlaceholder')}
              onChange={(event) => set({ instructions: event.target.value })}
            />
          </label>
        </ScheduleField>

        <ScheduleField description={t('roles.field.strictDescription')}>
          <label className="schedule-check">
            <input
              type="checkbox"
              checked={draft.approvalStrict === true}
              onChange={(event) => set({ approvalStrict: event.target.checked })}
            />
            <span>{t('roles.field.strict')}</span>
          </label>
        </ScheduleField>

        {error === null ? null : <p className="denied">{describeReason(t, error)}</p>}
        <div className="settings-actions">
          <button type="submit" disabled={busy || draft.name.trim() === ''}>
            {t('roles.save')}
          </button>
          <button type="button" disabled={busy} onClick={closeEditor}>
            {t('common.cancel')}
          </button>
        </div>
      </form>
      {/* TODO 983 stage 4: rows added by "Always allow for this Teammate" in the approval frame, removable one at a time. */}
      {role === null ? null : <RoleGrantsTable roleId={role.id} />}
    </div>
  )
}
