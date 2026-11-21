/**
 * TODO 630 (wave 29 bundle E, owner request 2026-10-10): adds 'Search' to the right-click menu for text selected in a viewer.
 * Owner decision (a): the selected word is put into the full-text search (⌘⇧F, the index of the whole PC) and run.
 *
 *  - plugin (plugins/_shared/bridge.ts): from `window.getSelection()` and the displayed `uri`, builds the 'notify only' message to the host, purely (`contextMenuMessage`).
 *    Without a selection it is null (no preventDefault either: right-click does nothing new)
 *  - host (src/renderer/src/path-context-menu.ts): builds the search term from the selected string (`selectionSearchQueryOf`; for multiple lines the first line,
 *    long lines are cut at the limit), and the menu item (`selectionSearchMenuItem`). It keeps the plugin boundary (constraint 8): it does not call search directly, it only passes `run`
 *  - host (src/renderer/src/searchStore.ts): the path where the `seed` of `requestFocus` rewrites the search panel's input (`searchSelection` in `src/renderer/src/shortcut-actions.ts`)
 *
 * Neither the model nor Electron is started.
 */
import { describe, expect, it, vi } from 'vitest'
import { contextMenuMessage } from '../plugins/_shared/bridge.js'
import {
  SELECTION_SEARCH_MAX,
  selectionSearchMenuItems,
  threadSelectionMenuItems,
  selectionSearchQueryOf
} from '../src/renderer/src/path-context-menu.js'
import { useSearch } from '../src/renderer/src/searchStore.js'
import { acceptViewerContextMenu } from '../src/renderer/src/viewer-selection.js'
import { MAX_SELECTION_TEXT } from '../src/shared/plugin.js'
import { translate } from '../src/renderer/src/i18n/index.js'
import { en } from '../src/renderer/src/i18n/en.js'
import { ja } from '../src/renderer/src/i18n/ja.js'

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string =>
  translate('en', key, params)

describe('plugin → host: contextMenuMessage (TODO 630)', () => {
  it('選択が空白だけ、または表示中のファイルが無ければ null (何もしない)', () => {
    expect(contextMenuMessage('', 'file:///a.ts', 1, 2)).toBeNull()
    expect(contextMenuMessage('   \n ', 'file:///a.ts', 1, 2)).toBeNull()
    expect(contextMenuMessage('foo', null, 1, 2)).toBeNull()
  })

  it('選択があれば uri / 座標 / 本文をそのまま載せる', () => {
    expect(contextMenuMessage('foo bar', 'file:///a.ts', 10, 20)).toEqual({
      type: 'context-menu',
      uri: 'file:///a.ts',
      x: 10,
      y: 20,
      text: 'foo bar'
    })
  })

  it('大きすぎる選択は切る (`clipSelectionText` と同じ上限)', () => {
    const huge = 'x'.repeat(30_000)
    const message = contextMenuMessage(huge, 'file:///a.ts', 0, 0)
    expect(message?.type).toBe('context-menu')
    expect(message?.type === 'context-menu' ? message.text.length : -1).toBeLessThan(huge.length)
  })
})

describe('host: selectionSearchQueryOf (TODO 630)', () => {
  it('空でない最初の行を使う', () => {
    expect(selectionSearchQueryOf('foo\nbar\nbaz')).toEqual({ query: 'foo', truncated: false })
  })

  it('空行をまたぐ (composer-drafts.ts の provisionalTitle と同じ作り)', () => {
    expect(selectionSearchQueryOf('\n  \nfoo bar')).toEqual({ query: 'foo bar', truncated: false })
  })

  it('空白だけの選択は null', () => {
    expect(selectionSearchQueryOf('   \n  ')).toBeNull()
  })

  it('長い行は上限で切り、truncated を立てる', () => {
    const line = 'a'.repeat(SELECTION_SEARCH_MAX + 20)
    const found = selectionSearchQueryOf(line)
    expect(found?.truncated).toBe(true)
    expect(found?.query.length).toBe(SELECTION_SEARCH_MAX)
  })
})

