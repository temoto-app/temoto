/**
 * Multiple windows (ARCHITECTURE.md chapter 3 '1 profile + multiple windows', 12.6, TODO 26 / T21): the part that **does not depend on electron**.
 *
 * - `WindowSet`: the set of windows. Each listing drops dead windows (touching a `webContents` that is already destroyed would throw when pushing to it).
 * - choosing and checking bounds: saved values off-screen go back to the default, and a window does not overlap a position where a window already exists.
 * - reclaiming `SingletonLock`: only the locks that point to a dead pid are removed.
 *
 * The model is not called.
 */
import { describe, expect, it } from 'vitest'
import { lstatSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CASCADE_STEP,
  DEFAULT_WINDOW_SIZE,
  MAX_REMEMBERED_BOUNDS,
  MAX_RESTORED_WINDOWS,
  MIN_WINDOW_SIZE,
  SINGLETON_FILES,
  WindowSet,
  chooseBounds,
  closedBounds,
  isOnScreen,
  isWindowBounds,
  parseBoundsList,
  parseSingletonLock,
  planRestore,
  reclaimStaleSingletonLock,
  rememberBounds,
  snapshotSession,
  type DisplayArea,
  type WindowBounds
} from '../src/main/windows.js'
import { WINDOW_BOUNDS } from '../src/common/settings-keys.js'

/** Arrangement of one display (a 1512×982 work area). */
const ONE_DISPLAY: readonly DisplayArea[] = [{ x: 0, y: 38, width: 1512, height: 944 }]
/** Arrangement with one more display added on the right. */
const TWO_DISPLAYS: readonly DisplayArea[] = [
  ...ONE_DISPLAY,
  { x: 1512, y: 0, width: 1920, height: 1080 }
]

const OK: WindowBounds = { x: 20, y: 60, width: 1440, height: 900 }

describe('WindowSet', () => {
  it('enumerates in the order added, and dead windows drop out at enumeration', () => {
    const dead = new Set<string>()
    const set = new WindowSet<string>((id) => !dead.has(id))
    set.add('a')
    set.add('b')
    set.add('c')
    expect(set.list()).toEqual(['a', 'b', 'c'])
    expect(set.size).toBe(3)

    // Even if `closed` is missed, it does not remain at the push destination.
    dead.add('b')
    expect(set.list()).toEqual(['a', 'c'])
    expect(set.size).toBe(2)
    expect(set.has('b')).toBe(false)
    // What fell once is also gone from inside (it does not come back unless added again).
    dead.delete('b')
    expect(set.list()).toEqual(['a', 'c'])
  })

  it('adding the same window twice is still one, and delete and clear work', () => {
    const set = new WindowSet<string>(() => true)
    set.add('a')
    set.add('a')
    expect(set.size).toBe(1)
    set.delete('a')
    expect(set.size).toBe(0)
    set.add('a')
    set.clear()
    expect(set.list()).toEqual([])
  })
})

describe('validating bounds', () => {
  it('does not pass a value of the wrong shape', () => {
    expect(isWindowBounds(OK)).toBe(true)
    expect(isWindowBounds(null)).toBe(false)
    expect(isWindowBounds('x')).toBe(false)
    expect(isWindowBounds({ x: 0, y: 0, width: 100 })).toBe(false)
    expect(isWindowBounds({ x: 0, y: 0, width: 0, height: 100 })).toBe(false)
    expect(isWindowBounds({ x: Number.NaN, y: 0, width: 100, height: 100 })).toBe(false)
    expect(isWindowBounds({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 })).toBe(false)
  })

  it('a saved value discards broken elements and cuts at the limit', () => {
    expect(parseBoundsList(null)).toEqual([])
    expect(parseBoundsList('[]')).toEqual([])
    expect(parseBoundsList([OK, 'junk', { x: 1 }, { ...OK, x: 3.7 }])).toEqual([
      OK,
      { ...OK, x: 4 }
    ])
    const many = Array.from({ length: MAX_REMEMBERED_BOUNDS + 5 }, (_, i) => ({ ...OK, x: i * 40 }))
    expect(parseBoundsList(many)).toHaveLength(MAX_REMEMBERED_BOUNDS)
  })

  it('checks whether it fits on a screen', () => {
    expect(isOnScreen(OK, ONE_DISPLAY)).toBe(true)
    // Saved value after the screen was left.
    expect(isOnScreen({ ...OK, x: 2000 }, ONE_DISPLAY)).toBe(false)
    expect(isOnScreen({ ...OK, x: 2000 }, TWO_DISPLAYS)).toBe(true)
    // The top edge is above the menu bar = the title bar cannot be grabbed.
    expect(isOnScreen({ ...OK, y: -200 }, ONE_DISPLAY)).toBe(false)
    // More than half is off the screen.
    expect(isOnScreen({ ...OK, x: 1400 }, ONE_DISPLAY)).toBe(false)
    // A value below the minimum size.
    expect(isOnScreen({ ...OK, width: MIN_WINDOW_SIZE.width - 1 }, ONE_DISPLAY)).toBe(false)
    expect(isOnScreen({ ...OK, height: MIN_WINDOW_SIZE.height - 1 }, ONE_DISPLAY)).toBe(false)
    // When not a single display can be obtained (before acquisition), it falls back to the default.
    expect(isOnScreen(OK, [])).toBe(false)
  })
})

