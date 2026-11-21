/**
 * The name input that opens at a tree row's position (TODO 370, same as "New File" in VS Code's explorer).
 * No dialog is shown (TODO 167). For now only "new file / folder" uses it, but so that renaming (F2) can be added
 * with the same component, it does not know what is being created (the caller passes `validate` / `onSubmit`).
 *
 * - Enter calls `onSubmit`. **The Enter that confirms IME conversion is not caught** (`isComposing` / keyCode 229, the same gate as `navKey`).
 *   Enter on an empty field cancels (same as VS Code).
 * - Esc cancels (`onCancel('escape')`, and the caller returns focus to the tree). Pressing outside the field (= blur) also
 *   cancels (`onCancel('blur')`, focus stays where it was pressed). A blur where the whole window lost focus (switching to another app) does
 *   not cancel (you can keep typing when you return).
 * - It runs `validate` on every keystroke, and if there is a problem shows a red popover (`role="alert"`) under the input. Enter
 *   does the same check and, if there is a problem, does not create. If `onSubmit` returns a message (main refused), it is shown in the popover and the field stays.
 * - The container's (the tree's `.file-tree`) keydown does nothing when `event.target !== event.currentTarget`, so
 *   the arrow keys (356) stay as cursor movement inside the field and the tree behind does not move.
 * - Colors are only CSS variables (`.inline-name-*`, 7.4.1).
 */
import { useEffect, useRef, useState } from 'react'

export type InlineNameCancel = 'escape' | 'blur'

export interface InlineNameInputProps {
  /** The row's indent (the tree depth). */
  readonly depth: number
  /** The mark at the head of the row (the same character as the tree's `row-icon`). */
  readonly icon: string
  /**
   * The kind icon to the right of the open / close mark (TODO 404, Seti). Received as a function so it can be derived from the typed name (as in VS Code,
   * typing up to `.ts` gives the TypeScript mark). Not shown if absent.
   */
  readonly kindIcon?: (value: string) => React.ReactNode
  readonly ariaLabel: string
  readonly initial?: string
  /** The per-keystroke check. The problem's message, or null if none. */
  readonly validate: (value: string) => string | null
  /** Enter. null if it could be created, or the message if refused (shown in the popover and the field stays). */
  readonly onSubmit: (value: string) => Promise<string | null>
  readonly onCancel: (why: InlineNameCancel) => void
}

export function InlineNameInput({
  depth,
  icon,
  kindIcon,
  ariaLabel,
  initial = '',
  validate,
  onSubmit,
  onCancel
}: InlineNameInputProps): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const composing = useRef(false)
  // A blur while creating / after deciding to close does not count as a cancel.
  const busy = useRef(false)
  const closing = useRef(false)

  // Focus in a passive effect: it runs after the focus restore done when the right-click menu (365-1) closes (the passive
  // cleanup of the same commit), so the field takes focus even when opened from the menu's "New file...".
  useEffect(() => {
    const el = inputRef.current
    if (el === null) return
    el.focus()
    if (initial !== '') el.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cancel = (why: InlineNameCancel): void => {
    if (closing.current) return
    closing.current = true
    onCancel(why)
  }

  const submit = async (): Promise<void> => {
    if (busy.current || closing.current) return
    if (value.trim() === '') {
      cancel('escape')
      return
    }
    const problem = validate(value)
    if (problem !== null) {
      setError(problem)
      return
    }
    busy.current = true
    let refused: string | null
    try {
      refused = await onSubmit(value)
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err)
    }
    busy.current = false
    if (refused === null) {
      closing.current = true
      return
    }
    setError(refused)
    inputRef.current?.focus()
  }

  return (
    <div className="inline-name" style={{ paddingLeft: `${8 + depth * 12}px` }}>
      <span className="row-icon">{icon}</span>
      {kindIcon === undefined ? null : kindIcon(value)}
      <span className="inline-name-field">
        <input
          ref={inputRef}
          className={`inline-name-input${error === null ? '' : ' invalid'}`}
          type="text"
          value={value}
          aria-label={ariaLabel}
          aria-invalid={error !== null}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            const next = event.target.value
            setValue(next)
            // Do not blame while empty (before typing starts, or right after clearing). Enter on empty is a cancel.
            setError(next.trim() === '' ? null : validate(next))
          }}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionEnd={() => {
            composing.current = false
          }}
          onKeyDown={(event) => {
            const native = event.nativeEvent
            if (composing.current || native.isComposing || native.keyCode === 229) return
            if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              void submit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              cancel('escape')
            }
          }}
          onBlur={() => {
            if (busy.current || closing.current) return
            // Do not cancel when only the whole window lost focus (to another app).
            if (typeof document.hasFocus === 'function' && !document.hasFocus()) return
            cancel('blur')
          }}
        />
        {error === null ? null : (
          <span className="inline-name-error" role="alert">
            {error}
          </span>
        )}
      </span>
    </div>
  )
}
