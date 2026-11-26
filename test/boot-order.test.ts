/**
 * The launch order "window first, key later" (TODO 807, ARCHITECTURE 3.1 "launch order"): the gate the renderers wait on, the plan
 * that adopts the window opened before the DB, and the hint that places it. Electron-independent parts only; no model is called.
 */
import { describe, expect, it } from 'vitest'
import { BootGate, opensWindowBeforeKey, type BootTimers } from '../src/main/boot-gate.js'
import {
  DEFAULT_BOOT_HINT,
  bootHintFromRecord,
  parseBootHint,
  serializeBootHint
} from '../src/main/boot-hint.js'
import {
  chooseBounds,
  closedBounds,
  earlyWindowTarget,
  planLaunchWindows,
  planRestore,
  snapshotSession,
  type RestoreEntry
} from '../src/main/windows.js'

interface Look {
  readonly theme: string
}

function manualTimers(): BootTimers & { fire(): void; pending(): number } {
  const queue = new Map<number, () => void>()
  let next = 1
  return {
    setTimeout: (callback) => {
      const id = next++
      queue.set(id, callback)
      return id
    },
    clearTimeout: (handle) => {
      queue.delete(handle as number)
    },
    fire: () => {
      for (const [id, callback] of [...queue]) {
        queue.delete(id)
        callback()
      }
    },
    pending: () => queue.size
  }
}

describe('BootGate (TODO 807)', () => {
  it('holds a renderer that asks while the key is awaited, and answers it with the look once ready', async () => {
    const gate = new BootGate<Look>()
    let answered: unknown = null
    const waiting = gate.wait().then((answer) => {
      answered = answer
    })
    await Promise.resolve()
    expect(answered).toBeNull()
    expect(gate.phase).toBe('starting')
    gate.markReady(() => ({ theme: 'dark' }))
    await waiting
    expect(answered).toEqual({ ready: true, look: { theme: 'dark' } })
    expect(gate.isReady()).toBe(true)
  })

  it('answers a window opened after the launch at once, with the look of that moment', async () => {
    const gate = new BootGate<Look>()
    let theme = 'light'
    gate.markReady(() => ({ theme }))
    theme = 'dark'
    await expect(gate.wait()).resolves.toEqual({ ready: true, look: { theme: 'dark' } })
  })

  it('a quit while waiting answers not-ready (nothing is loaded), and a later ready does nothing', async () => {
    const gate = new BootGate<Look>()
    const waiting = gate.wait()
    gate.abort()
    await expect(waiting).resolves.toEqual({ ready: false })
    gate.markReady(() => ({ theme: 'dark' }))
    expect(gate.phase).toBe('aborted')
    expect(gate.isReady()).toBe(false)
    await expect(gate.wait()).resolves.toEqual({ ready: false })
  })

  it('an abort after ready changes nothing (a normal quit)', async () => {
    const gate = new BootGate<Look>()
    gate.markReady(() => ({ theme: 'light' }))
    gate.abort()
    expect(gate.isReady()).toBe(true)
    await expect(gate.wait()).resolves.toEqual({ ready: true, look: { theme: 'light' } })
  })

  it('waits for the first paint, and stops waiting at the limit when no window reports', async () => {
    const painted = new BootGate<Look>()
    const timers = manualTimers()
    const first = painted.waitForPaint(3000, timers)
    painted.notePainted()
    await expect(first).resolves.toBe('painted')
    expect(timers.pending()).toBe(0)
    // Already painted: no wait at all.
    await expect(painted.waitForPaint(3000, timers)).resolves.toBe('painted')

    const silent = new BootGate<Look>()
    const late = silent.waitForPaint(3000, timers)
    timers.fire()
    await expect(late).resolves.toBe('timeout')
    // A paint after the limit does not resolve it twice.
    silent.notePainted()
  })

  it('an abort releases the wait for the first paint (a quit before the window painted)', async () => {
    const gate = new BootGate<Look>()
    const timers = manualTimers()
    const waiting = gate.waitForPaint(3000, timers)
    gate.abort()
    await expect(waiting).resolves.toBe('painted')
  })

  it('every launch opens its window first except the idle restart of an update', () => {
    expect(opensWindowBeforeKey({ updateRelaunch: false })).toBe(true)
    expect(opensWindowBeforeKey({ updateRelaunch: true })).toBe(false)
  })
})

describe('planLaunchWindows (TODO 807)', () => {
  const entry = (x: number, threadId: string | null = null): RestoreEntry => ({
    bounds: { x, y: 40, width: 1200, height: 800 },
    threadId,
    maximized: false
  })

  it('the window opened before the DB takes the first entry, so the restored set has exactly as many windows as the record', () => {
    const plan = [entry(10, 'a'), entry(40, 'b'), entry(70)]
    const launch = planLaunchWindows({ plan, hasEarlyWindow: true, updateRelaunch: false })
    expect(launch.early).toEqual({ kind: 'adopt', entry: plan[0] })
    expect(launch.open).toEqual([plan[1], plan[2]])
    expect(launch.openPlain).toBe(false)
    // One early window + the opened ones = the record (no duplicate).
    expect(1 + launch.open.length).toBe(plan.length)
  })

  it('with nothing to restore the early window is kept as the one window (no second plain window)', () => {
    const launch = planLaunchWindows({ plan: [], hasEarlyWindow: true, updateRelaunch: false })
    expect(launch).toEqual({ early: { kind: 'keep' }, open: [], openPlain: false })
  })

  it('without an early window it opens as before: the whole plan, or one plain window', () => {
    const plan = [entry(10), entry(40)]
    expect(planLaunchWindows({ plan, hasEarlyWindow: false, updateRelaunch: false })).toEqual({ early: null, open: plan, openPlain: false })
    expect(planLaunchWindows({ plan: [], hasEarlyWindow: false, updateRelaunch: false })).toEqual({ early: null, open: [], openPlain: true })
  })

  it('the idle restart of an update whose previous run had no window stays windowless (TODO 103)', () => {
    expect(planLaunchWindows({ plan: [], hasEarlyWindow: false, updateRelaunch: true })).toEqual({ early: null, open: [], openPlain: false })
    // With windows in the record it restores them as before.
    const plan = [entry(10)]
    expect(planLaunchWindows({ plan, hasEarlyWindow: false, updateRelaunch: true }).open).toEqual(plan)
  })
})

