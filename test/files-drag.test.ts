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
  it('何も始めていなければ null / false', () => {
    expect(currentFilesDrag()).toBeNull()
    expect(filesDragActive()).toBe(false)
  })

  it('begin で覚え、end で忘れる', () => {
    beginFilesDrag(['file:///a.txt', 'file:///b'])
    expect(currentFilesDrag()).toEqual(['file:///a.txt', 'file:///b'])
    expect(filesDragActive()).toBe(true)
    endFilesDrag()
    expect(currentFilesDrag()).toBeNull()
    expect(filesDragActive()).toBe(false)
  })

  it('空配列は「無い」と同じ扱い', () => {
    beginFilesDrag([])
    expect(currentFilesDrag()).toBeNull()
    expect(filesDragActive()).toBe(false)
  })

  it('後から渡した配列を書き換えても store の値は変わらない (コピーを持つ)', () => {
    const uris = ['file:///a']
    beginFilesDrag(uris)
    uris.push('file:///b')
    expect(currentFilesDrag()).toEqual(['file:///a'])
  })

  // Code-review fix (TODO 677, serious 1): after a dragstart that was preventDefault'ed, Chromium does not emit dragend. The automatic expiry by TTL is one of the safeguards.
  it('TTL (FILES_DRAG_TTL_MS) を過ぎたら dragend が来なくても自動的に忘れる', () => {
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
  it('installFilesDragForgetGuards: 文書全体の dragend / drop / mouseup / pointerup / focus のどれでも忘れる', () => {
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

  it('installFilesDragForgetGuards の戻り値で外すと、以後の合図では忘れない', () => {
    const target = new EventTarget()
    const uninstall = installFilesDragForgetGuards(target)
    uninstall()
    beginFilesDrag(['file:///a.txt'])
    target.dispatchEvent(new Event('drop'))
    expect(filesDragActive()).toBe(true)
  })
})

describe('mismatchesRememberedFiles (code-review の直し、重大 1 の保険の 4)', () => {
  it('名前を持つ File が 1 つも無ければ判定しない (test double との互換)', () => {
    expect(mismatchesRememberedFiles([{ uri: 'file:///x' }], ['file:///remembered.txt'])).toBe(false)
  })

  it('名前が覚えた URI のどれとも一致しなければ食い違いと見る', () => {
    expect(mismatchesRememberedFiles([{ name: 'other.txt' }], ['file:///remembered.txt'])).toBe(true)
  })

  it('名前が覚えた URI のどれかと一致すれば食い違わない', () => {
    expect(mismatchesRememberedFiles([{ name: 'remembered.txt' }], ['file:///a/remembered.txt'])).toBe(false)
  })

  it('URI の末尾が %-encode されていても一致を見る', () => {
    expect(mismatchesRememberedFiles([{ name: '日本語.txt' }], ['file:///a/%E6%97%A5%E6%9C%AC%E8%AA%9E.txt'])).toBe(
      false
    )
  })
})

describe('droppedUris: remembered があれば DataTransfer を読まない', () => {
  const data = {
    files: [{ uri: 'file:///finder.png' }],
    getData: (format: string) => (format === 'text/uri-list' ? 'file:///listed.md' : '')
  }
  const uriFor = (file: unknown): string => (file as { uri: string }).uri

  it('remembered が null なら今までどおり', () => {
    expect(droppedUris(data, uriFor)).toEqual(['file:///finder.png', 'file:///listed.md'])
  })

  it('remembered があればそれだけを返す', () => {
    expect(droppedUris(data, uriFor, ['file:///from-tree.ts'])).toEqual(['file:///from-tree.ts'])
  })

  // Code-review fix: if a real File that disagrees with the remembered URI is on board, read the real one instead of using the old memory.
  it('data.files の名前が remembered と食い違えば DataTransfer を読む', () => {
    const mismatched = {
      files: [{ uri: 'file:///finder.png', name: 'finder.png' }],
      getData: (format: string) => (format === 'text/uri-list' ? '' : '')
    }
    expect(droppedUris(mismatched, uriFor, ['file:///from-tree-stale.ts'])).toEqual(['file:///finder.png'])
  })
})

describe('collectDrop: remembered があれば files / emptyPaths は 0', () => {
  const uriFor = (file: unknown): string => (file as { uri: string }).uri

  it('remembered が無ければ今までどおり数える', () => {
    const data = { files: [{ uri: 'file:///a' }], getData: () => '' }
    expect(collectDrop(data, uriFor)).toEqual({ uris: ['file:///a'], files: 1, emptyPaths: 0 })
  })

  it('remembered があれば DataTransfer を無視する', () => {
    const data = { files: [{ uri: 'file:///ignored' }], getData: () => '' }
    expect(collectDrop(data, uriFor, ['file:///remembered'])).toEqual({
      uris: ['file:///remembered'],
      files: 0,
      emptyPaths: 0
    })
  })
})
