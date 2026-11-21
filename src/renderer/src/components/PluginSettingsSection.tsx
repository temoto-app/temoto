/**
 * The "Settings" of an extension's detail (TODO 1225, ARCHITECTURE 7.2.1). Renders the fields of the manifest's `configuration` and saves values to main.
 * What is drawn is the renderer's own screen (the extension's code is not run). The field headings and descriptions are text the extension declared.
 *
 * As in VS Code's settings editor, there is no save button; changes are saved as they are made (booleans on toggle, strings and tables when the field loses focus).
 * A table has one item per line, and leading/trailing whitespace and blank lines are dropped before sending. Main validates the value against the declaration (`PluginSettingsStore.update`).
 *
 * Fix X (code-review):
 * - **Only the one changed field is sent per save, and saves are serialized** (the next waits until the previous one returns). Previously all fields were sent from a stale `view`,
 *   so if another field was changed before the blur save returned, the second save rolled back the first with a stale value.
 * - **A successful save does not rebuild the fields** (previously the version went into `key` and every field was rebuilt, so a hurried click was lost and focus vanished). A field
 *   keeps its own input, and is overwritten with main's value only when the save was refused (that field only).
 * - Lines that do not match the item's shape (`format`, main's fixed table) are pointed out before sending, and the input is kept (so it can be fixed). Errors are shown per field.
 * - A field whose stored value does not match the current declaration (`storedInvalid`, not passed to the extension) is shown as "not in use" so the user can fix it.
 */
import { useEffect, useRef, useState } from 'react'
import { matchesFormat, type PluginSettingField, type PluginSettingValue, type PluginSettingsView } from '@shared/plugin-settings.js'
import type { SettingFormat } from '@shared/setting-format.js'
import { describeReason, useT } from '../i18n/index.js'

/** The textarea string of a table -> the value to send (leading/trailing whitespace and blank lines dropped). */
export function linesToList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** Numbers of the textarea lines that do not match the item's shape (1-based, blank lines are counted). */
export function mismatchedLines(field: Pick<PluginSettingField, 'format'>, text: string): number[] {
  if (field.format === undefined) return []
  const out: number[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    const value = line.trim()
    if (value !== '' && !matchesFormat(field.format, value)) out.push(index + 1)
  })
  return out
}

/** Key of the description text per format name (aios's own text; the extension's text is not used). */
const FORMAT_HINT = {
  email: 'extensions.settings.format.email',
  hostname: 'extensions.settings.format.hostname',
  'email-or-domain': 'extensions.settings.format.emailOrDomain'
} as const satisfies Record<SettingFormat, string>

function textOf(value: PluginSettingValue): string {
  return Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : ''
}