describe('boot hint (TODO 807)', () => {
  const displays = [{ x: 0, y: 0, width: 2560, height: 1440 }]

  it('names the window the next launch adopts first: the first restored one, with its maximized flag', () => {
    const record = snapshotSession(
      [],
      [
        { bounds: { x: 100, y: 80, width: 1300, height: 850 }, threadId: 't1', focused: false, maximized: true },
        { bounds: { x: 300, y: 120, width: 1000, height: 700 }, threadId: null, focused: true, maximized: false }
      ]
    )
    const hint = bootHintFromRecord(record, 'dark', 'ja')
    const plan = planRestore({ saved: record, displays, threadExists: () => true })
    expect(hint.bounds).toEqual(plan[0]?.bounds)
    expect(hint.maximized).toBe(plan[0]?.maximized)
    expect(hint).toMatchObject({ theme: 'dark', locale: 'ja' })
    // No thread id in the file.
    expect(serializeBootHint(hint)).not.toContain('t1')
  })

  it('with no window at quit it names the last closed position (where the next window opens)', () => {
    const record = snapshotSession([{ x: 5, y: 6, width: 900, height: 600 }], [])
    expect(bootHintFromRecord(record, 'system', 'system')).toEqual({
      bounds: { x: 5, y: 6, width: 900, height: 600 },
      maximized: false,
      theme: 'system',
      locale: 'system'
    })
    expect(bootHintFromRecord([], 'light', 'en').bounds).toBeNull()
  })

  it('round-trips, and anything broken falls back to the system look, centred', () => {
    const hint = { bounds: { x: 1, y: 2, width: 1000, height: 700 }, maximized: true, theme: 'light' as const, locale: 'en' as const }
    expect(parseBootHint(serializeBootHint(hint))).toEqual(hint)
    expect(parseBootHint(null)).toEqual(DEFAULT_BOOT_HINT)
    expect(parseBootHint('{')).toEqual(DEFAULT_BOOT_HINT)
    expect(parseBootHint('[]')).toEqual(DEFAULT_BOOT_HINT)
    expect(parseBootHint(JSON.stringify({ v: 2, ...hint }))).toEqual(DEFAULT_BOOT_HINT)
    expect(parseBootHint(JSON.stringify({ v: 1, bounds: { x: 'a' }, maximized: 'yes', theme: 'neon', locale: 'fr' }))).toEqual(DEFAULT_BOOT_HINT)
  })
})

describe('wave 106 review Z4: a launch with nothing to restore opens a plain window, also after a crash', () => {
  const displays = [{ x: 0, y: 0, width: 2560, height: 1440 }]
  /** Quit with one maximized window, then a launch that uses the record up (the crash comes after this, so no quit writes a new hint). */
  function usedUpAfterMaximizedQuit() {
    const record = snapshotSession(
      [{ x: 5, y: 6, width: 900, height: 600 }],
      [{ bounds: { x: 100, y: 80, width: 1300, height: 850 }, threadId: 't1', focused: true, maximized: true }]
    )
    const quitHint = bootHintFromRecord(record, 'dark', 'ja')
    expect(quitHint.maximized).toBe(true)
    // `restoreWindows` writes the record back used up and, with it, the hint for that record.
    const usedUp = closedBounds(record)
    return { quitHint, usedUp, afterRestoreHint: bootHintFromRecord(usedUp, 'dark', 'ja') }
  }

  it('the hint rewritten when the record is used up is not maximized, so the next launch opens no maximized window', () => {
    const { usedUp, afterRestoreHint } = usedUpAfterMaximizedQuit()
    expect(planRestore({ saved: usedUp, displays, threadExists: () => true })).toEqual([])
    expect(afterRestoreHint.maximized).toBe(false)
    // It names where the plain window goes, so the window opened before the DB does not move.
    const chosen = chooseBounds({ saved: usedUp, open: [], displays })
    expect(afterRestoreHint.bounds).toEqual(chosen)
    expect(earlyWindowTarget(null, chosen)).toEqual({ bounds: chosen, maximized: false })
    expect(afterRestoreHint).toMatchObject({ theme: 'dark', locale: 'ja' })
  })

  it('with a stale maximized hint (it could not be rewritten), the early window still ends up plain where chooseBounds puts it', () => {
    const { quitHint, usedUp } = usedUpAfterMaximizedQuit()
    const chosen = chooseBounds({ saved: usedUp, open: [], displays })
    // The early window was opened maximized from `quitHint`; with nothing to restore the target is a plain window, not the window's own state.
    expect(quitHint.maximized).toBe(true)
    expect(earlyWindowTarget(null, chosen)).toEqual({ bounds: chosen, maximized: false })
  })

  it('an adopted entry keeps its own place and maximized flag', () => {
    const entry: RestoreEntry = { bounds: { x: 1, y: 2, width: 1000, height: 700 }, threadId: 't', maximized: true }
    expect(earlyWindowTarget(entry, null)).toEqual({ bounds: entry.bounds, maximized: true })
    expect(earlyWindowTarget({ ...entry, bounds: null, maximized: false }, null)).toEqual({ bounds: null, maximized: false })
  })
})