describe('where to open a window', () => {
  it('the first window appears at the position of the last closed window', () => {
    expect(chooseBounds({ saved: [OK], open: [], displays: ONE_DISPLAY })).toEqual(OK)
  })

  it('null (= centered at the default size) when there is no saved value or it is off screen', () => {
    expect(chooseBounds({ saved: [], open: [], displays: ONE_DISPLAY })).toBeNull()
    expect(
      chooseBounds({ saved: [{ ...OK, x: 9000 }], open: [], displays: ONE_DISPLAY })
    ).toBeNull()
  })

  it('avoids a position where a window already exists and uses the next saved value', () => {
    const second = { ...OK, x: 400, y: 200 }
    expect(chooseBounds({ saved: [OK, second], open: [OK], displays: ONE_DISPLAY })).toEqual(second)
  })

  it('when there is no free saved value, offsets from the last window', () => {
    const chosen = chooseBounds({ saved: [OK], open: [OK], displays: ONE_DISPLAY })
    expect(chosen).toEqual({ ...OK, x: OK.x + CASCADE_STEP, y: OK.y + CASCADE_STEP })
  })

  it('when offsetting would go off screen, returns to a saved value that fits', () => {
    const edge = { x: 60, y: 900, width: 1440, height: 900 }
    const chosen = chooseBounds({ saved: [OK], open: [edge], displays: ONE_DISPLAY })
    expect(chosen).toEqual(OK)
  })

  it('the default size is larger than the minimum size', () => {
    expect(DEFAULT_WINDOW_SIZE.width).toBeGreaterThan(MIN_WINDOW_SIZE.width)
    expect(DEFAULT_WINDOW_SIZE.height).toBeGreaterThan(MIN_WINDOW_SIZE.height)
  })
})

describe('remembering closed window positions', () => {
  it('the last closed window comes first', () => {
    const a = OK
    const b = { ...OK, x: 500, y: 300 }
    expect(rememberBounds(rememberBounds([], a), b)).toEqual([b, a])
  })

  it('folds old records at nearly the same position', () => {
    const a = OK
    const again = { ...OK, x: OK.x + 3, width: 1200 }
    expect(rememberBounds([a], again)).toEqual([again])
  })

  it('cuts at the limit', () => {
    let list: readonly WindowBounds[] = []
    for (let i = 0; i < MAX_REMEMBERED_BOUNDS + 4; i += 1) {
      list = rememberBounds(list, { ...OK, x: i * 100, y: i * 40 })
    }
    expect(list).toHaveLength(MAX_REMEMBERED_BOUNDS)
    expect(list[0]?.x).toBe((MAX_REMEMBERED_BOUNDS + 3) * 100)
  })

  it('a broken value does not break the list', () => {
    expect(rememberBounds([OK], { x: Number.NaN, y: 0, width: 100, height: 100 })).toEqual([OK])
  })
})

