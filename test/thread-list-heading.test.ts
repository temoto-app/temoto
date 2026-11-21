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
    capabilities: { approval: true, subagents: true, rewind: true, mcp: true, instructions: true },
    degradations: [],
    commands: null,
    ...patch
  }
}

describe('heading display (item 193)', () => {
  it('folder name and full path, with no count', () => {
    const view = folderHeadingView({ name: 'aios', uri: 'file:///Users/me/git/aios' }, ja, pathOf)
    expect(view.name).toBe('aios')
    expect(view.title).toBe('~/git/aios')
    expect(Object.keys(view).sort()).toEqual(['createLabel', 'name', 'title'])
  })

  it('no affiliation (scratch) uses the dictionary name', () => {
    expect(folderHeadingView({ name: '', uri: null }, ja, pathOf).name).toBe(ja('threads.sort.noFolder'))
    expect(folderHeadingView({ name: '', uri: null }, en, pathOf).name).toBe(en('threads.sort.noFolder'))
  })

  it('puts the name in the title when the path is unknown', () => {
    expect(folderHeadingView({ name: 'x', uri: 'file:///x' }, ja, () => null).title).toBe('x')
  })

  it('in cwd order does not show the cwd name at the head of the row, and in other orders it does as before', () => {
    expect(showsRowCwd('cwd', 'aios')).toBe(false)
    expect(showsRowCwd('recent', 'aios')).toBe(true)
    expect(showsRowCwd('unread', 'aios')).toBe(true)
    expect(showsRowCwd('recent', '')).toBe(false)
  })

  it('the ordering stays as in item 152 (the scratch group is last)', () => {
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

describe('heading 「新規作成」 (item 194)', () => {
  it('the label includes the folder name, and scratch is disposable', () => {
    expect(folderHeadingView({ name: 'aios', uri: 'file:///a' }, en, pathOf).createLabel).toBe(
      'New thread in aios'
    )
    expect(folderHeadingView({ name: 'aios', uri: 'file:///a' }, ja, pathOf).createLabel).toBe(
      'aios で新しいスレッド'
    )
    expect(folderHeadingView({ name: '', uri: null }, en, pathOf).createLabel).toBe('New scratch thread')
    expect(folderHeadingView({ name: '', uri: null }, ja, pathOf).createLabel).toBe('新しい使い捨てのスレッド')
  })

  it("creates in the group's cwd and sends model and thinking as concrete values from the settings default (item 121)", () => {
    expect(
      folderCreateInput('file:///Users/me/git/aios', backend(), { defaultModelId: 'opus', defaultThinking: 'high' })
    ).toEqual({ cwdUri: 'file:///Users/me/git/aios', backend: 'cli', modelId: 'opus', thinking: 'high' })
  })

  it('even when there is no settings default or it is not in the list, does not use null and uses the head of the list and the default level', () => {
    const input = folderCreateInput('file:///a', backend(), { defaultModelId: 'gone', defaultThinking: null })
    expect(input.modelId).toBe('sonnet')
    expect(input.thinking).not.toBeNull()
    const noSettings = folderCreateInput('file:///a', backend(), null)
    expect(noSettings.modelId).toBe('sonnet')
    expect(noSettings.thinking).not.toBeNull()
  })

  it('the scratch group creates a new scratch (does not send cwdUri)', () => {
    const input = folderCreateInput(null, backend(), null)
    expect(input.scratch).toBe(true)
    expect('cwdUri' in input).toBe(false)
    expect(input.approvalStrict).toBeUndefined()
  })

  it('null for a backend that cannot choose model or thinking', () => {
    const input = folderCreateInput('file:///a', backend({ modelSelect: false, thinkingLevel: false, models: [] }), null)
    expect(input.modelId).toBeNull()
    expect(input.thinking).toBeNull()
  })
})

describe('subtasksTooltip: EN singular (small observation of TODO 322, wave 17 bundle J)', () => {
  it('1 item is singular and 2 or more are plural (EN)', () => {
    expect(subtasksTooltip(1, en)).toBe('1 subagent running')
    expect(subtasksTooltip(2, en)).toBe('2 subagents running')
    expect(subtasksTooltip(4, en)).toBe('4 subagents running')
  })

  it('JA has the same wording for both', () => {
    expect(subtasksTooltip(1, ja)).toBe('子エージェント 1 件が動作中')
    expect(subtasksTooltip(3, ja)).toBe('子エージェント 3 件が動作中')
  })
})
