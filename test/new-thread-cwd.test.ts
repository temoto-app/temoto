/**
 * Wave 13 bundle A: the creation dialog (items 150 / 153) and the explanation in the settings screen (item 148).
 * Checks the full path of a history row (a pure function), and the adding and removing of dictionary keys and the text kept in English. The DOM is not used.
 */
import { describe, expect, it } from 'vitest'
import type { CwdHistoryEntry } from '../src/shared/thread.js'
import {
  SCRATCH_CHOICE,
  bareCwdEntry,
  cwdKeyStep,
  cwdRows,
  filterCwdRows,
  firstUsableUri
} from '../src/renderer/src/new-thread-cwd.js'
import { en } from '../src/renderer/src/i18n/en.js'
import { ja } from '../src/renderer/src/i18n/ja.js'

const HOME = 'file:///Users/me'

function entry(uri: string, extra: Partial<CwdHistoryEntry> = {}): CwdHistoryEntry {
  return {
    uri,
    name: 'x',
    parentName: 'y',
    lastUsedAt: 1,
    useCount: 2,
    usable: true,
    reason: null,
    // TODO 742: rainbow. The test default is no color (null); only the rendering of `NewThreadDialog` checks the color value itself.
    rainbow: null,
    ...extra
  }
}

describe('cwdRows (項目 153)', () => {
  it('履歴の行はフルパスで、ホームの下は ~ に畳む', () => {
    const rows = cwdRows([entry(`${HOME}/git/mybox`), entry('file:///opt/work')], HOME, null)
    expect(rows.map((r) => r.path)).toEqual(['~/git/mybox', '/opt/work', '~'])
  })

  it('ホームが履歴にあれば末尾に足さない (並びは履歴のまま)', () => {
    const rows = cwdRows([entry(HOME), entry(`${HOME}/a`)], HOME, null)
    expect(rows.map((r) => r.path)).toEqual(['~', '~/a'])
    expect(rows[0]?.entry.useCount).toBe(2)
  })

  it('履歴に無いホームは使える擬似エントリで足す', () => {
    const [home] = cwdRows([], HOME, null)
    expect(home?.path).toBe('~')
    expect(home?.entry).toMatchObject({ uri: HOME, usable: true, useCount: 0, reason: null })
  })

  it('Open Folder… で選んだフォルダは、履歴にもホームにも無いときだけ先頭に足す (TODO 462)', () => {
    const picked = bareCwdEntry(`${HOME}/new`, 5)
    expect(cwdRows([], HOME, picked).map((r) => r.path)).toEqual(['~/new', '~'])
    expect(cwdRows([entry('file:///opt/a')], HOME, picked).map((r) => r.path)).toEqual(['~/new', '/opt/a', '~'])
    expect(cwdRows([entry(`${HOME}/new`)], HOME, picked).map((r) => r.path)).toEqual(['~/new', '~'])
    expect(cwdRows([], HOME, bareCwdEntry(HOME)).map((r) => r.path)).toEqual(['~'])
  })

  it('符号化された名前は戻して出す (空白・日本語)', () => {
    const rows = cwdRows([entry(`${HOME}/My%20Docs/%E8%B3%87%E6%96%99`)], HOME, null)
    expect(rows[0]?.path).toBe('~/My Docs/資料')
  })

  it('ホームと前方一致するだけの隣のフォルダは ~ に畳まない', () => {
    const rows = cwdRows([entry('file:///Users/meow/x')], HOME, null)
    expect(rows[0]?.path).toBe('/Users/meow/x')
  })

  it('bareCwdEntry は URI の末尾を名前にする', () => {
    expect(bareCwdEntry(`${HOME}/git/%E4%BD%9C%E6%A5%AD/`)).toMatchObject({ name: '作業', parentName: '' })
  })
})

describe('辞書 (項目 148 / 150 / 153)', () => {
  const dicts = [en, ja] as Record<string, string>[]

  it('厳格モードと説明文の鍵は EN / JA の両方から消えている', () => {
    for (const dict of dicts) {
      for (const key of [
        'newThread.strict',
        'newThread.strictOnHint',
        'newThread.strictOffHint',
        'newThread.dropHint',
        'newThread.cwd.heading',
        'newThread.cwd.folderHint1',
        'newThread.cwd.folderHint2',
        'newThread.cwd.folderHint3'
      ]) {
        expect(dict[key]).toBeUndefined()
      }
    }
  })

  it('捨て場の説明はツールチップ用に残っている', () => {
    for (const dict of dicts) expect(dict['newThread.cwd.scratchHint']).toBeTruthy()
  })

  it('ボタンと点線枠の文言は日本語表示でも英語 (オーナー決定)', () => {
    for (const dict of dicts) {
      expect(dict['newThread.cwd.pick']).toBe('Open Folder…')
      // TODO 462: "Continue" on row hover is also in English.
      expect(dict['newThread.transcript.rowContinue']).toBe('Continue')
      expect(dict['newThread.dropZone']).toBe('Drag a folder here')
    }
  })

  // TODO 742: removed the Cancel / + New at the bottom right (pressing a row, or Enter, creates the thread as it is).
  it('右下の Cancel / + New の鍵は EN / JA の両方から消えている', () => {
    for (const dict of dicts) {
      expect(dict['newThread.create']).toBeUndefined()
      expect(dict['newThread.cancel']).toBeUndefined()
    }
  })

  it('設定画面の既定の説明はダイアログで変えられるとは言わない (項目 148、項目 187 で項目ごとの説明になった)', () => {
    for (const [dict, dialog] of [
      [ja, 'ダイアログ'],
      [en, 'dialog']
    ] as const) {
      expect(dict['settings.item.defaultModel.description']).not.toContain(dialog)
      expect(dict['settings.item.defaultModel.description']).toContain('Model')
      expect(dict['settings.item.defaultThinking.description']).not.toContain(dialog)
      expect(dict['settings.item.defaultThinking.description']).toContain('Thinking')
    }
  })
})

