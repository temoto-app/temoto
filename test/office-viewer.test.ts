// @vitest-environment jsdom
/**
 * Conversion and table range of `aios.office` (TODO 405 (4), wave 21 bundle H).
 *
 * The real .docx / .xlsx (`test/fixtures/office/`, hand-written minimal OOXML made by `make-fixtures.mjs`) go through mammoth → DOMPurify / fflate + DOMParser.
 * DOM rendering and the bridge are not used (they cannot run outside the iframe).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { MAX_OFFICE_BYTES, convertDocxInput, officeKindOf, readWorkbook } from '../plugins/aios.office/viewer/office.js'
import {
  WorkbookError,
  excelSerialToDate,
  isDateFormatCode,
  parseCellRef,
  resolvePart
} from '../plugins/aios.office/viewer/workbook.js'
import {
  COLUMN_STEP,
  INITIAL_COLUMNS,
  INITIAL_ROWS,
  ROW_STEP,
  columnLabel,
  formatCell,
  growColumns,
  growRows,
  initialWindow,
  isNumericCell,
  moreColumns,
  moreRows,
  sheetExtent
} from '../plugins/_shared/sheet.js'

const fixtures = join(process.cwd(), 'test/fixtures/office')

function fixture(name: string): ArrayBuffer {
  const buf = readFileSync(join(fixtures, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

describe('officeKindOf', () => {
  it('docx / xlsx だけを名乗る (大文字・クエリも)', () => {
    expect(officeKindOf('file:///a/b/report.docx')).toBe('docx')
    expect(officeKindOf('file:///a/b/BOOK.XLSX')).toBe('xlsx')
    expect(officeKindOf('file:///a/b/c.xlsx?x=1#y')).toBe('xlsx')
    // With macros (TODO 1212 stage 2) it is a table, the same as xlsx.
    expect(officeKindOf('file:///a/b/Macro.XLSM')).toBe('xlsx')
    expect(officeKindOf('file:///a/b/bin.xlsb')).toBeNull()
    expect(officeKindOf('file:///a/b/old.doc')).toBeNull()
    expect(officeKindOf('file:///a/b/old.xls')).toBeNull()
    expect(officeKindOf('file:///a/b/deck.pptx')).toBeNull()
    expect(officeKindOf('file:///a/b.docx/noext')).toBeNull()
  })

  it('上限は 32 MB', () => {
    expect(MAX_OFFICE_BYTES).toBe(32 * 1024 * 1024)
  })
})

/** In Node the Node build of mammoth is read, so it is passed as `{ buffer }` (the viewer's bundle uses the browser build's `{ arrayBuffer }`). */
function docx(): ReturnType<typeof convertDocxInput> {
  return convertDocxInput({ buffer: readFileSync(join(fixtures, 'sample.docx')) })
}