function FieldControl({
  field,
  reset,
  error,
  onCommit,
  onInvalid
}: {
  readonly field: PluginSettingField
  /** The parent increments it when a save is refused. Resets the field's input to the saved value (`field.value`). */
  readonly reset: number
  readonly error: string | null
  readonly onCommit: (value: PluginSettingValue) => void
  readonly onInvalid: (message: string | null) => void
}): React.JSX.Element {
  const t = useT()
  const [text, setText] = useState(textOf(field.value))
  const [checked, setChecked] = useState(field.value === true)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    setText(textOf(field.value))
    setChecked(field.value === true)
    // Reset only when refused (when `reset` advanced). A change of `field.value` (a successful save) does not touch the input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reset])

  const id = `plugin-setting-${field.name}`
  const errorId = `${id}-error`
  // Fix X: a field whose saved value does not match the current shape and is not used keeps being reported until it is saved again (a save error takes precedence).
  const shown = error ?? (field.storedInvalid === true ? t('extensions.settings.storedInvalid') : null)
  const errorLine =
    shown === null ? null : (
      <p id={errorId} className="extension-account-error" role="alert">
        {shown}
      </p>
    )
  if (field.type === 'boolean') {
    return (
      <>
        <label className="extension-setting-check">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => {
              setChecked(event.target.checked)
              onCommit(event.target.checked)
            }}
          />
          <span>{field.description}</span>
        </label>
        {errorLine}
      </>
    )
  }
  const shapeMessage = (lines: readonly number[]): string =>
    [
      field.type === 'array' ? t('extensions.settings.invalidLines', { lines: lines.join(', ') }) : t('extensions.settings.invalidValue'),
      field.format === undefined ? '' : t(FORMAT_HINT[field.format])
    ]
      .filter((part) => part !== '')
      .join(' ')
  return (
    <>
      <label htmlFor={id} className="hint extension-setting-description">
        {field.description}
      </label>
      {field.type === 'string' ? (
        <input
          id={id}
          className="extension-account-input extension-setting-input"
          value={text}
          maxLength={field.maxLength}
          aria-invalid={shown !== null}
          aria-describedby={shown === null ? undefined : errorId}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            if (text === field.value) return
            if (!matchesFormat(field.format, text)) {
              onInvalid(shapeMessage([]))
              return
            }
            onCommit(text)
          }}
        />
      ) : (
        <textarea
          id={id}
          className="settings-textarea extension-setting-input"
          rows={Math.min(8, Math.max(3, text.split('\n').length + 1))}
          value={text}
          aria-invalid={shown !== null}
          aria-describedby={shown === null ? undefined : errorId}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            const next = linesToList(text)
            if (next.join('\n') === textOf(field.value)) {
              onInvalid(null)
              return
            }
            const bad = mismatchedLines(field, text)
            if (bad.length > 0) {
              onInvalid(shapeMessage(bad))
              return
            }
            onCommit(next)
          }}
        />
      )}
      {errorLine}
    </>
  )
}

export function PluginSettingsSection({ pluginId }: { readonly pluginId: string }): React.JSX.Element | null {
  const t = useT()
  const [view, setView] = useState<PluginSettingsView | null>(null)
  /** Errors per field (a save was refused / the value does not match the shape). */
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  /** Per-field "restore the saved value" counter (advanced only when a save is refused). */
  const [resets, setResets] = useState<Readonly<Record<string, number>>>({})
  /** Save queue (the next one is not sent until the previous one returns). */
  const queue = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    let cancelled = false
    void window.aios.pluginSettings.get(pluginId).then(
      (next) => {
        if (!cancelled) setView(next)
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [pluginId])

  if (view === null || view.fields.length === 0) return null

  const setError = (name: string, message: string | null): void => {
    setErrors((current) => {
      if (message === null) {
        if (!Object.hasOwn(current, name)) return current
        const { [name]: _gone, ...rest } = current
        return rest
      }
      return { ...current, [name]: message }
    })
  }

  const commit = (name: string, value: PluginSettingValue): void => {
    setError(name, null)
    queue.current = queue.current.then(async () => {
      try {
        const next = await window.aios.pluginSettings.save(pluginId, name, value)
        // Only this field re-remembers its saved value (other fields keep their own input and the result of their own save).
        const saved = next.fields.find((field) => field.name === name)
        if (saved !== undefined) {
          setView((current) =>
            current === null ? current : { ...current, fields: current.fields.map((field) => (field.name === name ? saved : field)) }
          )
        }
      } catch (err) {
        setError(name, describeReason(t, err instanceof Error ? err.message : String(err)))
        // Only the refused field is reset to its saved value.
        setResets((current) => ({ ...current, [name]: (current[name] ?? 0) + 1 }))
      }
    })
  }

  return (
    <section className="extension-settings" aria-label={t('extensions.settings.title')}>
      <h3>{view.title ?? t('extensions.settings.title')}</h3>
      {view.reset === true ? (
        <p className="hint" role="status" data-testid="plugin-settings-reset">
          {t('extensions.settings.reset')}
        </p>
      ) : null}
      {view.fields.map((field) => (
        <div key={field.name} className="extension-setting" data-setting={field.name}>
          <div className="extension-setting-title">{field.title}</div>
          <FieldControl
            field={field}
            reset={resets[field.name] ?? 0}
            error={errors[field.name] ?? null}
            onCommit={(value) => commit(field.name, value)}
            onInvalid={(message) => setError(field.name, message)}
          />
        </div>
      ))}
      <p className="hint">{t('extensions.settings.hint')}</p>
    </section>
  )
}