describe('host: selectionSearchMenuItems (TODO 630 / 1030)', () => {
  it('本文・ファイル名・会話の 3 項目を直接並べ、onSelect は欄と縮めた検索語そのものを渡す', () => {
    const run = vi.fn()
    const items = selectionSearchMenuItems('hello world', t, run)
    expect(items.map((item) => item.key)).toEqual([
      'search-selection-files',
      'search-selection-names',
      'search-selection-conversation'
    ])
    expect(items.map((item) => item.label)).toEqual([
      'Search files for "hello world"',
      'Search file names for "hello world"',
      'Search conversations for "hello world"'
    ])
    items[1]?.onSelect()
    expect(run).toHaveBeenCalledWith('names', 'hello world')
    items[2]?.onSelect()
    expect(run).toHaveBeenCalledWith('conversation', 'hello world')
  })

  it('キーの表記は keyLabel があれば shortcut に載る', () => {
    const items = selectionSearchMenuItems('x', t, vi.fn(), (target) => (target === 'files' ? '⇧⌘F' : null))
    expect(items[0]?.shortcut).toBe('⇧⌘F')
    expect(items[1]?.shortcut).toBeUndefined()
  })

  it('切った語は表示だけ省略記号を付ける', () => {
    const line = 'a'.repeat(SELECTION_SEARCH_MAX + 1)
    const items = selectionSearchMenuItems(line, t, vi.fn())
    expect(items[0]?.label).toBe(`Search files for "${'a'.repeat(SELECTION_SEARCH_MAX)}…"`)
  })

  it('空白だけの選択は項目を出さない', () => {
    expect(selectionSearchMenuItems('   ', t, vi.fn())).toEqual([])
  })

  it('EN / JA の両方に辞書の鍵がある', () => {
    for (const key of [
      'viewer.contextMenu.searchFiles',
      'viewer.contextMenu.searchNames',
      'viewer.contextMenu.searchConversations',
      'contextMenu.copy'
    ] as const) {
      expect(en[key]).toBeTruthy()
      expect(ja[key]).toBeTruthy()
    }
  })
})

describe('host: threadSelectionMenuItems (TODO 1030)', () => {
  it('「コピー」を先頭に置き、選択そのもの (縮めない) を写す。続けて 3 つの検索', () => {
    const copy = vi.fn()
    const text = `first\nsecond`
    const items = threadSelectionMenuItems(text, t, copy, vi.fn())
    expect(items.map((item) => item.key)).toEqual([
      'copy-selection',
      'search-selection-files',
      'search-selection-names',
      'search-selection-conversation'
    ])
    items[0]?.onSelect()
    expect(copy).toHaveBeenCalledWith(text)
  })

  it('選択が無い (空白だけ) ときは空 = 既定のメニューに任せる', () => {
    expect(threadSelectionMenuItems('  \n', t, vi.fn(), vi.fn())).toEqual([])
  })
})

describe('host: searchStore.requestFocus の seed (TODO 630)', () => {
  it('seed を渡すと focusRequest に載る。省略時は今までどおり持たない', () => {
    useSearch.getState().requestFocus('files', 'hello')
    expect(useSearch.getState().focusRequest).toMatchObject({ target: 'files', seed: 'hello' })

    useSearch.getState().requestFocus('names')
    expect(useSearch.getState().focusRequest?.seed).toBeUndefined()
  })

  it('code-review: consumeFocusSeed は同じ世代の seed だけを外し、focus の要求は残す', () => {
    useSearch.getState().requestFocus('files', 'hello')
    const seq = useSearch.getState().focusRequest?.seq ?? -1
    useSearch.getState().consumeFocusSeed(seq - 1)
    expect(useSearch.getState().focusRequest?.seed).toBe('hello')
    useSearch.getState().consumeFocusSeed(seq)
    expect(useSearch.getState().focusRequest).toEqual({ target: 'files', seq })
  })
})

describe('host: acceptViewerContextMenu (code-review、plugin の値を信用しない)', () => {
  const uri = 'file:///w/a.md'
  it('正しい形で表示中のファイル宛てなら通す', () => {
    expect(acceptViewerContextMenu({ type: 'context-menu', uri, x: 3, y: 4, text: 'hi' } as never, uri)).toEqual({
      uri,
      x: 3,
      y: 4,
      text: 'hi',
      // TODO 692: the mark above the name (false if absent)
      codeNav: false
    })
  })
  it('型の違い・有限でない座標・表示中でない uri は捨てる', () => {
    const bad: Record<string, unknown>[] = [
      { uri, x: '3', y: 4, text: 'hi' },
      { uri, x: Number.NaN, y: 4, text: 'hi' },
      { uri, x: 3, y: Number.POSITIVE_INFINITY, text: 'hi' },
      { uri, x: 3, y: 4, text: 42 },
      { uri, x: 3, y: 4, text: { length: 1 } },
      { uri: 'file:///w/other.md', x: 3, y: 4, text: 'hi' },
      { uri: 7, x: 3, y: 4, text: 'hi' }
    ]
    for (const message of bad) expect(acceptViewerContextMenu(message, uri), JSON.stringify(message)).toBeNull()
    expect(acceptViewerContextMenu({ uri, x: 3, y: 4, text: 'hi' }, null)).toBeNull()
  })
  it('長すぎる本文は host 側でも MAX_SELECTION_TEXT で切る', () => {
    const text = 'a'.repeat(MAX_SELECTION_TEXT + 100)
    expect(acceptViewerContextMenu({ uri, x: 0, y: 0, text }, uri)?.text.length).toBe(MAX_SELECTION_TEXT)
  })
})
