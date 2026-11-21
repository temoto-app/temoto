// @vitest-environment jsdom
/**
 * TODO 659 (wave 30 bundle C): the setting for how many days a row with no activity is folded in the thread list.
 *
 * - Validation of the value (`isCollapseOldAfterDays` / `clampCollapseOldAfterDays`, `@shared/thread-collapse.js`).
 * - The default of `THREADS_COLLAPSE_OLD_AFTER_DAYS` (5) and where broken values fall back to.
 * - `ThreadCollapsePreference`: writes only the key that changed and notifies all windows. The same value or a broken value does nothing.
 * - The renderer's `threadCollapseStore.ts`: an out-of-range input typed into the field does not briefly turn into 0 (code-review fix).
 *
 * The fold decision and sorting themselves are in `test/thread-sort.test.ts` (pure functions, `thread-sort.ts`).
 * Neither a model, a DB, nor Electron is used (only the renderer section uses jsdom).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_COLLAPSE_OLD_AFTER_DAYS,
  MAX_COLLAPSE_OLD_AFTER_DAYS,
  MIN_COLLAPSE_OLD_AFTER_DAYS,
  clampCollapseOldAfterDays,
  isCollapseOldAfterDays
} from '../src/shared/thread-collapse.js'
import { THREADS_COLLAPSE_OLD_AFTER_DAYS } from '../src/common/settings-keys.js'
import { ThreadCollapsePreference } from '../src/main/thread-collapse.js'
import type { AppSettingsStore } from '../src/common/settings.js'
import { initialCollapseDays, useThreadCollapse } from '../src/renderer/src/threadCollapseStore.js'

describe('isCollapseOldAfterDays / clampCollapseOldAfterDays', () => {
  it('true only for an integer within range', () => {
    expect(isCollapseOldAfterDays(5)).toBe(true)
    expect(isCollapseOldAfterDays(0)).toBe(true)
    expect(isCollapseOldAfterDays(MAX_COLLAPSE_OLD_AFTER_DAYS)).toBe(true)
    expect(isCollapseOldAfterDays(-1)).toBe(false)
    expect(isCollapseOldAfterDays(1.5)).toBe(false)
    expect(isCollapseOldAfterDays(MAX_COLLAPSE_OLD_AFTER_DAYS + 1)).toBe(false)
    expect(isCollapseOldAfterDays('5')).toBe(false)
    expect(isCollapseOldAfterDays(Number.NaN)).toBe(false)
  })

  it('clamps out-of-range values to the edge and rounds to an integer, and null when not a number', () => {
    expect(clampCollapseOldAfterDays(5)).toBe(5)
    expect(clampCollapseOldAfterDays(5.4)).toBe(5)
    expect(clampCollapseOldAfterDays(-3)).toBe(MIN_COLLAPSE_OLD_AFTER_DAYS)
    expect(clampCollapseOldAfterDays(MAX_COLLAPSE_OLD_AFTER_DAYS + 100)).toBe(MAX_COLLAPSE_OLD_AFTER_DAYS)
    expect(clampCollapseOldAfterDays('5')).toBeNull()
    expect(clampCollapseOldAfterDays(Number.NaN)).toBeNull()
    expect(clampCollapseOldAfterDays(null)).toBeNull()
  })
})

describe('THREADS_COLLAPSE_OLD_AFTER_DAYS (app_settings key)', () => {
  it('default is 5 days, and a broken or missing value falls back to the default', () => {
    expect(THREADS_COLLAPSE_OLD_AFTER_DAYS.parse(null)).toBe(DEFAULT_COLLAPSE_OLD_AFTER_DAYS)
    expect(THREADS_COLLAPSE_OLD_AFTER_DAYS.parse('abc')).toBe(DEFAULT_COLLAPSE_OLD_AFTER_DAYS)
    expect(THREADS_COLLAPSE_OLD_AFTER_DAYS.parse('10')).toBe(10)
    expect(THREADS_COLLAPSE_OLD_AFTER_DAYS.parse('0')).toBe(0)
  })

  it('parse(serialize(x)) round-trips', () => {
    expect(THREADS_COLLAPSE_OLD_AFTER_DAYS.parse(THREADS_COLLAPSE_OLD_AFTER_DAYS.serialize(7))).toBe(7)
  })

  it('the owner is main', () => {
    expect(THREADS_COLLAPSE_OLD_AFTER_DAYS.owner).toBe('main')
  })
})

describe('ThreadCollapsePreference', () => {
  function fakeStore(): AppSettingsStore {
    const stored = new Map<string, string>()
    return {
      readTyped: <T,>(key: { key: string; parse: (raw: string | null) => T }) =>
        key.parse(stored.get(key.key) ?? null),
      writeTyped: <T,>(key: { key: string; serialize: (v: T) => string }, value: T) => {
        stored.set(key.key, key.serialize(value))
      }
    } as unknown as AppSettingsStore
  }

  it('default 5 days, writes and notifies only a changed value, and does nothing for the same value', () => {
    const settings = fakeStore()
    const changed = vi.fn()
    const preference = new ThreadCollapsePreference(settings, changed)
    expect(preference.get()).toBe(5)
    expect(preference.set(10)).toBe(10)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenLastCalledWith(10)
    expect(preference.set(10)).toBe(10)
    expect(changed).toHaveBeenCalledTimes(1)
    // Reading it again gives the same result.
    expect(new ThreadCollapsePreference(settings).get()).toBe(10)
  })

  it('ignores a broken value and returns the current value, without notifying', () => {
    const settings = fakeStore()
    const changed = vi.fn()
    const preference = new ThreadCollapsePreference(settings, changed)
    expect(preference.set('nope')).toBe(5)
    expect(preference.set(Number.NaN)).toBe(5)
    expect(changed).not.toHaveBeenCalled()
  })

  // code-review fix (TODO 659): out-of-range or non-integer values are rejected, not rounded (typing "-5" in the field does not turn into 0).
  it('does not save an out-of-range or non-integer value and returns the current value', () => {
    const settings = fakeStore()
    const changed = vi.fn()
    const preference = new ThreadCollapsePreference(settings, changed)
    expect(preference.set(-5)).toBe(5)
    expect(preference.set(MAX_COLLAPSE_OLD_AFTER_DAYS + 1)).toBe(5)
    expect(preference.set(2.5)).toBe(5)
    expect(changed).not.toHaveBeenCalled()
  })
})

describe('initialCollapseDays (first frame right after startup, code-review fix)', () => {
  it('reads the query value (does not wait for the IPC round trip and does not fall to the default)', () => {
    window.history.pushState({}, '', '/?aios-thread-collapse=0')
    expect(initialCollapseDays()).toBe(0)
    window.history.pushState({}, '', '/?aios-thread-collapse=12')
    expect(initialCollapseDays()).toBe(12)
  })

  it('default (5 days) when the query is missing, broken, or out of range', () => {
    window.history.pushState({}, '', '/')
    expect(initialCollapseDays()).toBe(DEFAULT_COLLAPSE_OLD_AFTER_DAYS)
    window.history.pushState({}, '', '/?aios-thread-collapse=abc')
    expect(initialCollapseDays()).toBe(DEFAULT_COLLAPSE_OLD_AFTER_DAYS)
    window.history.pushState({}, '', '/?aios-thread-collapse=-5')
    expect(initialCollapseDays()).toBe(DEFAULT_COLLAPSE_OLD_AFTER_DAYS)
  })
})

describe('threadCollapseStore (renderer copy)', () => {
  function withFakeApi(setImpl: (days: number) => Promise<unknown>): void {
    ;(window as unknown as { aios: { threadCollapse: { set: typeof setImpl } } }).aios = {
      threadCollapse: { set: setImpl }
    }
  }

  // code-review fix (TODO 659): a value that main rejects (out of range or non-integer) must not affect the fold decision even for an instant before the round trip. Typing "-5" in the field and pressing Enter must not make the list flicker.
  it('does not reflect a value main rejects (out of range) even optimistically', async () => {
    useThreadCollapse.setState({ days: 5 })
    withFakeApi(async (days) => days) // Fake main: returns the value it received without checking (it should not be called).
    await useThreadCollapse.getState().update(-5)
    expect(useThreadCollapse.getState().days).toBe(5)
  })

  it("reflects a valid value optimistically and settles it with main's return value", async () => {
    useThreadCollapse.setState({ days: 5 })
    withFakeApi(async (days) => days)
    const pending = useThreadCollapse.getState().update(10)
    expect(useThreadCollapse.getState().days).toBe(10) // Applied optimistically, without waiting for the round trip.
    await pending
    expect(useThreadCollapse.getState().days).toBe(10)
  })

  it('aligns to the value when main checked and rejected (returned the current value)', async () => {
    useThreadCollapse.setState({ days: 5 })
    withFakeApi(async () => 5) // The real main's `set` returns the current value when it rejects.
    await useThreadCollapse.getState().update(-5)
    expect(useThreadCollapse.getState().days).toBe(5)
  })
})
