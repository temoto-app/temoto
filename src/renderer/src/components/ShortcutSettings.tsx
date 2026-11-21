/**
 * "Keyboard shortcuts" in the settings screen (TODO 549, ARCHITECTURE 5.5.2). The form of VS Code's Keyboard Shortcuts:
 * a list of commands (with a filter field), and per row "Change" (press keys and confirm with Enter, cancel with Esc),
 * "Remove" and "Reset to default". If the same key conflicts with another command or an OS / edit-menu key, it tells the user on the spot
 * (it does not block; as in VS Code, it can be saved while conflicting).
 *
 * - The table is `KEYBINDING_COMMANDS` in `src/shared/keybindings.ts`. **Keys inside the viewer's editor are out of scope**
 *   (owner decision 2026-10-09). The exceptions are TODO 692's go to declaration (F12) / list assignments and uses (Shift+F12), which are in the table and can be changed
 *   (owner decision 2026-10-11. The host passes the changed keys to the viewer as `editorKeys`).
 * - The writer is main (`keybindings.set`). Here only the diff is built and sent, and the value main re-validated comes back into
 *   `useKeybindings`.
 * - While recording, this window's menu accelerators are stopped (`setKeybindingRecording`) so that Cmd+B and so on reach the recording field.
 *   The recording field's keydown stops propagation and does not trigger the app's shortcuts (Cmd+P etc.).
 */
import { useEffect, useMemo, useState } from 'react'
import {
  KEYBINDING_COMMAND_IDS,
  conflictsOf,
  displayKeybinding,
  effectiveKeybinding,
  isKeybindingModified,
  keybindingFromInput,
  withKeybinding,
  type KeybindingCommandId,
  type KeybindingConflicts,
  type GlobalHotkeyStatuses,
  type KeybindingOverrides
} from '@shared/keybindings.js'
import { useT, type Translate } from '../i18n/index.js'
import { ASCII_INPUT } from '@shared/ascii-input.js'
import { currentKeybindings } from '../shortcuts.js'
import { saveKeybindings, setKeybindingRecording, useKeybindings } from '../keybindingStore.js'
import { foldForSearch } from '../settings-model.js'

interface Recording {
  readonly id: KeybindingCommandId
  /** The key pressed. null if not yet, or if the modifier is missing. */
  readonly key: string | null
  /** A key without a modifier was pressed (show guidance). */
  readonly invalid: boolean
}

/** Lists the names of the conflicting counterparts. */
function conflictText(t: Translate, conflicts: KeybindingConflicts): string | null {
  const names = [
    ...conflicts.commands.map((id) => t(`shortcuts.command.${id}`)),
    ...conflicts.reserved.map((group) => t(`shortcuts.reserved.${group}`))
  ]
  return names.length === 0 ? null : t('shortcuts.conflict', { names: names.join(' / ') })
}

