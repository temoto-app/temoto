// @vitest-environment jsdom
/**
 * TODO 1212 stage 1 / stage 2: editing cell values and formulas on the viewer side of `aios.office`. The facts of the book that a refusal is based on (formula references),
 * the editing state (undoing removes it from the column, undo / redo, narrowing on restore), and the stale-value mark. Does not go through DOM rendering or the bridge.
 * Also looks at the draft base on the host side (`draftBaseOf`).
 */
import { describe, expect, it } from 'vitest'
import { readWorkbook, cellLockOf } from '../plugins/aios.office/viewer/workbook.js'
import {
  EMPTY_EDIT_STATE,
  applyEdit,
  displayRows,
  formulaCellsOf,
  inputTextAt,
  isUncomputed,
  originalFormulaAt,
  redoEdit,
  staleKeys,
  undoEdit,
  usableEdits
} from '../plugins/aios.office/viewer/cell-edit.js'
import { formulaCellKey, type CellEdit } from '../src/shared/xlsx-cells.js'
import { draftBaseOf, restoreDraft, syncDraft } from '../src/renderer/src/viewer-drafts.js'
import { PIVOT_REL, TABLE_REL, makeXlsx } from './helpers/xlsx.js'

const S1 = 'xl/worksheets/sheet1.xml'

function sampleBook(extra: { signed?: boolean; signedMacro?: boolean } = {}) {
  return readWorkbook(
    makeXlsx({
      sheets: [
        {
          name: 'Data',
          body:
            '<sheetData>' +
            '<row r="1"><c r="A1"><v>2</v></c><c r="B1"><v>3</v></c><c r="C1"><f t="shared" ref="C1:C2" si="0">A1*B1</f><v>6</v></c></row>' +
            '<row r="2"><c r="A2"><v>4</v></c><c r="B2"><v>5</v></c><c r="C2"><f t="shared" si="0"/><v>20</v></c><c r="D2" s="1"><v>46299</v></c></row>' +
            '<row r="3"><c r="A3"><f>SUM(C1:C2)</f><v>26</v></c><c r="B3"><f t="array" ref="B3:B4">A1:A2*2</f><v>4</v></c></row>' +
            '</sheetData><mergeCells count="1"><mergeCell ref="E1:F2"/></mergeCells>',
          rels: TABLE_REL('../tables/table1.xml') + PIVOT_REL('../pivotTables/p1.xml')
        },
        { name: 'Other', body: '<sheetData><row r="1"><c r="A1"><f>Data!A3+1</f><v>27</v></c></row></sheetData>' }
      ],
      parts: {
        'xl/tables/table1.xml': '<table xmlns="x" ref="H1:I5"/>',
        'xl/pivotTables/p1.xml': '<pivotTableDefinition xmlns="x"><location ref="K1:L3"/></pivotTableDefinition>',
        ...(extra.signed === true ? { '_xmlsignatures/sig1.xml': '<s/>' } : {}),
        ...(extra.signedMacro === true ? { 'xl/vbaProject.bin': new Uint8Array([2]), 'xl/vbaProjectSignature.bin': new Uint8Array([1]) } : {})
      }
    })
  )
}

describe('ブックの事実と断る理由', () => {
  it('共有数式の親と子・配列・結合・テーブルの見出し・ピボット (共有でない数式は編集できる、段 2)', () => {
    const book = sampleBook()
    const facts = book.sheets[0]?.facts
    if (facts === undefined) throw new Error('sheet')
    expect(book.sheets[0]?.path).toBe(S1)
    expect(book.signature).toBeNull()
    expect(book.sheetNames).toEqual(['Data', 'Other'])
    const lock = (row: number, col: number) => cellLockOf(book, facts, row, col)
    expect(lock(0, 0)).toBeNull()
    expect(lock(0, 2)).toBe('sharedFormula')
    expect(lock(1, 2)).toBe('sharedFormula')
    expect(lock(2, 0)).toBeNull()
    expect(lock(2, 1)).toBe('arrayFormula')
    expect(lock(3, 1)).toBe('arrayFormula')
    expect(lock(0, 4)).toBeNull()
    expect(lock(1, 5)).toBe('merged')
    expect(lock(0, 8)).toBe('tableHeader')
    expect(lock(1, 8)).toBeNull()
    expect(lock(2, 11)).toBe('pivot')
    expect(cellLockOf(sampleBook({ signed: true }), facts, 0, 0)).toBe('signed')
    expect(cellLockOf(sampleBook({ signedMacro: true }), facts, 0, 0)).toBe('signedMacro')
  })

  it('値を変えると共有数式の子・それを集計する数式・別のシートの参照が古い値になる', () => {
    const book = sampleBook()
    const formulas = formulaCellsOf(book)
    const stale = staleKeys(book, formulas, [{ sheet: S1, ref: 'B2', value: { t: 'n', v: 9 } }])
    expect([...stale].sort()).toEqual(
      [formulaCellKey('Data', 1, 2), formulaCellKey('Data', 2, 0), formulaCellKey('Other', 0, 0)].sort()
    )
    // C1 does not depend on B2 (the reference of a shared formula's child is shifted from its parent).
    expect(stale.has(formulaCellKey('Data', 0, 2))).toBe(false)
  })
})

