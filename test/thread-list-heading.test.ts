/**
 * Items 193 / 194 (wave 14 bundle F): when to show headings in cwd order, and the input sent by 'new' in the heading. Pure functions only (no DOM or model).
 */
import { describe, expect, it } from 'vitest'
import type { BackendChoice } from '../src/shared/thread.js'
import { translate, type Translate } from '../src/renderer/src/i18n/index.js'
import {
  folderCreateInput,
  folderHeadingView,
  showsRowCwd,
  subtasksTooltip
} from '../src/renderer/src/thread-list-heading.js'
import { arrangeThreads, type SortRow } from '../src/renderer/src/thread-sort.js'

const ja: Translate = (key, params) => translate('ja', key, params)
const en: Translate = (key, params) => translate('en', key, params)
const pathOf = (uri: string): string => uri.replace('file:///Users/me', '~')

function backend(patch: Partial<BackendChoice> = {}): BackendChoice {
  return {
    id: 'cli',
    label: 'CLI',
    available: true,
    message: null,
    models: [
      { id: 'sonnet', label: 'Sonnet' } as BackendChoice['models'][number],
      { id: 'opus', label: 'Opus' } as BackendChoice['models'][number]
    ],
    modelSelect: true,
    thinkingLevel: true,
    rewind: true,
    capabilities: { approval: true, subagents: true, rewind: true, mcp: true },
    degradations: [],
    commands: null,
    ...patch
  }
}

describe('見出しの表示 (項目 193)', () => {
  it('フォルダ名とフルパス。件数は持たない', () => {
    const view = folderHeadingView({ name: 'aios', uri: 'file:///Users/me/git/aios' }, ja, pathOf)
    expect(view.name).toBe('aios')
    expect(view.title).toBe('~/git/aios')
    expect(Object.keys(view).sort()).toEqual(['createLabel', 'name', 'title'])
  })

  it('所属なし (捨て場) は辞書の名前', () => {
    expect(folderHeadingView({ name: '', uri: null }, ja, pathOf).name).toBe(ja('threads.sort.noFolder'))
    expect(folderHeadingView({ name: '', uri: null }, en, pathOf).name).toBe(en('threads.sort.noFolder'))
  })

  it('パスが分からないときは title に名前', () => {
    expect(folderHeadingView({ name: 'x', uri: 'file:///x' }, ja, () => null).title).toBe('x')
  })

  it('cwd 順では行の頭に cwd 名を出さない。他の並びでは今までどおり', () => {
    expect(showsRowCwd('cwd', 'aios')).toBe(false)
    expect(showsRowCwd('recent', 'aios')).toBe(true)
    expect(showsRowCwd('unread', 'aios')).toBe(true)
    expect(showsRowCwd('recent', '')).toBe(false)
  })

  it('並べ方は項目 152 のまま (捨て場の組は最後)', () => {
    const row = (id: string, folder: string): SortRow => ({
      id,
      attention: 0,
      folderKey: folder,
      folderName: folder === '' ? '' : folder.slice(-1),
      folderUri: folder === '' ? null : folder,
      rainbow: null,
      collapsible: false
    })
    const items = arrangeThreads('cwd', [row('a', ''), row('b', 'file:///x'), row('c', 'file:///y')])
    expect(items.filter((i) => i.kind === 'folder').map((i) => (i.kind === 'folder' ? i.name : ''))).toEqual([
      'x',
      'y',
      ''
    ])
  })
})

describe('見出しの「新規作成」(項目 194)', () => {
  it('ラベルはフォルダ名入り。捨て場は使い捨て', () => {
    expect(folderHeadingView({ name: 'aios', uri: 'file:///a' }, en, pathOf).createLabel).toBe(
      'New thread in aios'
    )
    expect(folderHeadingView({ name: 'aios', uri: 'file:///a' }, ja, pathOf).createLabel).toBe(
      'aios で新しいスレッド'
    )
    expect(folderHeadingView({ name: '', uri: null }, en, pathOf).createLabel).toBe('New scratch thread')
    expect(folderHeadingView({ name: '', uri: null }, ja, pathOf).createLabel).toBe('新しい使い捨てのスレッド')
  })

  it('組の cwd で作り、モデルと thinking は設定の既定を具体的な値にして送る (項目 121)', () => {
    expect(
      folderCreateInput('file:///Users/me/git/aios', backend(), { defaultModelId: 'opus', defaultThinking: 'high' })
    ).toEqual({ cwdUri: 'file:///Users/me/git/aios', backend: 'cli', modelId: 'opus', thinking: 'high' })
  })

  it('設定の既定が無い・一覧に無いときも null にせず一覧の先頭と既定の段階', () => {
    const input = folderCreateInput('file:///a', backend(), { defaultModelId: 'gone', defaultThinking: null })
    expect(input.modelId).toBe('sonnet')
    expect(input.thinking).not.toBeNull()
    const noSettings = folderCreateInput('file:///a', backend(), null)
    expect(noSettings.modelId).toBe('sonnet')
    expect(noSettings.thinking).not.toBeNull()
  })

  it('捨て場の組は新しい捨て場 (cwdUri を送らない)', () => {
    const input = folderCreateInput(null, backend(), null)
    expect(input.scratch).toBe(true)
    expect('cwdUri' in input).toBe(false)
    expect(input.approvalStrict).toBeUndefined()
  })

  it('モデルや thinking を選べないバックエンドでは null', () => {
    const input = folderCreateInput('file:///a', backend({ modelSelect: false, thinkingLevel: false, models: [] }), null)
    expect(input.modelId).toBeNull()
    expect(input.thinking).toBeNull()
  })
})

describe('subtasksTooltip: EN の単数形 (TODO 322 の小さな観察、第 17 波 束 J)', () => {
  it('1 件は単数形、2 件以上は複数形 (EN)', () => {
    expect(subtasksTooltip(1, en)).toBe('1 subagent running')
    expect(subtasksTooltip(2, en)).toBe('2 subagents running')
    expect(subtasksTooltip(4, en)).toBe('4 subagents running')
  })

  it('JA はどちらも同じ文言', () => {
    expect(subtasksTooltip(1, ja)).toBe('子エージェント 1 件が動作中')
    expect(subtasksTooltip(3, ja)).toBe('子エージェント 3 件が動作中')
  })
})
