/**
 * Helpers for keeping per-window "look and feel" settings in `localStorage`
 * (ARCHITECTURE.md 5.5 / 5.5.1, T15 / T24).
 *
 * The split ratio (`paneRatio.ts`, a 0 to 1 ratio) and the sidebar width (`sidebarWidth.ts`, px) are
 * **rounded in completely different ways**, so they are not folded into one function. What they share is only the discipline that
 * "even accessing `localStorage` can throw / rendering must not break even if a corrupt value is stored",
 * and that is all this file collects.
 */

/** The minimal `Storage` equivalent. The type is narrowed so tests can substitute it. */
export interface PrefStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** A reference to `localStorage` itself. Wrapped because in some environments even the access throws. */
export function safeStorage(): PrefStorage | undefined {
  try {
    return globalThis.localStorage as PrefStorage | undefined
  } catch {
    return undefined
  }
}

/**
 * Reads a number. **Rendering must not break even when it cannot be read**, so both exceptions (private
 * window / site data denied) and corrupt values return `undefined` and leave it to the caller.
 * `accept` decides whether the value may be taken (the lower and upper bounds of the range are the caller's business).
 */
export function readNumber(
  storage: PrefStorage | undefined,
  key: string,
  accept: (value: number) => boolean
): number | undefined {
  if (storage === undefined) return undefined
  let raw: string | null = null
  try {
    raw = storage.getItem(key)
  } catch {
    return undefined
  }
  if (raw === null) return undefined
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value) || !accept(value)) return undefined
  return value
}

/** Writes a number. Failures are ignored (it is a look-and-feel setting, so there is no reason to fail hard). */
export function writeNumber(
  storage: PrefStorage | undefined,
  key: string,
  value: string
): void {
  if (storage === undefined) return
  try {
    storage.setItem(key, value)
  } catch {
    /* It just could not be saved. The look for this session can be used as is */
  }
}

/**
 * Reads a boolean (`sidebarCollapse.ts`, T27). Only `'1'` / `'0'` are accepted; anything else becomes
 * `undefined` = "not stored", falling back to the caller's default. `Boolean(raw)` is avoided
 * so that strings such as `'false'` or `'0'` do not all become true.
 */
export function readFlag(storage: PrefStorage | undefined, key: string): boolean | undefined {
  if (storage === undefined) return undefined
  let raw: string | null = null
  try {
    raw = storage.getItem(key)
  } catch {
    return undefined
  }
  if (raw === '1') return true
  if (raw === '0') return false
  return undefined
}

/** Writes a boolean. Same `'1'` / `'0'` form as `readFlag`; failures are ignored. */
export function writeFlag(
  storage: PrefStorage | undefined,
  key: string,
  value: boolean
): void {
  writeNumber(storage, key, value ? '1' : '0')
}

/**
 * Reads a string (the sort criteria of item 152). A value that fails `accept`, or an exception, becomes `undefined` =
 * "not stored" and falls back to the caller's default.
 */
export function readString(
  storage: PrefStorage | undefined,
  key: string,
  accept: (value: string) => boolean
): string | undefined {
  if (storage === undefined) return undefined
  let raw: string | null = null
  try {
    raw = storage.getItem(key)
  } catch {
    return undefined
  }
  if (raw === null || !accept(raw)) return undefined
  return raw
}

/** Writes a string. Failures are ignored. */
export function writeString(storage: PrefStorage | undefined, key: string, value: string): void {
  writeNumber(storage, key, value)
}
