/**
 * @vitest-environment jsdom
 *
 * TODO 900 (wave 47 bundle C): the history of the search field.
 * - Pure functions (`shared/search-history.ts`): newest first; a duplicate moves to the top; 20 entries; empty words and too-long words are not stored.
 * - main's `SearchHistory`: persists across restarts; a broken saved value is empty; individual deletion and clear-all.
 * - `SearchHistoryList`: press to choose / ✕ deletes one individually / clear-all. Does not take focus from the field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement } from 'react'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { SEARCH_HISTORY } from '../src/common/settings-keys.js'
import { SearchHistory } from '../src/main/search-history.js'
import {
  SEARCH_HISTORY_MAX,
  SEARCH_HISTORY_MAX_LENGTH,
  type SearchHistoryEntry,
  pushHistory,
  removeFromHistory,
  sanitizeHistory
} from '../src/shared/search-history.js'
import { SearchHistoryList } from '../src/renderer/src/components/SearchHistoryList.js'
import { useSearchHistory } from '../src/renderer/src/searchHistoryStore.js'

const f = (query: string): SearchHistoryEntry => ({ query, mode: 'files' })

describe('search-history の純関数', () => {
  it('新しい順に足し、同じ語 + モードは先頭へ寄せる', () => {
    expect(
      pushHistory(pushHistory(pushHistory([], 'a', 'files'), 'b', 'files'), 'a', 'files')
    ).toEqual([f('a'), f('b')])
  })
  it('同じ語でもモードが違えば別の項目 (TODO 1157)', () => {
    const h = pushHistory(pushHistory([], 'a', 'files'), 'a', 'names')
    expect(h).toEqual([{ query: 'a', mode: 'names' }, f('a')])
    expect(removeFromHistory(h, 'a', 'names')).toEqual([f('a')])
  })
  it('空・空白だけ・長すぎる・文字列でない語・知らないモードは入れない', () => {
    expect(pushHistory([f('a')], '   ', 'files')).toEqual([f('a')])
    expect(pushHistory([f('a')], 'x'.repeat(SEARCH_HISTORY_MAX_LENGTH + 1), 'files')).toEqual([f('a')])
    expect(pushHistory([f('a')], 3, 'files')).toEqual([f('a')])
    expect(pushHistory([f('a')], 'b', 'bogus')).toEqual([f('a')])
    expect(pushHistory([], '  語  ', 'conversation')).toEqual([{ query: '語', mode: 'conversation' }])
  })
  it('20 件まで (古いものから落ちる)', () => {
    let h: readonly SearchHistoryEntry[] = []
    for (let i = 0; i < 25; i += 1) h = pushHistory(h, `q${i}`, 'files')
    expect(h).toHaveLength(SEARCH_HISTORY_MAX)
    expect(h[0]?.query).toBe('q24')
    expect(h.at(-1)?.query).toBe('q5')
  })
  it('個別に消す / 壊れた保存値を整える', () => {
    expect(removeFromHistory([f('a'), f('b')], 'a', 'files')).toEqual([f('b')])
    expect(sanitizeHistory([{ query: 'a', mode: 'names' }, 1, { query: 'a', mode: 'names' }, '', ' b '])).toEqual([
      { query: 'a', mode: 'names' },
      f('b')
    ])
    expect(sanitizeHistory([{ query: 'x', mode: 'nope' }, { query: 'y' }])).toEqual([])
    expect(sanitizeHistory('nope')).toEqual([])
  })
  it('旧形式 (文字列の配列) は files として読む', () => {
    expect(sanitizeHistory(['a', 'b', 'a'])).toEqual([f('a'), f('b')])
    expect(SEARCH_HISTORY.parse('["old","new"]')).toEqual([f('old'), f('new')])
  })
})

describe('SearchHistory (main)', () => {
  let db: Db
  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })
  afterEach(() => db.close())

  it('保存して、作り直しても残る。個別削除と全消し', () => {
    const settings = new AppSettingsStore(db)
    const h = new SearchHistory(settings)
    expect(h.get()).toEqual([])
    h.add('foo', 'files')
    h.add('bar', 'names')
    h.add('foo', 'files')
    expect(new SearchHistory(settings).get()).toEqual([f('foo'), { query: 'bar', mode: 'names' }])
    expect(h.remove('foo', 'files')).toEqual([{ query: 'bar', mode: 'names' }])
    expect(h.add('  ', 'files')).toEqual([{ query: 'bar', mode: 'names' }])
    expect(h.clear()).toEqual([])
    expect(settings.readTyped(SEARCH_HISTORY)).toEqual([])
  })

  it('壊れた保存値は空の扱い', () => {
    expect(SEARCH_HISTORY.parse('{oops')).toEqual([])
    expect(SEARCH_HISTORY.parse(null)).toEqual([])
    expect(SEARCH_HISTORY.owner).toBe('main')
  })
})

describe('SearchHistoryList', () => {
  let host: HTMLDivElement
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.appendChild(host)
  })
  afterEach(() => {
    host.remove()
    useSearchHistory.setState({ items: [] })
  })

  it('押すと選ぶ。✕ は選ばずに消す。全消しの口がある。mousedown は既定動作を止める (focus を奪わない)', async () => {
    const remove = vi.fn().mockResolvedValue([{ query: 'b', mode: 'names' }])
    const clear = vi.fn().mockResolvedValue([])
    ;(window as unknown as { aios: unknown }).aios = { searchHistory: { remove, clear } }
    const onPick = vi.fn()
    await act(async () => {
      createRoot(host).render(createElement(SearchHistoryList, { items: [f('a'), { query: 'b', mode: 'names' }], cursor: 1, onPick }))
    })
    const items = host.querySelectorAll('.search-history-item')
    expect(items).toHaveLength(2)
    expect(items[1]?.classList.contains('active')).toBe(true)
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    host.querySelector('.search-history')?.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    await act(async () => {
      ;(items[0] as HTMLElement).click()
    })
    expect(onPick).toHaveBeenCalledWith(f('a'))
    expect(items[1]?.querySelector('.search-history-mode')?.textContent).toBe('🔍')
    await act(async () => {
      ;(host.querySelectorAll('.search-history-remove')[0] as HTMLElement).click()
    })
    expect(remove).toHaveBeenCalledWith('a', 'files')
    expect(onPick).toHaveBeenCalledTimes(1)
    await act(async () => {
      ;(host.querySelector('.search-history-clear') as HTMLElement).click()
    })
    expect(clear).toHaveBeenCalled()
  })
})
