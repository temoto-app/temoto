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

describe('cwdRows (item 153)', () => {
  it('history rows are full paths and a path under home is folded to ~', () => {
    const rows = cwdRows([entry(`${HOME}/git/mybox`), entry('file:///opt/work')], HOME, null)
    expect(rows.map((r) => r.path)).toEqual(['~/git/mybox', '/opt/work', '~'])
  })

  it('does not append home at the end when it is in the history (order stays as in the history)', () => {
    const rows = cwdRows([entry(HOME), entry(`${HOME}/a`)], HOME, null)
    expect(rows.map((r) => r.path)).toEqual(['~', '~/a'])
    expect(rows[0]?.entry.useCount).toBe(2)
  })

  it('adds home, when not in the history, as a usable pseudo entry', () => {
    const [home] = cwdRows([], HOME, null)
    expect(home?.path).toBe('~')
    expect(home?.entry).toMatchObject({ uri: HOME, usable: true, useCount: 0, reason: null })
  })

  it('adds the folder chosen with Open Folder… at the top only when it is in neither the history nor home (TODO 462)', () => {
    const picked = bareCwdEntry(`${HOME}/new`, 5)
    expect(cwdRows([], HOME, picked).map((r) => r.path)).toEqual(['~/new', '~'])
    expect(cwdRows([entry('file:///opt/a')], HOME, picked).map((r) => r.path)).toEqual(['~/new', '/opt/a', '~'])
    expect(cwdRows([entry(`${HOME}/new`)], HOME, picked).map((r) => r.path)).toEqual(['~/new', '~'])
    expect(cwdRows([], HOME, bareCwdEntry(HOME)).map((r) => r.path)).toEqual(['~'])
  })

  it('restores encoded names for display (spaces, Japanese)', () => {
    const rows = cwdRows([entry(`${HOME}/My%20Docs/%E8%B3%87%E6%96%99`)], HOME, null)
    expect(rows[0]?.path).toBe('~/My Docs/資料')
  })

  it('does not fold a neighboring folder that only shares a prefix with home into ~', () => {
    const rows = cwdRows([entry('file:///Users/meow/x')], HOME, null)
    expect(rows[0]?.path).toBe('/Users/meow/x')
  })

  it('bareCwdEntry uses the end of the URI as the name', () => {
    expect(bareCwdEntry(`${HOME}/git/%E4%BD%9C%E6%A5%AD/`)).toMatchObject({ name: '作業', parentName: '' })
  })
})

describe('dictionary (items 148 / 150 / 153)', () => {
  const dicts = [en, ja] as Record<string, string>[]

  it('the keys for strict mode and its description are gone from both EN and JA', () => {
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

  it('the description of the scratch area remains for the tooltip', () => {
    for (const dict of dicts) expect(dict['newThread.cwd.scratchHint']).toBeTruthy()
  })

  it('the button and dotted-frame wording is English even in the Japanese display (owner decision)', () => {
    for (const dict of dicts) {
      expect(dict['newThread.cwd.pick']).toBe('Open Folder…')
      // TODO 462: "Continue" on row hover is also in English.
      expect(dict['newThread.transcript.rowContinue']).toBe('Continue')
      expect(dict['newThread.dropZone']).toBe('Drag a folder here')
    }
  })

  // TODO 742: removed the Cancel / + New at the bottom right (pressing a row, or Enter, creates the thread as it is).
  it('the lower-right Cancel / + New keys are gone from both EN and JA', () => {
    for (const dict of dicts) {
      expect(dict['newThread.create']).toBeUndefined()
      expect(dict['newThread.cancel']).toBeUndefined()
    }
  })

  it("the settings screen's default description does not say it can be changed in the dialog (item 148; became a per-item description in item 187)", () => {
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

describe('filtering and ↑↓ (TODO 462)', () => {
  const rows = cwdRows(
    [
      entry(`${HOME}/src/MyBox`),
      entry('file:///opt/gone', { usable: false, reason: 'cwd-not-found' }),
      entry(`${HOME}/src/other`)
    ],
    HOME,
    null
  )

  it('matches part of the displayed path (kept in ~ notation), case-insensitively', () => {
    expect(filterCwdRows(rows, 'mybox').map((r) => r.path)).toEqual(['~/src/MyBox'])
    expect(filterCwdRows(rows, '~/SRC').map((r) => r.path)).toEqual(['~/src/MyBox', '~/src/other'])
    // Does not match the real home path (narrowed by the ~ notation).
    expect(filterCwdRows(rows, '/Users/me')).toEqual([])
    expect(filterCwdRows(rows, 'zzz')).toEqual([])
  })

  it('does not filter on an empty or whitespace-only term', () => {
    expect(filterCwdRows(rows, '')).toBe(rows)
    expect(filterCwdRows(rows, '   ')).toBe(rows)
  })

  it('the first selectable row skips unusable rows', () => {
    expect(firstUsableUri(filterCwdRows(rows, 'o'))).toBe(`${HOME}/src/MyBox`)
    expect(firstUsableUri(filterCwdRows(rows, 'opt'))).toBeNull()
    expect(firstUsableUri([])).toBeNull()
  })

  it('↑↓ cycle through 「所属なし」 and the visible rows, skipping unusable rows', () => {
    expect(cwdKeyStep('ArrowDown', SCRATCH_CHOICE, rows)).toBe(`${HOME}/src/MyBox`)
    expect(cwdKeyStep('ArrowDown', `${HOME}/src/MyBox`, rows)).toBe(`${HOME}/src/other`)
    expect(cwdKeyStep('ArrowUp', `${HOME}/src/other`, rows)).toBe(`${HOME}/src/MyBox`)
    // From the end (home), ↓ cycles to the unassigned choice.
    expect(cwdKeyStep('ArrowDown', HOME, rows)).toBe(SCRATCH_CHOICE)
    expect(cwdKeyStep('ArrowUp', SCRATCH_CHOICE, rows)).toBe(HOME)
  })

  it('when the selection is hidden by filtering, ↓ goes to the first row (no owner); Home / End and other keys are not handled', () => {
    const visible = filterCwdRows(rows, 'other')
    expect(cwdKeyStep('ArrowDown', `${HOME}/src/MyBox`, visible)).toBe(SCRATCH_CHOICE)
    expect(cwdKeyStep('Home', SCRATCH_CHOICE, visible)).toBeNull()
    expect(cwdKeyStep('a', SCRATCH_CHOICE, visible)).toBeNull()
  })

  it('with 0 matches 「所属なし」 remains, so ↑↓ stay there', () => {
    expect(cwdKeyStep('ArrowDown', SCRATCH_CHOICE, [])).toBe(SCRATCH_CHOICE)
  })
})

describe('dictionary (TODO 462)', () => {
  const dicts = [en, ja] as Record<string, string>[]

  it("the keys for counts, 「+ New conversation」 and the folder's conversation description are gone from both EN and JA", () => {
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

  it('the filter field and 「一致なし」 exist in both EN and JA', () => {
    for (const dict of dicts) {
      expect(dict['newThread.cwd.filter']).toBeTruthy()
      expect(dict['newThread.cwd.noMatch']).toBeTruthy()
    }
  })
})
