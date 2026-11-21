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
  it('追加した順に列挙し、死んだ窓は列挙のときに落ちる', () => {
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

  it('同じ窓を二度足しても 1 つ、delete と clear が効く', () => {
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

describe('bounds の検証', () => {
  it('形が違う値は通さない', () => {
    expect(isWindowBounds(OK)).toBe(true)
    expect(isWindowBounds(null)).toBe(false)
    expect(isWindowBounds('x')).toBe(false)
    expect(isWindowBounds({ x: 0, y: 0, width: 100 })).toBe(false)
    expect(isWindowBounds({ x: 0, y: 0, width: 0, height: 100 })).toBe(false)
    expect(isWindowBounds({ x: Number.NaN, y: 0, width: 100, height: 100 })).toBe(false)
    expect(isWindowBounds({ x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 })).toBe(false)
  })

  it('保存値は壊れた要素を捨て、上限で切る', () => {
    expect(parseBoundsList(null)).toEqual([])
    expect(parseBoundsList('[]')).toEqual([])
    expect(parseBoundsList([OK, 'junk', { x: 1 }, { ...OK, x: 3.7 }])).toEqual([
      OK,
      { ...OK, x: 4 }
    ])
    const many = Array.from({ length: MAX_REMEMBERED_BOUNDS + 5 }, (_, i) => ({ ...OK, x: i * 40 }))
    expect(parseBoundsList(many)).toHaveLength(MAX_REMEMBERED_BOUNDS)
  })

  it('画面に載っているかを見る', () => {
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

describe('窓を開く位置', () => {
  it('1 枚目は最後に閉じた窓の位置に出る', () => {
    expect(chooseBounds({ saved: [OK], open: [], displays: ONE_DISPLAY })).toEqual(OK)
  })

  it('保存値が無い / 画面外なら null (= 既定の大きさで中央)', () => {
    expect(chooseBounds({ saved: [], open: [], displays: ONE_DISPLAY })).toBeNull()
    expect(
      chooseBounds({ saved: [{ ...OK, x: 9000 }], open: [], displays: ONE_DISPLAY })
    ).toBeNull()
  })

  it('既に窓がある位置は避け、次の保存値を使う', () => {
    const second = { ...OK, x: 400, y: 200 }
    expect(chooseBounds({ saved: [OK, second], open: [OK], displays: ONE_DISPLAY })).toEqual(second)
  })

  it('空いている保存値が無ければ最後の窓からずらす', () => {
    const chosen = chooseBounds({ saved: [OK], open: [OK], displays: ONE_DISPLAY })
    expect(chosen).toEqual({ ...OK, x: OK.x + CASCADE_STEP, y: OK.y + CASCADE_STEP })
  })

  it('ずらすと画面から出るときは載っている保存値へ戻る', () => {
    const edge = { x: 60, y: 900, width: 1440, height: 900 }
    const chosen = chooseBounds({ saved: [OK], open: [edge], displays: ONE_DISPLAY })
    expect(chosen).toEqual(OK)
  })

  it('既定の大きさは最小サイズより大きい', () => {
    expect(DEFAULT_WINDOW_SIZE.width).toBeGreaterThan(MIN_WINDOW_SIZE.width)
    expect(DEFAULT_WINDOW_SIZE.height).toBeGreaterThan(MIN_WINDOW_SIZE.height)
  })
})

describe('閉じた窓の位置を覚える', () => {
  it('最後に閉じた窓が先頭に来る', () => {
    const a = OK
    const b = { ...OK, x: 500, y: 300 }
    expect(rememberBounds(rememberBounds([], a), b)).toEqual([b, a])
  })

  it('ほぼ同じ位置の古い記録は畳む', () => {
    const a = OK
    const again = { ...OK, x: OK.x + 3, width: 1200 }
    expect(rememberBounds([a], again)).toEqual([again])
  })

  it('上限で切る', () => {
    let list: readonly WindowBounds[] = []
    for (let i = 0; i < MAX_REMEMBERED_BOUNDS + 4; i += 1) {
      list = rememberBounds(list, { ...OK, x: i * 100, y: i * 40 })
    }
    expect(list).toHaveLength(MAX_REMEMBERED_BOUNDS)
    expect(list[0]?.x).toBe((MAX_REMEMBERED_BOUNDS + 3) * 100)
  })

  it('壊れた値では一覧を壊さない', () => {
    expect(rememberBounds([OK], { x: Number.NaN, y: 0, width: 100, height: 100 })).toEqual([OK])
  })
})

describe('窓ごとの状態の復元 (項目 36)', () => {
  const B = { ...OK, x: 500, y: 300 }
  const C = { ...OK, x: 60, y: 100, width: 1000 }

  describe('保存値の読み取り', () => {
    it('旧形式 (bounds だけの配列) は閉じた窓の位置として読め、戻す窓は無い', () => {
      const saved = parseBoundsList([OK, B])
      expect(saved).toEqual([OK, B])
      expect(closedBounds(saved)).toEqual([OK, B])
      expect(planRestore({ saved, displays: ONE_DISPLAY, threadExists: () => true })).toEqual([])
    })

    it('restore と threadId を読む。restore が true 以外・threadId の形が違うものは落とす', () => {
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

    it('maximized は restore の要素でだけ、true のときだけ残す (項目 197)', () => {
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

    it('上限は閉じた窓と戻す窓で別々に数える', () => {
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

    it('settings-keys の往復で形が変わらない (閉じた窓の要素に既定値の欄を書かない)', () => {
      const value = [{ ...OK, restore: true as const, threadId: 't1' }, { ...B, restore: true as const }, C]
      const raw = WINDOW_BOUNDS.serialize(value)
      expect(WINDOW_BOUNDS.parse(raw)).toEqual(value)
      expect(JSON.parse(raw)[2]).toEqual(C)
      expect(Object.keys(JSON.parse(raw)[2] as object).sort()).toEqual(['height', 'width', 'x', 'y'])
    })
  })

  describe('最大化の復元 (項目 197)', () => {
    it('最大化されていた窓は maximized: true で記録し、そうでない窓には欄を書かない', () => {
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

    it('planRestore は maximized をそのまま計画へ渡す (bounds が null でも)', () => {
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

    it('終了 → 起動の往復で最大化が復元される (記録した値を読み直す)', () => {
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

  describe('終了時の記録 (snapshotSession)', () => {
    it('開いていた窓を開いた順に戻す記録にし、前面だった窓を最後に回す', () => {
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

    it('窓が 0 枚なら戻す記録は無い (次の起動は今までどおり 1 枚)', () => {
      const saved = [{ ...OK, restore: true as const, threadId: 'old' }, B]
      const snapshot = snapshotSession(saved, [])
      expect(snapshot.some((s) => s.restore === true)).toBe(false)
      expect(snapshot).toEqual([B])
      expect(planRestore({ saved: snapshot, displays: ONE_DISPLAY, threadExists: () => true })).toEqual(
        []
      )
    })

    it('前回の記録の残りは戻す記録に混ぜない (いま開いている窓だけ)', () => {
      const saved = [{ ...C, restore: true as const, threadId: 'old' }, B]
      const snapshot = snapshotSession(saved, [{ bounds: OK, threadId: 't1', focused: false, maximized: false }])
      expect(snapshot.filter((s) => s.restore === true)).toEqual([
        { ...OK, restore: true, threadId: 't1' }
      ])
    })

    it('壊れた bounds の窓は戻さない。上限を超えた分は前面の窓を残して切る', () => {
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

    it('記録した値を読み直すと同じ計画になる (終了 → 起動の往復)', () => {
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

  describe('起動時の計画 (planRestore)', () => {
    it('消えたスレッドは開かない (窓だけ戻す)', () => {
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

    it('記録の無い窓は何も選ばない (項目 80)', () => {
      const saved = [{ ...OK, restore: true as const }]
      const threadExists = (): boolean => {
        throw new Error('呼ばれてはいけない')
      }
      expect(planRestore({ saved, displays: ONE_DISPLAY, threadExists })).toEqual([
        { bounds: OK, threadId: null, maximized: false }
      ])
    })

    it('画面から外れた位置は null (既定の置き方に任せる)', () => {
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

    it('使い切った後 (閉じた窓の位置だけ) は計画が空になる', () => {
      const saved = [{ ...OK, restore: true as const, threadId: 't1' }, B]
      expect(closedBounds(saved)).toEqual([B])
      expect(
        planRestore({ saved: closedBounds(saved), displays: ONE_DISPLAY, threadExists: () => true })
      ).toEqual([])
    })
  })
})

describe('SingletonLock', () => {
  it('`<hostname>-<pid>` を読む (ホスト名に `-` が入っていても)', () => {
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

  it('ロックが無ければ何もしない', () => {
    expect(reclaimStaleSingletonLock(paths, io({}))).toBe('no-lock')
  })

  it('生きている pid のロックは消さない (本物の 2 つ目)', () => {
    const unlinked: string[] = []
    const verdict = reclaimStaleSingletonLock(
      paths,
      io({ readlink: () => 'here-4242', isAlive: () => true, unlinked })
    )
    expect(verdict).toBe('alive')
    expect(unlinked).toEqual([])
  })

  it('別ホストのロックは触らない', () => {
    const unlinked: string[] = []
    const verdict = reclaimStaleSingletonLock(
      paths,
      io({ readlink: () => 'elsewhere-4242', isAlive: () => false, unlinked })
    )
    expect(verdict).toBe('other-host')
    expect(unlinked).toEqual([])
  })

  it('読めない形は触らない', () => {
    const unlinked: string[] = []
    const verdict = reclaimStaleSingletonLock(paths, io({ readlink: () => 'garbage', unlinked }))
    expect(verdict).toBe('unparsable')
    expect(unlinked).toEqual([])
  })

  it('死んだ pid のロックは 3 ファイルまとめて消す', () => {
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

  it('実物の symlink と実物の pid 判定で通る', () => {
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