describe('編集の状態', () => {
  const book = sampleBook()
  const sheet = book.sheets[0]
  if (sheet === undefined) throw new Error('sheet')
  const edit = (ref: string, value: CellEdit['value']): CellEdit => ({ sheet: S1, ref, value })

  it('元の値に戻した編集は列から消え、undo / redo で行き来する', () => {
    let state = applyEdit(EMPTY_EDIT_STATE, edit('A1', { t: 'n', v: 7 }), 2, false)
    expect(state.edits).toEqual([edit('A1', { t: 'n', v: 7 })])
    state = applyEdit(state, edit('A1', { t: 'n', v: 2 }), 2, false)
    expect(state.edits).toEqual([])
    state = undoEdit(state)
    expect(state.edits).toEqual([edit('A1', { t: 'n', v: 7 })])
    state = redoEdit(state)
    expect(state.edits).toEqual([])
    // Writing only the same value as the original adds nothing.
    expect(applyEdit(EMPTY_EDIT_STATE, edit('A1', { t: 'n', v: 2 }), 2, false)).toBe(EMPTY_EDIT_STATE)
  })

  it('日付のセルの数は日付として出し、元と同じ通し番号なら編集でない', () => {
    const original = sheet.rows[1]?.[3]
    expect(original).toBeInstanceOf(Date)
    expect(applyEdit(EMPTY_EDIT_STATE, edit('D2', { t: 'n', v: 46299 }), original ?? null, false)).toBe(EMPTY_EDIT_STATE)
    const rows = displayRows(sheet, [edit('D2', { t: 'n', v: 46300 }), edit('G9', { t: 's', v: 'new' })], false)
    expect(rows[1]?.[3]).toBeInstanceOf(Date)
    expect(rows[8]?.[6]).toBe('new')
    // The original table is not changed.
    expect(sheet.rows[8]).toBeUndefined()
  })

  it('復元した下書きは、このブックで書ける編集だけに絞る', () => {
    const kept = usableEdits(book, [
      edit('A1', { t: 'n', v: 1 }),
      edit('C1', { t: 'n', v: 1 }),
      { sheet: 'xl/worksheets/sheet9.xml', ref: 'A1', value: { t: 'n', v: 1 } }
    ])
    expect(kept).toEqual([edit('A1', { t: 'n', v: 1 })])
  })
})

