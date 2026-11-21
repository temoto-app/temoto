/**
 * TODO 677 / 443: a small store that remembers the URIs carried by a drag from the Files tree (`files-drag.ts`).
 *
 * If a value is remembered, `droppedUris` in `drop-uris.ts` and `collectDrop` in `viewer-drop.ts` return it as it is without reading `DataTransfer`. This treats it the same way as the earlier `text/uri-list`, without telling it apart from a real drop from Finder. Uses neither the model nor Electron.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginFilesDrag,
  currentFilesDrag,
  endFilesDrag,
  FILES_DRAG_TTL_MS,
  filesDragActive,
  installFilesDragForgetGuards,
  mismatchesRememberedFiles
} from '../src/renderer/src/files-drag.js'
import { collectDrop } from '../src/renderer/src/viewer-drop.js'
import { droppedUris } from '../src/renderer/src/drop-uris.js'

afterEach(() => {
  endFilesDrag()
  vi.useRealTimers()
})

describe('files-drag store', () => {
  it('null / false when nothing has started', () => {
    expect(currentFilesDrag()).toBeNull()
    expect(filesDragActive()).toBe(false)
  })

  it('remembers on begin and forgets on end', () => {
    beginFilesDrag(['file:///a.txt', 'file:///b'])
    expect(currentFilesDrag()).toEqual(['file:///a.txt', 'file:///b'])
    expect(filesDragActive()).toBe(true)
    endFilesDrag()
    expect(currentFilesDrag()).toBeNull()
    expect(filesDragActive()).toBe(false)
  })

  it('an empty array is treated the same as "none"', () => {
    beginFilesDrag([])
    expect(currentFilesDrag()).toBeNull()
    expect(filesDragActive()).toBe(false)
  })

  it('changing an array passed in later does not change the store value (it holds a copy)', () => {
    const uris = ['file:///a']
    beginFilesDrag(uris)
    uris.push('file:///b')
    expect(currentFilesDrag()).toEqual(['file:///a'])
  })

  // Code-review fix (TODO 677, serious 1): after a dragstart that was preventDefault'ed, Chromium does not emit dragend. The automatic expiry by TTL is one of the safeguards.
  it('forgets automatically after the TTL (FILES_DRAG_TTL_MS) even if dragend does not arrive', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    beginFilesDrag(['file:///a.txt'])
    expect(filesDragActive()).toBe(true)
    vi.setSystemTime(FILES_DRAG_TTL_MS)
    expect(filesDragActive()).toBe(true)
    vi.setSystemTime(FILES_DRAG_TTL_MS + 1)
    expect(currentFilesDrag()).toBeNull()
    expect(filesDragActive()).toBe(false)
  })

  // Check without jsdom: `installFilesDragForgetGuards` needs only `addEventListener` and `removeEventListener` (`DragForgetTarget`), so it is replaced with Node's built-in `EventTarget`.
  it('installFilesDragForgetGuards: forgets on any of dragend / drop / mouseup / pointerup / focus on the whole document', () => {
    for (const type of ['dragend', 'drop', 'mouseup', 'pointerup', 'focus']) {
      beginFilesDrag(['file:///a.txt'])
      expect(filesDragActive()).toBe(true)
      const target = new EventTarget()
      const uninstall = installFilesDragForgetGuards(target)
      target.dispatchEvent(new Event(type))
      expect(filesDragActive(), `${type} で忘れる`).toBe(false)
      uninstall()
    }
  })

  it('when removed with the return value of installFilesDragForgetGuards, later signals do not forget', () => {
    const target = new EventTarget()
    const uninstall = installFilesDragForgetGuards(target)
    uninstall()
    beginFilesDrag(['file:///a.txt'])
    target.dispatchEvent(new Event('drop'))
    expect(filesDragActive()).toBe(true)
  })
})

describe('mismatchesRememberedFiles (code-review fix, safeguard 4 of major issue 1)', () => {
  it('does not decide when there is no File with a name (compatible with test doubles)', () => {
    expect(mismatchesRememberedFiles([{ uri: 'file:///x' }], ['file:///remembered.txt'])).toBe(false)
  })

  it('sees a mismatch when the name matches none of the remembered URIs', () => {
    expect(mismatchesRememberedFiles([{ name: 'other.txt' }], ['file:///remembered.txt'])).toBe(true)
  })

  it('no mismatch when the name matches any of the remembered URIs', () => {
    expect(mismatchesRememberedFiles([{ name: 'remembered.txt' }], ['file:///a/remembered.txt'])).toBe(false)
  })

  it('also checks the match when the end of the URI is %-encoded', () => {
    expect(mismatchesRememberedFiles([{ name: '日本語.txt' }], ['file:///a/%E6%97%A5%E6%9C%AC%E8%AA%9E.txt'])).toBe(
      false
    )
  })
})

describe('droppedUris: does not read DataTransfer if remembered exists', () => {
  const data = {
    files: [{ uri: 'file:///finder.png' }],
    getData: (format: string) => (format === 'text/uri-list' ? 'file:///listed.md' : '')
  }
  const uriFor = (file: unknown): string => (file as { uri: string }).uri

  it('when remembered is null, as before', () => {
    expect(droppedUris(data, uriFor)).toEqual(['file:///finder.png', 'file:///listed.md'])
  })

  it('when remembered exists, returns only that', () => {
    expect(droppedUris(data, uriFor, ['file:///from-tree.ts'])).toEqual(['file:///from-tree.ts'])
  })

  // Code-review fix: if a real File that disagrees with the remembered URI is on board, read the real one instead of using the old memory.
  it('reads DataTransfer when the names in data.files conflict with remembered', () => {
    const mismatched = {
      files: [{ uri: 'file:///finder.png', name: 'finder.png' }],
      getData: (format: string) => (format === 'text/uri-list' ? '' : '')
    }
    expect(droppedUris(mismatched, uriFor, ['file:///from-tree-stale.ts'])).toEqual(['file:///finder.png'])
  })
})

describe('collectDrop: if remembered exists, files / emptyPaths are 0', () => {
  const uriFor = (file: unknown): string => (file as { uri: string }).uri

  it('when there is no remembered, counts as before', () => {
    const data = { files: [{ uri: 'file:///a' }], getData: () => '' }
    expect(collectDrop(data, uriFor)).toEqual({ uris: ['file:///a'], files: 1, emptyPaths: 0 })
  })

  it('when remembered exists, ignores DataTransfer', () => {
    const data = { files: [{ uri: 'file:///ignored' }], getData: () => '' }
    expect(collectDrop(data, uriFor, ['file:///remembered'])).toEqual({
      uris: ['file:///remembered'],
      files: 0,
      emptyPaths: 0
    })
  })
})
