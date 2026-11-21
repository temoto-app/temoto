/**
 * Per-thread settings (item 187, ARCHITECTURE.md 5.8). Opened from the ... at the right end of the thread heading.
 *
 * Split like VS Code's User / Workspace settings: app-wide settings are in the settings editor,
 * **settings for this thread only are here**. aios has only three per-thread settings, so they are
 * a small floating panel in the heading rather than a tab.
 * - Plan mode (4.2.3; moved from the prompt-field toggle in TODO 465. If the backend does not know Plan, the whole entry is hidden.
 *   The value is held by main (`runtime.planMode`) and is also switched by Shift+Tab and the ON badge of the prompt field)
 * - Strict mode (4.2.1; removed from the create dialog in item 150 and placed in the settings screen)
 * - OS sandbox (4.2.4, TODO 1106. Same shape as strict mode. If the backend does not have it, it is grayed out with the reason shown; it can always be turned OFF.
 *   TODO 1109 item 4: before the list is fetched (`os-sandbox-pending`) and when main refuses the switch (the reason code of the IPC rejection) are also
 *   shown in the same description row. No notification, dialog or band)
 * - Retention period of the conversation log (4.3.1)
 * - Delete this thread's log
 *
 * "Open viewer" (TODO 771), "Open working folder in the external editor" (item 255) and "Save conversation as PDF..." (TODO 818) were
 * moved in TODO 865 (wave 43) to the icon buttons at the top right of the heading (`ThreadHeaderActions`) and removed from here (not duplicated).
 */
import { useState } from 'react'
import type { BackendChoice, ThreadRetention } from '@shared/thread.js'
import { formatReason, parseReason } from '@shared/reason.js'
import { useThreads } from '../threadStore.js'
import { describeReason, useT } from '../i18n/index.js'
import { MenuPopover } from './MenuPopover.js'

const RETENTIONS: readonly ThreadRetention[] = ['forever', 'days', 'none']

/** Number of days when the retention period is N days (30 days, same as the former settings screen). */
const RETENTION_DAYS = 30

/**
 * Reason the OS sandbox cannot be used (TODO 1106). Null if it can. If startup found it unusable (`os-sandbox` in `degradations`), that reason;
 * otherwise "this version does not have it". Null if the backend list has not been fetched yet (no reason shown; the checkbox is grayed out via `sandboxKnown`).
 */
export function osSandboxUnavailableReason(choice: BackendChoice | undefined): string | null {
  if (choice === undefined || choice.osSandbox === true) return null
  // Old-shaped replies (test values, etc.) may not have `degradations`.
  const degraded = (choice.degradations ?? []).find((entry) => entry.feature === 'os-sandbox')
  return degraded === undefined ? formatReason('os-sandbox-unsupported') : (degraded.code ?? degraded.reason)
}

/**
 * The reason shown in the description row of the OS sandbox in the ... menu (TODO 1109 item 4). Priority: the reason main refused just now -> the reason it cannot be used
 * (`osSandboxUnavailableReason`) -> the list has not been fetched yet (only when OFF; when ON it can be turned OFF, so nothing is shown). Null if none.
 */
export function osSandboxMenuReason(input: {
  readonly refused: string | null
  readonly unavailable: string | null
  readonly known: boolean
  readonly on: boolean
}): string | null {
  if (input.refused !== null) return input.refused
  if (input.unavailable !== null) return input.unavailable
  return !input.known && !input.on ? formatReason('os-sandbox-pending') : null
}

/** Take the reason-code string from an IPC rejection (`guarded` always makes it a code, but if it cannot be picked up, internal-error). */
function refusalReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const reason = parseReason(message)
  return reason === null ? formatReason('internal-error') : formatReason(reason.code, reason.params)
}

