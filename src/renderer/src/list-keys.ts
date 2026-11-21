/**
 * Pure functions for keyboard handling of lists (TODO 356 / 357, wave 19 bundle C). Independent of the DOM and React
 * (`test/list-keys.test.ts`). The convention is the same as `segmentedKeyStep` in `composer-choice.ts`:
 * take a key and the current position and return the next position; null for keys not handled.
 *
 * There are two callers:
 * - the Files tree in the sidebar (356, VS Code's Explorer. Stops at the ends)
 * - the results in search mode (357, VS Code's Quick Open. Wraps at the ends and skips section headings)
 *
 * The ← / → / Enter decisions only for the tree are in `treeKeyAction` in `file-tree.ts` (it looks at row depth and expansion).
 */

/** How `listKeyStep` moves. */
export interface ListKeyOptions {
  /** Whether to wrap around to the opposite end at an end (Quick Open wraps, the Explorer stops). */
  readonly wrap: boolean
  /** Go to the ends with Home / End (default true). False for a list where an input field has focus (leave it to the text cursor). */
  readonly homeEnd?: boolean
  /** Number of rows PageUp / PageDown move. If omitted, they are not handled. */
  readonly page?: number
  /** Whether each row can be selected (false for heading and notice rows). If omitted, all are selectable. */
  readonly selectable?: readonly boolean[]
}

/**
 * The next position. null for keys not handled, or when no row is selectable. When stopping at an end, the current position is
 * returned as is (the key was handled = the caller calls `preventDefault`).
 *
 * When `index` is out of range (-1, etc.) or on an unselectable row: ↓ goes to the first selectable row; ↑ goes to the last when
 * wrapping and to the first when stopping. Both are the "first press on a list that points at nothing yet" case; VS Code's Explorer
 * also lands on the first row with ↓.
 */
export function listKeyStep(
  key: string,
  index: number,
  length: number,
  options: ListKeyOptions
): number | null {
  if (length <= 0) return null
  const selectable = options.selectable
  const ok = (i: number): boolean =>
    i >= 0 && i < length && (selectable === undefined || selectable[i] === true)
  const first = nextFrom(-1, 1, length, ok)
  if (first === null) return null
  const last = nextFrom(length, -1, length, ok) ?? first
  const homeEnd = options.homeEnd !== false
  const placed = ok(index)

  switch (key) {
    case 'ArrowDown': {
      if (!placed) return first
      const next = nextFrom(index, 1, length, ok)
      if (next !== null) return next
      return options.wrap ? first : index
    }
    case 'ArrowUp': {
      if (!placed) return options.wrap ? last : first
      const prev = nextFrom(index, -1, length, ok)
      if (prev !== null) return prev
      return options.wrap ? last : index
    }
    case 'Home':
      return homeEnd ? first : null
    case 'End':
      return homeEnd ? last : null
    case 'PageDown':
    case 'PageUp': {
      if (options.page === undefined) return null
      if (!placed) return first
      const step = key === 'PageDown' ? 1 : -1
      // Look for a selectable row in the same direction from the row `page` rows ahead. If none, the end (paging does not wrap).
      const target = Math.max(0, Math.min(length - 1, index + step * Math.max(1, options.page)))
      if (ok(target)) return target
      return nextFrom(target, step, length, ok) ?? (step === 1 ? last : first)
    }
    default:
      return null
  }
}

/**
 * The row to highlight (TODO 357, Quick Open's "the first candidate is highlighted from the start"). If the remembered position
 * is a selectable row, that one; otherwise (not moved yet, or the list changed) the first selectable row. -1 if no row is selectable.
 */
export function activeIndex(index: number, selectable: readonly boolean[]): number {
  if (index >= 0 && selectable[index] === true) return index
  return selectable.indexOf(true)
}

/** The first selectable row in the direction `step` after `from`, without wrapping. null if none. */
function nextFrom(
  from: number,
  step: number,
  length: number,
  ok: (i: number) => boolean
): number | null {
  for (let i = from + step; i >= 0 && i < length; i += step) {
    if (ok(i)) return i
  }
  return null
}

/** The keydown fields that `navKey` reads (a shape that accepts both a React synthetic event and a DOM `KeyboardEvent`). */
export interface NavKeyEvent {
  readonly key: string
  readonly keyCode?: number
  readonly isComposing?: boolean
  readonly metaKey?: boolean
  readonly ctrlKey?: boolean
  readonly altKey?: boolean
  readonly shiftKey?: boolean
  /** A React synthetic event has no `isComposing`; it is on the `nativeEvent` side. */
  readonly nativeEvent?: { readonly isComposing?: boolean }
}

/**
 * Whether the key may be read as a list operation. null when it is not read:
 * - During IME composition (`isComposing`; old IMEs only have keyCode 229, the same check as the filter field in `Sidebar.tsx`).
 *   Do not move the list with ↑↓ on conversion candidates or Enter to confirm.
 * - With a modifier key (⌘↑ goes to the start of the input line, ⌥↑ to the paragraph, shortcuts such as ⌃⌘I go through another entry point).
 */
export function navKey(event: NavKeyEvent, composing = false): string | null {
  if (
    composing ||
    event.isComposing === true ||
    event.nativeEvent?.isComposing === true ||
    event.keyCode === 229
  ) {
    return null
  }
  if (event.metaKey === true || event.ctrlKey === true || event.altKey === true) return null
  if (event.shiftKey === true) return null
  return event.key
}