export function ShortcutSettings(): React.JSX.Element {
  const t = useT()
  const overrides = useKeybindings((state) => state.overrides)
  const platform = currentKeybindings().platform
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<Recording | null>(null)
  // TODO 976 item 1: the result of registering the global hotkey. Re-fetched every time the assignment changes (main finishes the registration before and after saving).
  const [hotkey, setHotkey] = useState<GlobalHotkeyStatuses | null>(null)
  useEffect(() => {
    let alive = true
    void window.aios.keybindings?.globalStatus?.().then((status) => {
      if (alive) setHotkey(status)
    })
    return () => {
      alive = false
    }
  }, [overrides])

  // Menu accelerators are stopped only while recording. They are always restored when it ends (including when the screen is closed).
  const isRecording = recording !== null
  useEffect(() => {
    if (!isRecording) return
    setKeybindingRecording(true)
    return () => setKeybindingRecording(false)
  }, [isRecording])

  const rows = useMemo(() => {
    const terms = foldForSearch(query)
      .split(/\s+/)
      .filter((term) => term !== '')
    return KEYBINDING_COMMAND_IDS.filter((id) => {
      if (terms.length === 0) return true
      const key = effectiveKeybinding(id, platform, overrides)
      const haystack = foldForSearch(
        [t(`shortcuts.command.${id}`), id, key === null ? '' : displayKeybinding(key, platform), key ?? ''].join('\n')
      )
      return terms.every((term) => haystack.includes(term))
    })
  }, [query, overrides, platform, t])

  const apply = (next: KeybindingOverrides): void => {
    void saveKeybindings(next)
  }

  const commit = (): void => {
    if (recording === null || recording.key === null) return
    apply(withKeybinding(overrides, recording.id, recording.key, platform))
    setRecording(null)
  }

  const onRecordKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // Do not pass it on to the app's shortcuts (the window keydown) or to the input itself.
    event.preventDefault()
    event.stopPropagation()
    if (event.nativeEvent.isComposing) return
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    if (plain && event.key === 'Escape') {
      setRecording(null)
      return
    }
    if (plain && event.key === 'Enter') {
      commit()
      return
    }
    if (recording === null) return
    const key = keybindingFromInput(event.nativeEvent, platform)
    if (key !== null) setRecording({ id: recording.id, key, invalid: false })
    else if (!['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) {
      setRecording({ id: recording.id, key: null, invalid: true })
    }
  }

  const modifiedCount = KEYBINDING_COMMAND_IDS.filter((id) => isKeybindingModified(id, overrides)).length

  return (
    <div className="shortcut-settings">
      <div className="shortcut-settings-toolbar">
        <input
          type="search"
          {...ASCII_INPUT}
          className="shortcut-settings-filter"
          placeholder={t('shortcuts.filter.placeholder')}
          aria-label={t('shortcuts.filter.placeholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          spellCheck={false}
        />
        <button type="button" disabled={modifiedCount === 0} onClick={() => apply({})}>
          {t('shortcuts.resetAll')}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="hint">{t('shortcuts.none')}</p>
      ) : (
        <table className="shortcut-settings-table">
          <thead>
            <tr>
              <th scope="col">{t('shortcuts.column.command')}</th>
              <th scope="col">{t('shortcuts.column.key')}</th>
              <th scope="col">
                <span className="visually-hidden">{t('shortcuts.column.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((id) => {
              const key = effectiveKeybinding(id, platform, overrides)
              const modified = isKeybindingModified(id, overrides)
              const editing = recording !== null && recording.id === id
              const shown = editing ? recording.key : key
              const warning =
                shown === null ? null : conflictText(t, conflictsOf(shown, id, platform, overrides))
              return (
                <tr key={id} className={modified ? 'modified' : undefined} data-command={id}>
                  <td className="shortcut-settings-command">
                    {t(`shortcuts.command.${id}`)}
                    {modified ? <span className="shortcut-settings-badge">{t('shortcuts.modified')}</span> : null}
                  </td>
                  <td className="shortcut-settings-key">
                    {editing ? (
                      <input
                        className="shortcut-settings-record"
                        {...ASCII_INPUT}
                        autoFocus
                        readOnly
                        aria-label={t('shortcuts.recording.prompt')}
                        placeholder={t('shortcuts.recording.prompt')}
                        value={recording.key === null ? '' : displayKeybinding(recording.key, platform)}
                        onKeyDown={onRecordKey}
                        onBlur={() => setRecording(null)}
                      />
                    ) : key === null ? (
                      <span className="hint">{t('shortcuts.unbound')}</span>
                    ) : (
                      <kbd>{displayKeybinding(key, platform)}</kbd>
                    )}
                    {editing && recording.invalid ? (
                      <div className="hint">{t('shortcuts.recording.invalid')}</div>
                    ) : null}
                    {warning === null ? null : <div className="shortcut-settings-conflict">{warning}</div>}
                    {(id === 'app.summon' || id === 'app.summonDictate') && !editing && hotkey?.[id].state === 'failed' ? (
                      <div className="shortcut-settings-conflict" role="alert">
                        {t('shortcuts.summon.failed')}
                      </div>
                    ) : null}
                    {(id === 'app.summon' || id === 'app.summonDictate') && !editing && hotkey?.[id].state === 'disabled' ? (
                      <div className="hint">{t('shortcuts.summon.disabled')}</div>
                    ) : null}
                  </td>
                  <td className="shortcut-settings-actions">
                    {editing ? (
                      <>
                        <button
                          type="button"
                          disabled={recording.key === null}
                          // Decide before blur ends the recording.
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={commit}
                        >
                          {t('shortcuts.accept')}
                        </button>
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => setRecording(null)}
                        >
                          {t('common.cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={() => setRecording({ id, key: null, invalid: false })}>
                          {t('shortcuts.edit')}
                        </button>
                        {key === null ? null : (
                          <button type="button" onClick={() => apply(withKeybinding(overrides, id, null, platform))}>
                            {t('shortcuts.remove')}
                          </button>
                        )}
                        {modified ? (
                          <button
                            type="button"
                            onClick={() => apply(withKeybinding(overrides, id, undefined, platform))}
                          >
                            {t('shortcuts.reset')}
                          </button>
                        ) : null}
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