describe('convertDocx (mammoth → DOMPurify)', () => {
  it('見出し・太字・表・画像 (data URL) を HTML にする', async () => {
    const { html } = await docx()
    expect(html).toContain('<h1>見出しの段落</h1>')
    expect(html).toContain('<strong>太字</strong>')
    expect(html).toContain('<td><p>A1</p></td>')
    expect(html).toMatch(/<img [^>]*src="data:image\/png;base64,/)
  })

  it('文書の中の <script> は文字のまま (要素にならない)', async () => {
    const { html } = await docx()
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    const box = document.createElement('div')
    box.innerHTML = html
    expect(box.querySelector('script')).toBeNull()
  })

  it('https のリンクは残し、javascript: の href は DOMPurify が落とす', async () => {
    const { html } = await docx()
    const box = document.createElement('div')
    box.innerHTML = html
    const hrefs = Array.from(box.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('https://example.com/')
    expect(hrefs.some((h) => h !== null && h.toLowerCase().startsWith('javascript:'))).toBe(false)
  })

  it('zip でないバイト列は reject する (viewer は「開けません」を出す)', async () => {
    await expect(convertDocxInput({ buffer: Buffer.from('not a zip') })).rejects.toThrow()
  })
})

describe('readWorkbook (fflate の同期展開 + DOMParser)', () => {
  it('隠しシートを除いた順にシートを返す', async () => {
    const book = await readWorkbook(fixture('sample.xlsx'))
    expect(book.sheets.map((s) => s.name)).toEqual(['一覧', 'Empty'])
    expect(book.sheets[1]?.rows).toEqual([])
  })

  it('共有文字列 (ふりがなを除く)・インライン・数値・日付・真偽・エラー・数式の値', async () => {
    const book = await readWorkbook(fixture('sample.xlsx'))
    const rows = book.sheets[0]?.rows ?? []
    expect(rows[0]).toEqual(['名前', 'インライン', null, ' 前後に空白 '])
    expect(rows[1]?.[0]).toBe('東京都')
    expect(rows[1]?.[1]).toBe(42)
    expect(formatCell(rows[1]?.[2])).toBe('0.3')
    expect(rows[2]).toEqual([])
    expect(formatCell(rows[3]?.[0])).toBe('2026-10-04')
    expect(formatCell(rows[3]?.[1])).toBe('2026-10-04 12:00')
    // `0.00"m"` does not count the m inside the quotes → it stays a number.
    expect(rows[3]?.[2]).toBe(1.5)
    // Only the time: 0.75 with format 20 (h:mm).
    expect(formatCell(rows[3]?.[3])).toBe('18:00')
    expect(rows[4]?.slice(0, 3)).toEqual([true, '#DIV/0!', '名前x'])
    expect(sheetExtent(rows)).toEqual({ rows: 5, columns: 4 })
  })

  it('zip でない・workbook の無い zip は WorkbookError', async () => {
    await expect(readWorkbook(strToU8('nope').buffer as ArrayBuffer)).rejects.toBeInstanceOf(WorkbookError)
    const empty = zipSync({ 'a.xml': strToU8('<a/>') })
    await expect(readWorkbook(empty.buffer as ArrayBuffer)).rejects.toThrow('no-workbook')
  })

  it('名乗る大きさが上限を超える部品は展開しない (zip bomb)', async () => {
    // fflate passes the central directory's originalSize to the filter. A large XML filled with zeros shrinks to tens of KB.
    const big = new Uint8Array(129 * 1024 * 1024)
    const bomb = zipSync({ 'xl/worksheets/sheet1.xml': big }, { level: 1 })
    await expect(readWorkbook(bomb.buffer as ArrayBuffer)).rejects.toThrow('part-too-large')
  }, 30_000)
})

describe('workbook の小さな部品', () => {
  it('resolvePart は相対・絶対の target を zip の中のパスにする', () => {
    expect(resolvePart('xl/workbook.xml', 'worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml')
    expect(resolvePart('xl/workbook.xml', '/xl/worksheets/sheet2.xml')).toBe('xl/worksheets/sheet2.xml')
    expect(resolvePart('xl/workbook.xml', '../docProps/app.xml')).toBe('docProps/app.xml')
    expect(resolvePart('', 'xl/workbook.xml')).toBe('xl/workbook.xml')
  })

  it('parseCellRef', () => {
    expect(parseCellRef('A1')).toEqual({ row: 0, col: 0 })
    expect(parseCellRef('AB12')).toEqual({ row: 11, col: 27 })
    expect(parseCellRef('$C$3')).toEqual({ row: 2, col: 2 })
    expect(parseCellRef('1A')).toBeNull()
  })

  it('isDateFormatCode', () => {
    expect(isDateFormatCode('yyyy/mm/dd')).toBe(true)
    expect(isDateFormatCode('[$-411]ggge"年"m"月"d"日"')).toBe(true)
    expect(isDateFormatCode('[h]:mm:ss')).toBe(true)
    expect(isDateFormatCode('0.00"m"')).toBe(false)
    expect(isDateFormatCode('[Red]#,##0;[Blue]-#,##0')).toBe(false)
    expect(isDateFormatCode('#,##0\\ "円"')).toBe(false)
    expect(isDateFormatCode('General')).toBe(false)
  })

  it('excelSerialToDate は 1900 / 1904 方式', () => {
    expect(excelSerialToDate(46299, false).toISOString()).toBe('2026-10-04T00:00:00.000Z')
    expect(excelSerialToDate(46299 - 1462, true).toISOString()).toBe('2026-10-04T00:00:00.000Z')
    expect(excelSerialToDate(1 / 3, false).toISOString()).toBe('1899-12-30T08:00:00.000Z')
  })
})

describe('sheet: 大きなシートの描く範囲', () => {
  it('最初は INITIAL_ROWS × INITIAL_COLUMNS まで、続きは STEP ずつ', () => {
    let view = initialWindow({ rows: 2000, columns: 120 })
    expect([view.shownRows, view.shownColumns]).toEqual([INITIAL_ROWS, INITIAL_COLUMNS])
    expect(moreRows(view)).toBe(ROW_STEP)
    view = growRows(view)
    expect(view.shownRows).toBe(INITIAL_ROWS + ROW_STEP)
    view = growColumns(growColumns(view))
    expect(view.shownColumns).toBe(120)
    expect(moreColumns(view)).toBe(0)
    while (moreRows(view) > 0) view = growRows(view)
    expect(view.shownRows).toBe(2000)
    expect(COLUMN_STEP).toBeGreaterThan(0)
  })

  it('小さなシートは全部', () => {
    const view = initialWindow({ rows: 3, columns: 2 })
    expect([view.shownRows, view.shownColumns, moreRows(view), moreColumns(view)]).toEqual([3, 2, 0, 0])
  })

  it('sheetExtent は末尾の空の行・列を数えない', () => {
    expect(sheetExtent([['a', null, ''], [], [null, 1], [], ['']])).toEqual({ rows: 3, columns: 2 })
    expect(sheetExtent([])).toEqual({ rows: 0, columns: 0 })
  })

  it('columnLabel', () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnLabel)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA'])
  })

  it('formatCell / isNumericCell', () => {
    expect(formatCell(null)).toBe('')
    expect(formatCell(true)).toBe('TRUE')
    expect(formatCell(0.1 + 0.2)).toBe('0.3')
    expect(formatCell(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02 03:04:05')
    expect(isNumericCell(3)).toBe(true)
    expect(isNumericCell(new Date(0))).toBe(true)
    expect(isNumericCell('3')).toBe(false)
  })
})