describe('絞り込みと ↑↓ (TODO 462)', () => {
  const rows = cwdRows(
    [
      entry(`${HOME}/src/MyBox`),
      entry('file:///opt/gone', { usable: false, reason: 'cwd-not-found' }),
      entry(`${HOME}/src/other`)
    ],
    HOME,
    null
  )

  it('表示のパス (~ 表記のまま) の一部で、大文字小文字を区別しない', () => {
    expect(filterCwdRows(rows, 'mybox').map((r) => r.path)).toEqual(['~/src/MyBox'])
    expect(filterCwdRows(rows, '~/SRC').map((r) => r.path)).toEqual(['~/src/MyBox', '~/src/other'])
    // Does not match the real home path (narrowed by the ~ notation).
    expect(filterCwdRows(rows, '/Users/me')).toEqual([])
    expect(filterCwdRows(rows, 'zzz')).toEqual([])
  })

  it('空・空白だけの語は絞らない', () => {
    expect(filterCwdRows(rows, '')).toBe(rows)
    expect(filterCwdRows(rows, '   ')).toBe(rows)
  })

  it('最初に選べる行は使えない行を飛ばす', () => {
    expect(firstUsableUri(filterCwdRows(rows, 'o'))).toBe(`${HOME}/src/MyBox`)
    expect(firstUsableUri(filterCwdRows(rows, 'opt'))).toBeNull()
    expect(firstUsableUri([])).toBeNull()
  })

  it('↑↓ は「所属なし」→ 見えている行を巡回し、使えない行を飛ばす', () => {
    expect(cwdKeyStep('ArrowDown', SCRATCH_CHOICE, rows)).toBe(`${HOME}/src/MyBox`)
    expect(cwdKeyStep('ArrowDown', `${HOME}/src/MyBox`, rows)).toBe(`${HOME}/src/other`)
    expect(cwdKeyStep('ArrowUp', `${HOME}/src/other`, rows)).toBe(`${HOME}/src/MyBox`)
    // From the end (home), ↓ cycles to the unassigned choice.
    expect(cwdKeyStep('ArrowDown', HOME, rows)).toBe(SCRATCH_CHOICE)
    expect(cwdKeyStep('ArrowUp', SCRATCH_CHOICE, rows)).toBe(HOME)
  })

  it('選択が絞り込みで隠れていたら ↓ は先頭 (所属なし)、Home / End と他のキーは扱わない', () => {
    const visible = filterCwdRows(rows, 'other')
    expect(cwdKeyStep('ArrowDown', `${HOME}/src/MyBox`, visible)).toBe(SCRATCH_CHOICE)
    expect(cwdKeyStep('Home', SCRATCH_CHOICE, visible)).toBeNull()
    expect(cwdKeyStep('a', SCRATCH_CHOICE, visible)).toBeNull()
  })

  it('一致 0 件でも「所属なし」は残るので ↑↓ はそこに留まる', () => {
    expect(cwdKeyStep('ArrowDown', SCRATCH_CHOICE, [])).toBe(SCRATCH_CHOICE)
  })
})

describe('辞書 (TODO 462)', () => {
  const dicts = [en, ja] as Record<string, string>[]

  it('回数・「+ New conversation」・フォルダの会話の説明文の鍵は EN / JA の両方から消えている', () => {
    for (const dict of dicts) {
      for (const key of [
        'cwd.useCount',
        'newThread.transcript.newConversation',
        'newThread.transcript.folderHint'
      ]) {
        expect(dict[key]).toBeUndefined()
      }
    }
  })

  it('絞り込みの欄と「一致なし」は EN / JA の両方にある', () => {
    for (const dict of dicts) {
      expect(dict['newThread.cwd.filter']).toBeTruthy()
      expect(dict['newThread.cwd.noMatch']).toBeTruthy()
    }
  })
})
