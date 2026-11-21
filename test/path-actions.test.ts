// @vitest-environment jsdom
/**
 * TODO 288 / 289 (wave 16 bundle D): dragging a search result row, copying the full path, and revealing in Finder.
 *
 * - 288: whether a row can be dragged (a pure function), and that the URI is in `text/uri-list` and the receiving side (`droppedUris` of 258) picks it up.
 * - 289: main's entry point (`revealInFolder`, with `shell` as a fake): allowed / excluded / not-a-file / value checks.
 *   The button (jsdom): copy uses the real path, a press does not bubble, Finder calls IPC. The wording keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { droppedUris } from '../src/renderer/src/drop-uris.js'
import { isDraggableHit, startHitDrag } from '../src/renderer/src/search-drag.js'
import { revealInFolder } from '../src/main/editor/reveal.js'
import { revealLabelKey } from '../src/renderer/src/components/PathActions.js'
import { fullPath } from '../src/shared/uri.js'
import { en } from '../src/renderer/src/i18n/en.js'
import { ja } from '../src/renderer/src/i18n/ja.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('TODO 288: dragging a search result row', () => {
  it('only fs files can be dragged (conversations, transcripts and folders cannot)', () => {
    expect(isDraggableHit({ source: 'fs', kind: 'file' })).toBe(true)
    expect(isDraggableHit({ source: 'fs', kind: 'directory' })).toBe(false)
    expect(isDraggableHit({ source: 'conversation', kind: 'message' })).toBe(false)
    expect(isDraggableHit({ source: 'transcript', kind: 'message' })).toBe(false)
  })

  it('onDragStart puts the URI in text/uri-list and sets effectAllowed to copy; the receiver can pick it up', () => {
    const store = new Map<string, string>()
    const dataTransfer = {
      effectAllowed: 'uninitialized',
      setData: (format: string, data: string) => void store.set(format, data)
    }
    startHitDrag({ dataTransfer }, 'file:///Users/x/a%20b.md')
    expect(store.get('text/uri-list')).toBe('file:///Users/x/a%20b.md')
    expect(dataTransfer.effectAllowed).toBe('copy')
    const uris = droppedUris({ files: [], getData: (format) => store.get(format) ?? '' }, () => '')
    expect(uris).toEqual(['file:///Users/x/a%20b.md'])
  })

  it('silently does nothing for an event without dataTransfer', () => {
    expect(() => startHitDrag({ dataTransfer: null }, 'file:///a')).not.toThrow()
  })
})

describe('TODO 289: main entry (revealInFolder)', () => {
  const allow = (uri: string): string => uri.replace('file://', '')

  it('passes the real path of an allowed URI to the shell', () => {
    const show = vi.fn()
    expect(revealInFolder({ assertAllowed: allow, show }, 'file:///work/a.ts', false)).toBe(true)
    expect(show).toHaveBeenCalledWith('/work/a.ts')
  })

  it('returns false without calling the shell when the gate threw (excluded place, non-file:, etc.)', () => {
    const show = vi.fn()
    const deny = (): string => {
      throw new Error('denied')
    }
    expect(revealInFolder({ assertAllowed: deny, show }, 'file:///Users/x/.claude/a', false)).toBe(
      false
    )
    expect(revealInFolder({ assertAllowed: deny, show }, 'https://example.com/', false)).toBe(false)
    expect(show).not.toHaveBeenCalled()
  })

  it('does not pass non-strings or empty strings even to the gate (the manner of item 86)', () => {
    const assertAllowed = vi.fn(allow)
    const show = vi.fn()
    for (const bad of [undefined, null, 42, {}, ['file:///a'], '']) {
      expect(revealInFolder({ assertAllowed, show }, bad, false)).toBe(false)
    }
    expect(assertAllowed).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()
  })

  it('returns false without rethrowing even if the shell throws', () => {
    const show = vi.fn(() => {
      throw new Error('boom')
    })
    expect(revealInFolder({ assertAllowed: allow, show }, 'file:///a', true)).toBe(false)
  })

  it('asDirectory is passed to the gate as is', () => {
    const assertAllowed = vi.fn(allow)
    revealInFolder({ assertAllowed, show: vi.fn() }, 'file:///a', true)
    expect(assertAllowed).toHaveBeenCalledWith('file:///a', true)
  })
})

describe('TODO 289: wording and real path', () => {
  it('wording differs per OS and the keys exist in both EN / JA', () => {
    expect(revealLabelKey('darwin')).toBe('path.revealMac')
    expect(revealLabelKey('win32')).toBe('path.revealWin')
    expect(revealLabelKey('linux')).toBe('path.revealOther')
    expect(revealLabelKey(undefined)).toBe('path.revealOther')
    for (const key of ['path.copy', 'path.revealMac', 'path.revealWin', 'path.revealOther'] as const) {
      expect(en[key]).toBeTruthy()
      expect(ja[key]).toBeTruthy()
    }
    expect(en['path.revealMac']).toContain('Finder')
    expect(en['path.revealWin']).not.toContain('Finder')
  })

  it('fullPath does not fold home and decodes %-encoding', () => {
    expect(fullPath('file:///Users/alice/git/a%20b.md')).toBe('/Users/alice/git/a b.md')
    expect(fullPath('file:///C:/x/y.txt')).toBe('C:/x/y.txt')
  })
})

describe('TODO 289: PathActions buttons', () => {
  let root: Root
  let host: HTMLDivElement
  const reveal = vi.fn(async () => true)
  const writeText = vi.fn(async () => undefined)

  beforeEach(() => {
    reveal.mockClear()
    writeText.mockClear()
    ;(window as unknown as { aios: unknown }).aios = { editor: { reveal } }
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  async function mount(asDirectory = false): Promise<{ row: ReturnType<typeof vi.fn>; buttons: HTMLButtonElement[] }> {
    const { PathActions } = await import('../src/renderer/src/components/PathActions.js')
    const row = vi.fn()
    await act(async () => {
      root.render(
        createElement(
          'div',
          { onClick: row },
          createElement(PathActions, { uri: 'file:///Users/alice/a%20b.md', asDirectory })
        )
      )
    })
    return { row, buttons: Array.from(host.querySelectorAll('button')) }
  }

  it('copy writes the real path, the press does not bubble to the row click, and aria-label changes to a check; no title is added (item 320, moved to the bubble)', async () => {
    const { row, buttons } = await mount()
    expect(buttons).toHaveLength(2)
    await act(async () => {
      buttons[0]!.click()
    })
    expect(writeText).toHaveBeenCalledWith('/Users/alice/a b.md')
    expect(row).not.toHaveBeenCalled()
    expect(buttons[0]!.hasAttribute('title')).toBe(false)
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Copy path')
  })

  it('reveal in Finder calls IPC with the URI and asDirectory and does not bubble', async () => {
    const { row, buttons } = await mount(true)
    await act(async () => {
      buttons[1]!.click()
    })
    expect(reveal).toHaveBeenCalledWith('file:///Users/alice/a%20b.md', true)
    expect(row).not.toHaveBeenCalled()
  })
})

describe('TODO 902: path copy icon', () => {
  it('uses CopyPathIcon instead of CopyIcon and the wording is 「パスをコピー」', () => {
    const src = readFileSync('src/renderer/src/components/PathActions.tsx', 'utf8')
    expect(src).toContain('<CopyPathIcon />')
    expect(src).not.toContain('<CopyIcon />')
    expect(ja['path.copy']).toBe('パスをコピー')
    expect(en['path.copy']).toBe('Copy path')
  })
})