export function ThreadSettingsMenu({ threadId }: { threadId: string }): React.JSX.Element | null {
  const t = useT()
  const thread = useThreads((state) => state.threadsById[threadId]?.thread)
  // Plan mode (TODO 465). Whether it is available comes from the backend's feature table (`BackendChoice.planMode`); the value from runtime.
  // Both are selectors that only return existing values (selected the same way as in the Composer).
  const backendId = thread?.backend ?? null
  const planAvailable = useThreads(
    (state) => state.backends?.find((choice) => choice.id === backendId)?.planMode === true
  )
  const planMode = useThreads((state) => state.threadsById[threadId]?.runtime.planMode === true)
  // TODO 1106: whether the OS sandbox can be used. The reason is a string (reason code), so the selector value is stable.
  const sandboxReason = useThreads((state) =>
    osSandboxUnavailableReason(state.backends?.find((choice) => choice.id === backendId))
  )
  // While the backend list has not been fetched yet it cannot be turned ON (main also refuses).
  const sandboxKnown = useThreads((state) => state.backends?.some((choice) => choice.id === backendId) === true)
  // TODO 1109 item 4: the reason main refused the switch (which thread and what was refused). Cleared on success.
  const [refused, setRefused] = useState<{ threadId: string; on: boolean; reason: string } | null>(null)
  if (thread === undefined) return null
  const osSandbox = thread.osSandbox === true
  // If the value changed after the refusal (switched in another window or another entry point), the old reason is not shown.
  const refusedReason = refused !== null && refused.threadId === thread.id && refused.on !== osSandbox ? refused.reason : null
  const sandboxNote = osSandboxMenuReason({ refused: refusedReason, unavailable: sandboxReason, known: sandboxKnown, on: osSandbox })
  const toggleSandbox = (on: boolean): void => {
    const id = thread.id
    window.aios.threads.setOsSandbox(id, on).then(
      () => setRefused(null),
      (err: unknown) => setRefused({ threadId: id, on, reason: refusalReason(err) })
    )
  }

  return (
    <MenuPopover
      className="thread-settings"
      label={t('threadSettings.button')}
      icon={<span aria-hidden="true">⋯</span>}
      role="dialog"
      align="right"
    >
      {() => (
        <div className="thread-settings-body">
          {planAvailable ? (
            // Same shape as strict mode (heading + checkbox + one-line description). The key (Shift+Tab) is written in the description.
            <div className="thread-settings-item">
              <div className="thread-settings-title">{t('threadSettings.plan.title')}</div>
              <label className="thread-settings-checkbox">
                <input
                  type="checkbox"
                  checked={planMode}
                  onChange={(event) =>
                    void window.aios.threads.setPlanMode(thread.id, event.target.checked)
                  }
                />
                <span>{t('threadSettings.plan.description')}</span>
              </label>
            </div>
          ) : null}
          <div className="thread-settings-item">
            <div className="thread-settings-title">{t('threadSettings.strict.title')}</div>
            <label className="thread-settings-checkbox">
              <input
                type="checkbox"
                checked={thread.approvalStrict}
                onChange={(event) =>
                  void window.aios.threads.setApprovalStrict(thread.id, event.target.checked)
                }
              />
              <span>{t('threadSettings.strict.description')}</span>
            </label>
          </div>
          <div className="thread-settings-item">
            <div className="thread-settings-title">{t('threadSettings.osSandbox.title')}</div>
            <label className="thread-settings-checkbox">
              <input
                type="checkbox"
                checked={osSandbox}
                // It cannot be turned ON for a backend that cannot use it. A conversation that became unusable while ON can only be turned OFF.
                disabled={(sandboxReason !== null || !sandboxKnown) && !osSandbox}
                onChange={(event) => toggleSandbox(event.target.checked)}
              />
              <span>{t('threadSettings.osSandbox.description')}</span>
            </label>
            {sandboxNote === null ? null : (
              <div className="thread-settings-description">{describeReason(t, sandboxNote)}</div>
            )}
          </div>
          <div className="thread-settings-item">
            <div className="thread-settings-title">{t('threadSettings.retention.title')}</div>
            <div className="thread-settings-description">
              {t('threadSettings.retention.description')}
            </div>
            <select
              value={thread.retention}
              aria-label={t('threadSettings.retention.title')}
              onChange={(event) => {
                const next = event.target.value as ThreadRetention
                void window.aios.threads.setRetention(
                  thread.id,
                  next,
                  next === 'days' ? RETENTION_DAYS : null
                )
              }}
            >
              {RETENTIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`threadSettings.retention.${value}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="thread-settings-item">
            <button
              type="button"
              className="danger"
              onClick={() => void window.aios.threads.clearLog(thread.id)}
            >
              {t('threadSettings.clearLog')}
            </button>
          </div>
        </div>
      )}
    </MenuPopover>
  )
}
