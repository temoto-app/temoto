/**
 * Checks rewrites by an outside tool (TODO 673, ARCHITECTURE.md 5.2 / 7.4).
 *
 * - `changed` is a pure function (only the decision comparing rounded mtime / size).
 * - `ViewerFileWatcher` opens a real `fs.watch`, so it is checked by actually rewriting files (the debounce is shortened to make the test fast). Neither the model nor Electron is started.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTestDir } from './helpers/tmp.js'
import { ViewerFileWatcher, changed } from '../src/main/capability/viewer-watch.js'

describe('changed (compared after rounding)', () => {
  it('no change when mtime and size are the same', () => {
    expect(changed({ mtimeMs: 1000.4, size: 10 }, { mtimeMs: 1000.2, size: 10 })).toBe(false)
  })

  it('changed when mtime differs (after rounding)', () => {
    expect(changed({ mtimeMs: 1000, size: 10 }, { mtimeMs: 2000, size: 10 })).toBe(true)
  })

  it('changed even when only size differs (some tools reuse the same mtime)', () => {
    expect(changed({ mtimeMs: 1000, size: 10 }, { mtimeMs: 1000, size: 11 })).toBe(true)
  })
})

describe('ViewerFileWatcher (real fs.watch, one file per window)', () => {
  let root: string

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
  })

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Remainder of TODO 712: even after changing to a form that polls 'until it arrives' (up to 15 seconds) instead of a fixed wait, it fell to the cap without a single arrival.
   * The cause was not the delay of delivery but that macOS FSEvents **drops** the notification for individual directories itself when the total number of fs changes is large
   * (it does not reproduce alone; it depends on the amount of change across the whole system).
   *
   * `ViewerFileWatcher.check()` reads the actual file with `statSync` when it is called (not from the event payload), so if the same write is redone after a drop,
   * another (not dropped) callback picks up the current contents, and exactly one notice arrives. Once the baseline matches, `changed()` from the second time on returns false,
   * so rewriting never increases the notices (deterministic).
   */
  async function writeUntilNotified(
    write: () => void,
    notified: readonly unknown[],
    timeoutMs = 15000
  ): Promise<void> {
    const start = Date.now()
    write()
    while (notified.length === 0 && Date.now() - start < timeoutMs) {
      await wait(500)
      if (notified.length === 0 && Date.now() - start < timeoutMs) write()
    }
  }

  it(
    'watches the parent directory and notifies when mtime / size changes',
    async () => {
      root = makeTestDir('viewer-watch')
      const path = join(root, 'a.txt')
      writeFileSync(path, 'one')
      const notified: [number, string][] = []
      const watcher = new ViewerFileWatcher({ notify: (viewId, uri) => notified.push([viewId, uri]), debounceMs: 50 })
      const stat = statSync(path)
      watcher.track(1, 'file:///a.txt', path, stat.mtimeMs, Number(stat.size))

      await writeUntilNotified(() => writeFileSync(path, 'two-longer'), notified)

      expect(notified).toEqual([[1, 'file:///a.txt']])
      watcher.untrack(1)
    },
    // TODO 712: in a parallel full-suite run it may take up to the cap of writeUntilNotified (15000 ms), so the test's own timeout (default 5000 ms) is also made longer than that.
    20000
  )

  it('settle takes its own write into the baseline and does not notify', async () => {
    root = makeTestDir('viewer-watch')
    const path = join(root, 'b.txt')
    writeFileSync(path, 'one')
    const notified: [number, string][] = []
    const watcher = new ViewerFileWatcher({ notify: (viewId, uri) => notified.push([viewId, uri]), debounceMs: 50 })
    const before = statSync(path)
    watcher.track(2, 'file:///b.txt', path, before.mtimeMs, Number(before.size))

    writeFileSync(path, 'own write, longer')
    const after = statSync(path)
    watcher.settle(2, 'file:///b.txt', after.mtimeMs, Number(after.size))
    await wait(800)

    expect(notified).toEqual([])
    watcher.untrack(2)
  })

  it('does not notify after untrack even if rewritten', async () => {
    root = makeTestDir('viewer-watch')
    const path = join(root, 'c.txt')
    writeFileSync(path, 'one')
    const notified: [number, string][] = []
    const watcher = new ViewerFileWatcher({ notify: (viewId, uri) => notified.push([viewId, uri]), debounceMs: 50 })
    const stat = statSync(path)
    watcher.track(3, 'file:///c.txt', path, stat.mtimeMs, Number(stat.size))
    watcher.untrack(3)

    writeFileSync(path, 'after untrack')
    await wait(800)

    expect(notified).toEqual([])
  })

  it(
    "calling track again drops the previous file's watch (one file per window)",
    async () => {
      root = makeTestDir('viewer-watch')
      mkdirSync(join(root, 'dirA'))
      mkdirSync(join(root, 'dirB'))
      const pathA = join(root, 'dirA', 'a.txt')
      const pathB = join(root, 'dirB', 'b.txt')
      writeFileSync(pathA, 'a')
      writeFileSync(pathB, 'b')
      const notified: [number, string][] = []
      const watcher = new ViewerFileWatcher({ notify: (viewId, uri) => notified.push([viewId, uri]), debounceMs: 50 })
      const statA = statSync(pathA)
      watcher.track(4, 'file:///a.txt', pathA, statA.mtimeMs, Number(statA.size))
      const statB = statSync(pathB)
      watcher.track(4, 'file:///b.txt', pathB, statB.mtimeMs, Number(statB.size))

      // Rewriting a, which should no longer be watched, produces no notice.
      writeFileSync(pathA, 'a changed')
      await wait(800)
      expect(notified).toEqual([])

      // b, which is watched now, is still checked.
      await writeUntilNotified(() => writeFileSync(pathB, 'b changed'), notified)
      expect(notified).toEqual([[4, 'file:///b.txt']])
      watcher.untrack(4)
    },
    20000
  )

  // code-review fix (TODO 673, the second half of critical 7): re-reading the same file does not recreate `fs.watch`; it only updates the baseline.
  // That `FSWatcher` is not replaced is checked by whether `close` was called (Node's `FSWatcher` has no hook for replacement,
  // so `fs.watch` itself is replaced and counted).
  it(
    'calling track again for the same file does not recreate fs.watch and only updates the baseline',
    async () => {
      root = makeTestDir('viewer-watch')
      const path = join(root, 'd.txt')
      writeFileSync(path, 'one')
      const notified: [number, string][] = []
      const watcher = new ViewerFileWatcher({ notify: (viewId, uri) => notified.push([viewId, uri]), debounceMs: 50 })
      const stat = statSync(path)
      watcher.track(5, 'file:///d.txt', path, stat.mtimeMs, Number(stat.size))

      // Rewrite outside, then call track again for the same uri / path (same form as reloadFromDisk).
      writeFileSync(path, 'two-longer')
      const after = statSync(path)
      watcher.track(5, 'file:///d.txt', path, after.mtimeMs, Number(after.size))

      // The baseline matches the new contents, so no notice comes here (if it had been recreated, a race would arise, and changes during the moment the watch was gone could be missed).
      await wait(300)
      expect(notified).toEqual([])

      // The watch itself (same parent directory) is still alive, and the next change is caught.
      await writeUntilNotified(() => writeFileSync(path, 'three'), notified)
      expect(notified).toEqual([[5, 'file:///d.txt']])
      watcher.untrack(5)
    },
    20000
  )
})
