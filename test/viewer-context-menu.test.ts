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
  it('null (does nothing) when the selection is only whitespace or no file is displayed', () => {
    expect(contextMenuMessage('', 'file:///a.ts', 1, 2)).toBeNull()
    expect(contextMenuMessage('   \n ', 'file:///a.ts', 1, 2)).toBeNull()
    expect(contextMenuMessage('foo', null, 1, 2)).toBeNull()
  })

  it('with a selection, carries the uri / coordinates / body as they are', () => {
    expect(contextMenuMessage('foo bar', 'file:///a.ts', 10, 20)).toEqual({
      type: 'context-menu',
      uri: 'file:///a.ts',
      x: 10,
      y: 20,
      text: 'foo bar'
    })
  })

  it('cuts too large a selection (same limit as `clipSelectionText`)', () => {
    const huge = 'x'.repeat(30_000)
    const message = contextMenuMessage(huge, 'file:///a.ts', 0, 0)
    expect(message?.type).toBe('context-menu')
    expect(message?.type === 'context-menu' ? message.text.length : -1).toBeLessThan(huge.length)
  })
})

describe('host: selectionSearchQueryOf (TODO 630)', () => {
  it('uses the first non-empty line', () => {
    expect(selectionSearchQueryOf('foo\nbar\nbaz')).toEqual({ query: 'foo', truncated: false })
  })

  it('spans blank lines (same construction as provisionalTitle in composer-drafts.ts)', () => {
    expect(selectionSearchQueryOf('\n  \nfoo bar')).toEqual({ query: 'foo bar', truncated: false })
  })

  it('a whitespace-only selection is null', () => {
    expect(selectionSearchQueryOf('   \n  ')).toBeNull()
  })

  it('cuts a long line at the limit and sets truncated', () => {
    const line = 'a'.repeat(SELECTION_SEARCH_MAX + 20)
    const found = selectionSearchQueryOf(line)
    expect(found?.truncated).toBe(true)
    expect(found?.query.length).toBe(SELECTION_SEARCH_MAX)
  })
})

describe('host: selectionSearchMenuItems (TODO 630 / 1030)', () => {
  it('lists the 3 items body, file name, and conversation directly, and onSelect passes the field and the shortened search term itself', () => {
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

  it('the key notation goes into shortcut when keyLabel exists', () => {
    const items = selectionSearchMenuItems('x', t, vi.fn(), (target) => (target === 'files' ? '⇧⌘F' : null))
    expect(items[0]?.shortcut).toBe('⇧⌘F')
    expect(items[1]?.shortcut).toBeUndefined()
  })

  it('a cut term gets an ellipsis for display only', () => {
    const line = 'a'.repeat(SELECTION_SEARCH_MAX + 1)
    const items = selectionSearchMenuItems(line, t, vi.fn())
    expect(items[0]?.label).toBe(`Search files for "${'a'.repeat(SELECTION_SEARCH_MAX)}…"`)
  })

  it('a whitespace-only selection shows no item', () => {
    expect(selectionSearchMenuItems('   ', t, vi.fn())).toEqual([])
  })

  it('the dictionary keys exist in both EN / JA', () => {
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
  it('puts 「コピー」 first and copies the selection itself (not shortened), followed by 3 searches', () => {
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

  it('when there is no selection (whitespace only) it is empty = leaves it to the default menu', () => {
    expect(threadSelectionMenuItems('  \n', t, vi.fn(), vi.fn())).toEqual([])
  })
})

describe('host: the seed of searchStore.requestFocus (TODO 630)', () => {
  it('passing a seed puts it on focusRequest, and when omitted it holds none as before', () => {
    useSearch.getState().requestFocus('files', 'hello')
    expect(useSearch.getState().focusRequest).toMatchObject({ target: 'files', seed: 'hello' })

    useSearch.getState().requestFocus('names')
    expect(useSearch.getState().focusRequest?.seed).toBeUndefined()
  })

  it('code-review: consumeFocusSeed removes only the seed of the same generation and keeps the focus request', () => {
    useSearch.getState().requestFocus('files', 'hello')
    const seq = useSearch.getState().focusRequest?.seq ?? -1
    useSearch.getState().consumeFocusSeed(seq - 1)
    expect(useSearch.getState().focusRequest?.seed).toBe('hello')
    useSearch.getState().consumeFocusSeed(seq)
    expect(useSearch.getState().focusRequest).toEqual({ target: 'files', seq })
  })
})

describe("host: acceptViewerContextMenu (code-review, does not trust the plugin's values)", () => {
  const uri = 'file:///w/a.md'
  it('passes it when the shape is right and it is addressed to the displayed file', () => {
    expect(acceptViewerContextMenu({ type: 'context-menu', uri, x: 3, y: 4, text: 'hi' } as never, uri)).toEqual({
      uri,
      x: 3,
      y: 4,
      text: 'hi',
      // TODO 692: the mark above the name (false if absent)
      codeNav: false
    })
  })
  it('drops wrong types, non-finite coordinates, and a uri that is not displayed', () => {
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
  it('a too-long body is also cut by MAX_SELECTION_TEXT on the host side', () => {
    const text = 'a'.repeat(MAX_SELECTION_TEXT + 100)
    expect(acceptViewerContextMenu({ uri, x: 0, y: 0, text }, uri)?.text.length).toBe(MAX_SELECTION_TEXT)
  })
})
