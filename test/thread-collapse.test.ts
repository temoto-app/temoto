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
  it('整数かつ範囲内だけ真', () => {
    expect(isCollapseOldAfterDays(5)).toBe(true)
    expect(isCollapseOldAfterDays(0)).toBe(true)
    expect(isCollapseOldAfterDays(MAX_COLLAPSE_OLD_AFTER_DAYS)).toBe(true)
    expect(isCollapseOldAfterDays(-1)).toBe(false)
    expect(isCollapseOldAfterDays(1.5)).toBe(false)
    expect(isCollapseOldAfterDays(MAX_COLLAPSE_OLD_AFTER_DAYS + 1)).toBe(false)
    expect(isCollapseOldAfterDays('5')).toBe(false)
    expect(isCollapseOldAfterDays(Number.NaN)).toBe(false)
  })

  it('範囲の外は端に寄せ、整数に丸める。数でなければ null', () => {
    expect(clampCollapseOldAfterDays(5)).toBe(5)
    expect(clampCollapseOldAfterDays(5.4)).toBe(5)
    expect(clampCollapseOldAfterDays(-3)).toBe(MIN_COLLAPSE_OLD_AFTER_DAYS)
    expect(clampCollapseOldAfterDays(MAX_COLLAPSE_OLD_AFTER_DAYS + 100)).toBe(MAX_COLLAPSE_OLD_AFTER_DAYS)
    expect(clampCollapseOldAfterDays('5')).toBeNull()
    expect(clampCollapseOldAfterDays(Number.NaN)).toBeNull()
    expect(clampCollapseOldAfterDays(null)).toBeNull()
  })
})

describe('THREADS_COLLAPSE_OLD_AFTER_DAYS (app_settings の鍵)', () => {
  it('既定は 5 日。壊れた値・欠けた値は既定に倒れる', () => {
    expect(THREADS_COLLAPSE_OLD_AFTER_DAYS.parse(null)).toBe(DEFAULT_COLLAPSE_OLD_AFTER_DAYS)
    expect(THREADS_COLLAPSE_OLD_AFTER_DAYS.parse('abc')).toBe(DEFAULT_COLLAPSE_OLD_AFTER_DAYS)
    expect(THREADS_COLLAPSE_OLD_AFTER_DAYS.parse('10')).toBe(10)
    expect(THREADS_COLLAPSE_OLD_AFTER_DAYS.parse('0')).toBe(0)
  })

  it('parse(serialize(x)) が往復する', () => {
    expect(THREADS_COLLAPSE_OLD_AFTER_DAYS.parse(THREADS_COLLAPSE_OLD_AFTER_DAYS.serialize(7))).toBe(7)
  })

  it('owner は main', () => {
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

  it('既定 5 日。変わった値だけ書いて知らせる。同じ値なら何もしない', () => {
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

  it('壊れた値は無視して今の値を返す。知らせない', () => {
    const settings = fakeStore()
    const changed = vi.fn()
    const preference = new ThreadCollapsePreference(settings, changed)
    expect(preference.set('nope')).toBe(5)
    expect(preference.set(Number.NaN)).toBe(5)
    expect(changed).not.toHaveBeenCalled()
  })

  // code-review fix (TODO 659): out-of-range or non-integer values are rejected, not rounded (typing "-5" in the field does not turn into 0).
  it('範囲の外・非整数は保存せず今の値を返す', () => {
    const settings = fakeStore()
    const changed = vi.fn()
    const preference = new ThreadCollapsePreference(settings, changed)
    expect(preference.set(-5)).toBe(5)
    expect(preference.set(MAX_COLLAPSE_OLD_AFTER_DAYS + 1)).toBe(5)
    expect(preference.set(2.5)).toBe(5)
    expect(changed).not.toHaveBeenCalled()
  })
})

describe('initialCollapseDays (起動直後の 1 フレーム、code-review の直し)', () => {
  it('クエリの値を読む (IPC の往復を待たず、既定に落ちない)', () => {
    window.history.pushState({}, '', '/?aios-thread-collapse=0')
    expect(initialCollapseDays()).toBe(0)
    window.history.pushState({}, '', '/?aios-thread-collapse=12')
    expect(initialCollapseDays()).toBe(12)
  })

  it('クエリが無い・壊れている・範囲外なら既定 (5 日)', () => {
    window.history.pushState({}, '', '/')
    expect(initialCollapseDays()).toBe(DEFAULT_COLLAPSE_OLD_AFTER_DAYS)
    window.history.pushState({}, '', '/?aios-thread-collapse=abc')
    expect(initialCollapseDays()).toBe(DEFAULT_COLLAPSE_OLD_AFTER_DAYS)
    window.history.pushState({}, '', '/?aios-thread-collapse=-5')
    expect(initialCollapseDays()).toBe(DEFAULT_COLLAPSE_OLD_AFTER_DAYS)
  })
})

describe('threadCollapseStore (renderer の写し)', () => {
  function withFakeApi(setImpl: (days: number) => Promise<unknown>): void {
    ;(window as unknown as { aios: { threadCollapse: { set: typeof setImpl } } }).aios = {
      threadCollapse: { set: setImpl }
    }
  }

  // code-review fix (TODO 659): a value that main rejects (out of range or non-integer) must not affect the fold decision even for an instant before the round trip. Typing "-5" in the field and pressing Enter must not make the list flicker.
  it('main が拒む値 (範囲外) は楽観的にも反映しない', async () => {
    useThreadCollapse.setState({ days: 5 })
    withFakeApi(async (days) => days) // Fake main: returns the value it received without checking (it should not be called).
    await useThreadCollapse.getState().update(-5)
    expect(useThreadCollapse.getState().days).toBe(5)
  })

  it('有効な値は楽観的に反映し、main の返り値で確定する', async () => {
    useThreadCollapse.setState({ days: 5 })
    withFakeApi(async (days) => days)
    const pending = useThreadCollapse.getState().update(10)
    expect(useThreadCollapse.getState().days).toBe(10) // Applied optimistically, without waiting for the round trip.
    await pending
    expect(useThreadCollapse.getState().days).toBe(10)
  })

  it('main が検めて拒んだ (今の値を返した) ときはその値に揃う', async () => {
    useThreadCollapse.setState({ days: 5 })
    withFakeApi(async () => 5) // The real main's `set` returns the current value when it rejects.
    await useThreadCollapse.getState().update(-5)
    expect(useThreadCollapse.getState().days).toBe(5)
  })
})