describe('restoring per-window state (item 36)', () => {
  const B = { ...OK, x: 500, y: 300 }
  const C = { ...OK, x: 60, y: 100, width: 1000 }

  describe('reading saved values', () => {
    it('the old format (an array of only bounds) is read as closed window positions, and there is no window to restore', () => {
      const saved = parseBoundsList([OK, B])
      expect(saved).toEqual([OK, B])
      expect(closedBounds(saved)).toEqual([OK, B])
      expect(planRestore({ saved, displays: ONE_DISPLAY, threadExists: () => true })).toEqual([])
    })

    it('reads restore and threadId; drops those where restore is not true or the threadId shape is wrong', () => {
      expect(
        parseBoundsList([
          { ...OK, restore: true, threadId: 't1' },
          { ...B, restore: true, threadId: 42 },
          { ...B, restore: true, threadId: '' },
          { ...C, restore: 'yes', threadId: 't3' },
          { ...C, restore: true, threadId: 'x'.repeat(201) },
          { ...OK, restore: true, x: Number.NaN }
        ])
      ).toEqual([
        { ...OK, restore: true, threadId: 't1' },
        { ...B, restore: true },
        { ...B, restore: true },
        // Without `restore` being true, the position of a closed window (no threadId).
        C,
        { ...C, restore: true }
      ])
    })

    it('maximized is kept only in restore elements and only when true (item 197)', () => {
      expect(
        parseBoundsList([
          { ...OK, restore: true, threadId: 't1', maximized: true },
          { ...B, restore: true, maximized: 'yes' },
          { ...C, maximized: true } // Without restore, the position of a closed window (no maximized).
        ])
      ).toEqual([
        { ...OK, restore: true, threadId: 't1', maximized: true },
        { ...B, restore: true },
        C
      ])
    })

    it('the limit is counted separately for closed windows and windows to restore', () => {
      const closed = Array.from({ length: MAX_REMEMBERED_BOUNDS + 3 }, (_, i) => ({
        ...OK,
        x: i * 40
      }))
      const restore = Array.from({ length: MAX_RESTORED_WINDOWS + 3 }, (_, i) => ({
        ...OK,
        y: 60 + i,
        restore: true
      }))
      const parsed = parseBoundsList([...restore, ...closed])
      expect(parsed.filter((s) => s.restore === true)).toHaveLength(MAX_RESTORED_WINDOWS)
      expect(closedBounds(parsed)).toHaveLength(MAX_REMEMBERED_BOUNDS)
    })

    it('the shape does not change through a settings-keys round trip (does not write default-valued fields in closed window elements)', () => {
      const value = [{ ...OK, restore: true as const, threadId: 't1' }, { ...B, restore: true as const }, C]
      const raw = WINDOW_BOUNDS.serialize(value)
      expect(WINDOW_BOUNDS.parse(raw)).toEqual(value)
      expect(JSON.parse(raw)[2]).toEqual(C)
      expect(Object.keys(JSON.parse(raw)[2] as object).sort()).toEqual(['height', 'width', 'x', 'y'])
    })
  })

  describe('restoring maximized (item 197)', () => {
    it('a window that was maximized is recorded with maximized: true, and no field is written for others', () => {
      const snapshot = snapshotSession(
        [],
        [
          { bounds: OK, threadId: 't1', focused: false, maximized: true },
          { bounds: B, threadId: 't2', focused: false, maximized: false }
        ]
      )
      const restore = snapshot.filter((s) => s.restore === true)
      expect(restore).toEqual([
        { ...OK, restore: true, threadId: 't1', maximized: true },
        { ...B, restore: true, threadId: 't2' }
      ])
      expect(Object.keys(restore[1] as object)).not.toContain('maximized')
    })

    it('planRestore passes maximized to the plan as is (even if bounds is null)', () => {
      const offscreen = { ...OK, x: 1600 }
      const saved = [
        { ...OK, restore: true as const, threadId: 't1', maximized: true as const },
        { ...offscreen, restore: true as const, threadId: 't2', maximized: true as const }
      ]
      expect(planRestore({ saved, displays: ONE_DISPLAY, threadExists: () => true })).toEqual([
        { bounds: OK, threadId: 't1', maximized: true },
        // Even if off the screen, maximized stays (maximized on the position left to `chooseBounds`).
        { bounds: null, threadId: 't2', maximized: true }
      ])
    })

    it('a quit → launch round trip restores maximized (re-reading the recorded value)', () => {
      const snapshot = snapshotSession(
        [],
        [{ bounds: OK, threadId: 't1', focused: true, maximized: true }]
      )
      const saved = WINDOW_BOUNDS.parse(WINDOW_BOUNDS.serialize(snapshot))
      expect(planRestore({ saved, displays: ONE_DISPLAY, threadExists: () => true })).toEqual([
        { bounds: OK, threadId: 't1', maximized: true }
      ])
    })
  })

  describe('record at quit (snapshotSession)', () => {
    it('records the open windows in the order opened and puts the front window last', () => {
      const snapshot = snapshotSession(
        [],
        [
          { bounds: OK, threadId: 't1', focused: true, maximized: false },
          { bounds: B, threadId: null, focused: false, maximized: false },
          { bounds: C, threadId: 't3', focused: false, maximized: false }
        ]
      )
      const restore = snapshot.filter((s) => s.restore === true)
      expect(restore).toEqual([
        { ...B, restore: true },
        { ...C, restore: true, threadId: 't3' },
        { ...OK, restore: true, threadId: 't1' }
      ])
      // The position also remains in the candidates for closed windows (for the next ⌘N, same as T21).
      expect(closedBounds(snapshot)).toHaveLength(3)
    })

    it('no restore record when there are 0 windows (the next launch is one window as before)', () => {
      const saved = [{ ...OK, restore: true as const, threadId: 'old' }, B]
      const snapshot = snapshotSession(saved, [])
      expect(snapshot.some((s) => s.restore === true)).toBe(false)
      expect(snapshot).toEqual([B])
      expect(planRestore({ saved: snapshot, displays: ONE_DISPLAY, threadExists: () => true })).toEqual(
        []
      )
    })

    it('leftovers of the previous record are not mixed into the restore record (only the windows open now)', () => {
      const saved = [{ ...C, restore: true as const, threadId: 'old' }, B]
      const snapshot = snapshotSession(saved, [{ bounds: OK, threadId: 't1', focused: false, maximized: false }])
      expect(snapshot.filter((s) => s.restore === true)).toEqual([
        { ...OK, restore: true, threadId: 't1' }
      ])
    })

    it('does not restore a window with broken bounds; beyond the limit, cuts while keeping the front window', () => {
      const broken = snapshotSession([], [
        { bounds: { x: Number.NaN, y: 0, width: 100, height: 100 }, threadId: 't', focused: false, maximized: false }
      ])
      expect(broken).toEqual([])

      const many = Array.from({ length: MAX_RESTORED_WINDOWS + 2 }, (_, i) => ({
        bounds: { ...OK, x: i * 30 },
        threadId: `t${i}`,
        focused: i === 0,
        maximized: false
      }))
      const restore = snapshotSession([], many).filter((s) => s.restore === true)
      expect(restore).toHaveLength(MAX_RESTORED_WINDOWS)
      expect(restore.at(-1)?.threadId).toBe('t0')
    })

    it('re-reading the recorded value gives the same plan (quit → launch round trip)', () => {
      const snapshot = snapshotSession(
        [],
        [
          { bounds: OK, threadId: 't1', focused: false, maximized: false },
          { bounds: B, threadId: 't2', focused: true, maximized: false }
        ]
      )
      const saved = WINDOW_BOUNDS.parse(WINDOW_BOUNDS.serialize(snapshot))
      expect(planRestore({ saved, displays: ONE_DISPLAY, threadExists: () => true })).toEqual([
        { bounds: OK, threadId: 't1', maximized: false },
        { bounds: B, threadId: 't2', maximized: false }
      ])
    })
  })

  describe('plan at launch (planRestore)', () => {
    it('does not open a thread that is gone (only restores the window)', () => {
      const saved = [
        { ...OK, restore: true as const, threadId: 'alive' },
        { ...B, restore: true as const, threadId: 'deleted' }
      ]
      expect(
        planRestore({ saved, displays: ONE_DISPLAY, threadExists: (id) => id === 'alive' })
      ).toEqual([
        { bounds: OK, threadId: 'alive', maximized: false },
        { bounds: B, threadId: null, maximized: false }
      ])
    })

    it('a window with no record selects nothing (item 80)', () => {
      const saved = [{ ...OK, restore: true as const }]
      const threadExists = (): boolean => {
        throw new Error('呼ばれてはいけない')
      }
      expect(planRestore({ saved, displays: ONE_DISPLAY, threadExists })).toEqual([
        { bounds: OK, threadId: null, maximized: false }
      ])
    })

    it('a position off screen is null (left to the default placement)', () => {
      const offscreen = { ...OK, x: 1600 }
      const saved = [{ ...offscreen, restore: true as const, threadId: 't1' }]
      expect(planRestore({ saved, displays: ONE_DISPLAY, threadExists: () => true })).toEqual([
        { bounds: null, threadId: 't1', maximized: false }
      ])
      // Re-attaching the display brings it back to the original position.
      expect(planRestore({ saved, displays: TWO_DISPLAYS, threadExists: () => true })).toEqual([
        { bounds: offscreen, threadId: 't1', maximized: false }
      ])
    })

    it('after use is exhausted (only closed window positions), the plan is empty', () => {
      const saved = [{ ...OK, restore: true as const, threadId: 't1' }, B]
      expect(closedBounds(saved)).toEqual([B])
      expect(
        planRestore({ saved: closedBounds(saved), displays: ONE_DISPLAY, threadExists: () => true })
      ).toEqual([])
    })
  })
})