describe('数式の編集 (TODO 1212 段 2)', () => {
  const book = sampleBook()
  const sheet = book.sheets[0]
  if (sheet === undefined) throw new Error('sheet')
  const edit = (ref: string, value: CellEdit['value']): CellEdit => ({ sheet: S1, ref, value })

  it('入力欄は数式のセルなら = + 式、編集した式は画面の形 (_xlfn. を外す)', () => {
    expect(inputTextAt(sheet, [], 2, 0, false)).toBe('=SUM(C1:C2)')
    expect(inputTextAt(sheet, [], 0, 0, false)).toBe('2')
    expect(inputTextAt(sheet, [edit('A1', { t: 'f', v: '_xlfn.IFS(B1>1,1,TRUE,0)' })], 0, 0, false)).toBe('=IFS(B1>1,1,TRUE,0)')
    expect(displayRows(sheet, [edit('A1', { t: 'f', v: 'B1*2' })], false)[0]?.[0]).toBe('=B1*2')
  })

  it('数式のセルは同じ式に戻したときだけ元どおり。キャッシュ値と同じ値を打つのは式を値に変える編集', () => {
    const original = sheet.rows[2]?.[0] ?? null
    const formula = originalFormulaAt(sheet, 2, 0)
    expect(formula).toBe('SUM(C1:C2)')
    expect(original).toBe(26)
    const toValue = applyEdit(EMPTY_EDIT_STATE, edit('A3', { t: 'n', v: 26 }), original, false, formula)
    expect(toValue.edits).toEqual([edit('A3', { t: 'n', v: 26 })])
    expect(applyEdit(toValue, edit('A3', { t: 'f', v: 'SUM(C1:C2)' }), original, false, formula).edits).toEqual([])
    // Turning a value cell into a formula is always an edit.
    expect(applyEdit(EMPTY_EDIT_STATE, edit('A1', { t: 'f', v: '2' }), 2, false).edits).toHaveLength(1)
  })

  it('式にしたセル自身と依存のセルは古い値、式を値にしたセルは印を外す', () => {
    const formulas = formulaCellsOf(book)
    const stale = staleKeys(book, formulas, [edit('B1', { t: 'f', v: '7' })])
    // B1 itself (holds no value), and C1 which depends on B1 (the parent of a shared formula) → A3 → Other!A1.
    expect(stale.has(formulaCellKey('Data', 0, 1))).toBe(true)
    expect(stale.has(formulaCellKey('Data', 0, 2))).toBe(true)
    expect(stale.has(formulaCellKey('Other', 0, 0))).toBe(true)
    const toValue = staleKeys(book, formulas, [edit('A3', { t: 'n', v: 1 })])
    expect(toValue.has(formulaCellKey('Data', 2, 0))).toBe(false)
    expect(toValue.has(formulaCellKey('Other', 0, 0))).toBe(true)
  })

  it('キャッシュ値の無い数式は式を出し「未計算」、復元では知らないシートを参照する式を落とす', () => {
    const uncomputed = readWorkbook(
      makeXlsx({ sheets: [{ name: 'S', body: '<sheetData><row r="1"><c r="A1"><f>_xlfn.CONCAT("a","b")</f></c><c r="B1"><f>1+1</f><v>2</v></c></row></sheetData>' }] })
    )
    const s = uncomputed.sheets[0]
    if (s === undefined) throw new Error('sheet')
    expect(s.rows[0]?.[0]).toBe('=CONCAT("a","b")')
    expect(isUncomputed(s, [], 0, 0)).toBe(true)
    expect(isUncomputed(s, [], 0, 1)).toBe(false)
    expect(isUncomputed(s, [{ sheet: S1, ref: 'A1', value: { t: 'n', v: 1 } }], 0, 0)).toBe(false)
    expect(
      usableEdits(book, [edit('A1', { t: 'f', v: 'Other!A1' }), edit('B1', { t: 'f', v: 'Gone!A1' })])
    ).toEqual([edit('A1', { t: 'f', v: 'Other!A1' })])
  })
})

describe('host の下書きの土台 (draftBaseOf)', () => {
  const xlsx = { kind: 'binary' as const, resourceUrl: 'aios-res://local/t/x.xlsx?m=1', size: 10, mtimeMs: 1, cellEdits: true }
  it('セルの値を受ける .xlsx は空文字列、ふつうのバイナリは null', () => {
    expect(draftBaseOf(xlsx)).toBe('')
    expect(draftBaseOf({ ...xlsx, cellEdits: undefined })).toBeNull()
    expect(draftBaseOf({ kind: 'text', text: 'a', truncated: false, size: 1, mtimeMs: 1 })).toBe('a')
    expect(draftBaseOf({ kind: 'text', text: 'a', truncated: true, size: 1, mtimeMs: 1 })).toBeNull()
  })

  it('覚え・復元・衝突はテキストと同じ道を通る', () => {
    expect(syncDraft('{"x":1}', xlsx)).toEqual({ kind: 'remember', draft: { text: '{"x":1}', baseMtimeMs: 1 } })
    expect(syncDraft('', xlsx)).toEqual({ kind: 'forget' })
    expect(restoreDraft({ text: '{"x":1}', baseMtimeMs: 1 }, xlsx)).toMatchObject({ draft: '{"x":1}', conflict: false })
    const changed = restoreDraft({ text: '{"x":1}', baseMtimeMs: 1 }, { ...xlsx, mtimeMs: 2 })
    expect(changed).toMatchObject({ draft: '{"x":1}', conflict: true })
    expect(changed.resource.kind === 'binary' && changed.resource.mtimeMs).toBe(1)
    expect(restoreDraft({ text: '', baseMtimeMs: 1 }, xlsx).forget).toBe(true)
  })
})
