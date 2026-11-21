/**
 * TODO 677 (main side): the choke point before a native drag of Files tree rows to other apps.
 *
 * `resolveDragPaths` silently drops (does not throw) what `FsAccess.assertAllowed` (read) refuses and what is not found, because it is a one-way call that gives no reply to the renderer. `startFilesDrag` calls `WebContents.startDrag` only with the paths that pass, and does nothing if none pass.
 * Electron is not used (`nativeImage` / `startDrag` are replaced).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_DRAG_ITEMS,
  resolveDragPaths,
  startFilesDrag,
  startFilesDragGuarded,
  type DragGate
} from '../src/main/fs/drag.js'

function gate(denyPrefixes: readonly string[] = []): DragGate {
  return {
    assertAllowed(uri: string): string {
      const path = uri.replace(/^file:\/\//, '')
      if (denyPrefixes.some((p) => path.startsWith(p))) throw new Error('denied')
      return path
    }
  }
}

describe('resolveDragPaths', () => {
  it('empty unless it is an array', () => {
    expect(resolveDragPaths(undefined, { gate: gate() })).toEqual([])
    expect(resolveDragPaths('x', { gate: gate() })).toEqual([])
  })

  it('silently drops refused and not-found items', () => {
    const kindOf = (path: string): boolean | null => (path === '/missing' ? null : false)
    const out = resolveDragPaths(
      ['file:///Users/a.txt', 'file:///.ssh/id_rsa', 'file:///missing', 123, 'x'.repeat(9000)],
      { gate: gate(['/.ssh']), kindOf }
    )
    expect(out).toEqual(['/Users/a.txt'])
  })

  it('a folder is passed through again "as a folder" (some exclusion rules apply only to folders)', () => {
    const seen: [string, boolean][] = []
    const g: DragGate = {
      assertAllowed(uri, asDirectory) {
        seen.push([uri, asDirectory])
        return uri.replace(/^file:\/\//, '')
      }
    }
    const out = resolveDragPaths(['file:///Users/proj'], { gate: g, kindOf: () => true })
    expect(out).toEqual(['/Users/proj'])
    expect(seen).toEqual([
      ['file:///Users/proj', false],
      ['file:///Users/proj', true]
    ])
  })

  it('the same path counts once, and items beyond the limit (MAX_DRAG_ITEMS) are ignored', () => {
    const many = Array.from({ length: MAX_DRAG_ITEMS + 10 }, (_, i) => `file:///f${i}`)
    const out = resolveDragPaths([...many, 'file:///f0'], { gate: gate(), kindOf: () => false })
    expect(out.length).toBe(MAX_DRAG_ITEMS)
  })
})

describe('startFilesDrag', () => {
  it('does not call the OS drag when no item passes', () => {
    const startDrag = vi.fn()
    startFilesDrag({} as never, ['file:///.ssh/x'], {
      gate: gate(['/.ssh']),
      startDrag,
      icon: () => ({ isEmpty: () => false }) as never
    })
    expect(startDrag).not.toHaveBeenCalled()
  })

  it('calls startDrag with the paths that passed (file is the first, files is all, icon is non-empty)', () => {
    const startDrag = vi.fn()
    const icon = { isEmpty: () => false }
    const sender = {} as never
    startFilesDrag(sender, ['file:///Users/a.txt', 'file:///Users/b.txt'], {
      gate: gate(),
      kindOf: () => false,
      startDrag,
      icon: () => icon as never
    })
    expect(startDrag).toHaveBeenCalledWith(sender, {
      file: '/Users/a.txt',
      files: ['/Users/a.txt', '/Users/b.txt'],
      icon
    })
  })

  // Code-review fix (TODO 677, serious 3): `ipcMain.on` does not go through main's `guarded` (TODO 572), so even if `sender.startDrag` throws, main is not brought down.
  it('startFilesDragGuarded: does not leak even if sender.startDrag throws', () => {
    const sender = {} as never
    expect(() =>
      startFilesDragGuarded(sender, ['file:///Users/a.txt'], {
        gate: gate(),
        kindOf: () => false,
        icon: () => ({ isEmpty: () => false }) as never,
        startDrag: () => {
          throw new Error('窓が閉じた')
        }
      })
    ).not.toThrow()
  })

  it('startFilesDrag itself throws (confirms it is what startFilesDragGuarded wraps)', () => {
    const sender = {} as never
    expect(() =>
      startFilesDrag(sender, ['file:///Users/a.txt'], {
        gate: gate(),
        kindOf: () => false,
        icon: () => ({ isEmpty: () => false }) as never,
        startDrag: () => {
          throw new Error('窓が閉じた')
        }
      })
    ).toThrow('窓が閉じた')
  })

  it('the default icon is a correctly formed non-empty PNG (16x16; Electron throws on an empty one)', async () => {
    // The electron package cannot be used under Node (vitest) (see the note in CLAUDE.md), so the data URL embedded in drag.ts is checked directly as a PNG (the signature, and the width and height in IHDR).
    const src = await import('node:fs').then((fs) => fs.promises.readFile('src/main/fs/drag.ts', 'utf8'))
    const match = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(src)
    expect(match).not.toBeNull()
    const buf = Buffer.from(match![1]!, 'base64')
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(buf.readUInt32BE(16)).toBe(16) // IHDR width
    expect(buf.readUInt32BE(20)).toBe(16) // IHDR height
  })
})