describe('SingletonLock', () => {
  it('reads `<hostname>-<pid>` (even if the host name contains `-`)', () => {
    expect(parseSingletonLock('kzm-mbp-31415')).toEqual({ hostname: 'kzm-mbp', pid: 31415 })
    expect(parseSingletonLock('host-0')).toBeNull()
    expect(parseSingletonLock('host-')).toBeNull()
    expect(parseSingletonLock('-123')).toBeNull()
    expect(parseSingletonLock('nodash')).toBeNull()
    expect(parseSingletonLock('host-abc')).toBeNull()
  })

  const io = (overrides: {
    readlink?: (path: string) => string | null
    isAlive?: (pid: number) => boolean
    unlinked?: string[]
    host?: string
  }) => ({
    readlink: overrides.readlink ?? (() => null),
    unlink: (path: string) => overrides.unlinked?.push(path),
    isAlive: overrides.isAlive ?? (() => true),
    hostname: () => overrides.host ?? 'here'
  })

  const paths = SINGLETON_FILES.map((name) => join('/ud', name))

  it('does nothing when there is no lock', () => {
    expect(reclaimStaleSingletonLock(paths, io({}))).toBe('no-lock')
  })

  it('does not remove a lock of a live pid (a real second instance)', () => {
    const unlinked: string[] = []
    const verdict = reclaimStaleSingletonLock(
      paths,
      io({ readlink: () => 'here-4242', isAlive: () => true, unlinked })
    )
    expect(verdict).toBe('alive')
    expect(unlinked).toEqual([])
  })

  it('does not touch a lock of another host', () => {
    const unlinked: string[] = []
    const verdict = reclaimStaleSingletonLock(
      paths,
      io({ readlink: () => 'elsewhere-4242', isAlive: () => false, unlinked })
    )
    expect(verdict).toBe('other-host')
    expect(unlinked).toEqual([])
  })

  it('does not touch an unreadable shape', () => {
    const unlinked: string[] = []
    const verdict = reclaimStaleSingletonLock(paths, io({ readlink: () => 'garbage', unlinked }))
    expect(verdict).toBe('unparsable')
    expect(unlinked).toEqual([])
  })

  it('removes the three files together for a dead pid lock', () => {
    const unlinked: string[] = []
    const verdict = reclaimStaleSingletonLock(
      paths,
      io({ readlink: () => 'here-4242', isAlive: () => false, unlinked })
    )
    expect(verdict).toBe('reclaimed')
    expect(unlinked).toEqual(paths)
  })

  /** Whether the symlink itself exists (`existsSync` follows it). */
  const present = (path: string): boolean => {
    try {
      lstatSync(path)
      return true
    } catch {
      return false
    }
  }

  it('passes with a real symlink and a real pid check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aios-singleton-'))
    try {
      const files = SINGLETON_FILES.map((name) => join(dir, name))
      const realIo = {
        readlink: (path: string) => {
          try {
            return readlinkSync(path)
          } catch {
            return null
          }
        },
        unlink: (path: string) => rmSync(path, { force: true }),
        isAlive: (pid: number) => {
          try {
            process.kill(pid, 0)
            return true
          } catch (err) {
            return (err as NodeJS.ErrnoException).code === 'EPERM'
          }
        },
        hostname: () => hostname()
      }

      // Own pid = alive.
      symlinkSync(`${hostname()}-${process.pid}`, files[0] as string)
      writeFileSync(files[1] as string, '')
      writeFileSync(files[2] as string, '')
      expect(reclaimStaleSingletonLock(files, realIo)).toBe('alive')
      // `existsSync` follows symlinks, so it cannot be used (`<hostname>-<pid>` does not exist).
      expect(present(files[0] as string)).toBe(true)

      // Re-point it at a pid that does not exist.
      rmSync(files[0] as string, { force: true })
      symlinkSync(`${hostname()}-2147483646`, files[0] as string)
      expect(reclaimStaleSingletonLock(files, realIo)).toBe('reclaimed')
      for (const file of files) expect(present(file)).toBe(false)
      expect(reclaimStaleSingletonLock(files, realIo)).toBe('no-lock')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
