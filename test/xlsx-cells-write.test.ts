// @vitest-environment jsdom
/**
 * TODO 1212 stage 1 / stage 2: our own diff rewrite of `.xlsx` / `.xlsm` cell values and formulas (`src/main/capability/xlsx-cells-write.ts` + `zip-rewrite.ts`).
 *
 * - **The bytes of the parts not rewritten stay the same** (the local item headers and the compressed data remain as they were): the 'round-trip test' of the owner decision 2026-11-13.
 *   Whether real Excel opens it without repair is confirmed on the owner's real machine (it cannot be checked here).
 * - the written result can be read by the viewer's reader (`readWorkbook`, DOMParser), and the values have changed.
 * - the reasons to refuse (formulas, merges, arrays, table headers, pivots, protection, signatures, rich values) throw without writing anything.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { readWorkbook } from '../plugins/aios.office/viewer/workbook.js'
import { applyCellEdits, encodeCellText, patchWorkbookXml, XlsxCellsError } from '../src/main/capability/xlsx-cells-write.js'
import { readEntry, readZip, rewriteZip } from '../src/main/capability/zip-rewrite.js'
import { PIVOT_REL, TABLE_REL, makeXlsx } from './helpers/xlsx.js'
import type { CellEdit, CellValue } from '../src/shared/xlsx-cells.js'

const S1 = 'xl/worksheets/sheet1.xml'
const edit = (ref: string, value: CellValue, sheet = S1): CellEdit => ({ sheet, ref, value })

function rawLocalRecords(bytes: Buffer): Map<string, Buffer> {
  const zip = readZip(bytes)
  const out = new Map<string, Buffer>()
  for (const entry of zip.entries) {
    const start = entry.localOffset
    const nameLen = bytes.readUInt16LE(start + 26)
    const extraLen = bytes.readUInt16LE(start + 28)
    out.set(entry.name, bytes.subarray(start, start + 30 + nameLen + extraLen + entry.compressedSize))
  }
  return out
}

async function partText(bytes: Buffer, name: string): Promise<string> {
  const zip = readZip(bytes)
  const entry = zip.entries.find((e) => e.name === name)
  if (entry === undefined) throw new Error(`no ${name}`)
  return (await readEntry(zip, entry, 1 << 26)).toString('utf8')
}

const BODY =
  '<dimension ref="A1:D3"/><cols><col min="5" max="5" width="9" style="2" customWidth="1"/></cols>' +
  '<sheetData>' +
  '<row r="1" spans="1:4"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>46299</v></c><c r="D1"><v>3</v></c></row>' +
  '<row r="3" s="2" customFormat="1"><c r="A3"><v>7</v></c><c r="C3"><f>A3*2</f><v>14</v></c></row>' +
  '</sheetData><mergeCells count="1"><mergeCell ref="A5:B6"/></mergeCells>'

function book(level: 0 | 6 = 6): Buffer {
  return Buffer.from(
    makeXlsx({
      sheets: [{ name: 'Data', body: BODY }, { name: 'Two', body: '<sheetData/>' }],
      sharedStrings: ['名前'],
      parts: { 'xl/media/image1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), 'customXml/item1.xml': '<x/>' },
      level
    })
  )
}

describe('applyCellEdits (差分の書き換え)', () => {
  it('書き換えたシートと workbook.xml 以外のローカルの項目はバイト列が同じ', async () => {
    for (const level of [0, 6] as const) {
      const before = book(level)
      const after = await applyCellEdits(before, [edit('A1', { t: 's', v: '東京' })])
      const a = rawLocalRecords(before)
      const b = rawLocalRecords(after)
      expect([...b.keys()]).toEqual([...a.keys()])
      for (const [name, raw] of a) {
        if (name === S1 || name === 'xl/workbook.xml') continue
        expect(Buffer.compare(raw, b.get(name) ?? Buffer.alloc(0)), name).toBe(0)
      }
      expect(Buffer.compare(a.get(S1) ?? Buffer.alloc(0), b.get(S1) ?? Buffer.alloc(0))).not.toBe(0)
    }
  })

  it('値を書き、書式 s を残し、文字列は inlineStr、viewer の読み取りで読める', async () => {
    const after = await applyCellEdits(book(), [
      edit('A1', { t: 's', v: 'a < b & "c"' }),
      edit('B1', { t: 'n', v: 46300 }),
      edit('D1', { t: 'b', v: false }),
      edit('A3', { t: 'empty' })
    ])
    const xml = await partText(after, S1)
    expect(xml).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">a &lt; b &amp; "c"</t></is></c>')
    expect(xml).toContain('<c r="B1" s="1"><v>46300</v></c>')
    expect(xml).toContain('<c r="D1" t="b"><v>0</v></c>')
    expect(xml).toContain('<c r="A3"/>')
    // Untouched formula cells stay as they are.
    expect(xml).toContain('<c r="C3"><f>A3*2</f><v>14</v></c>')
    const wb = await partText(after, 'xl/workbook.xml')
    expect(wb).toContain('<calcPr fullCalcOnLoad="1"/></workbook>')
    const read = readWorkbook(after)
    expect(read.sheets[0]?.rows[0]?.[0]).toBe('a < b & "c"')
    expect(read.sheets[0]?.rows[0]?.[3]).toBe(false)
  })

  it('空のセル・無い行へは列の順・行の順に挿し、書式を引き継ぎ、dimension と spans を広げる', async () => {
    const after = await applyCellEdits(book(), [
      edit('C1', { t: 'n', v: 1 }),
      edit('F1', { t: 'n', v: 2 }),
      edit('B3', { t: 'n', v: 3 }),
      edit('E2', { t: 'n', v: 4 }),
      edit('A9', { t: 's', v: 'end' }),
      edit('Z9', { t: 'empty' })
    ])
    const xml = await partText(after, S1)
    expect(xml).toContain('<dimension ref="A1:F9"/>')
    expect(xml).toContain(
      '<row r="1" spans="1:6"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>46299</v></c><c r="C1"><v>1</v></c><c r="D1"><v>3</v></c><c r="F1"><v>2</v></c></row>'
    )
    // Inherits the row's format (customFormat).
    expect(xml).toContain('<row r="3" s="2" customFormat="1"><c r="A3"><v>7</v></c><c r="B3" s="2"><v>3</v></c>')
    // A new row that inherits the column format (the style of column E).
    expect(xml).toContain('</row><row r="2"><c r="E2" s="2"><v>4</v></c></row><row r="3"')
    // An edit that empties a cell that does not exist adds nothing.
    expect(xml).toContain('<row r="9"><c r="A9" t="inlineStr">')
    expect(xml).not.toContain('Z9')
    const rows = readWorkbook(after).sheets[0]?.rows ?? []
    expect(rows[1]?.[4]).toBe(4)
    expect(rows[8]?.[0]).toBe('end')
  })

  it('自己終了の sheetData にも書ける', async () => {
    const after = await applyCellEdits(book(), [edit('B2', { t: 'n', v: 5 }, 'xl/worksheets/sheet2.xml')])
    const xml = await partText(after, 'xl/worksheets/sheet2.xml')
    expect(xml).toContain('<sheetData><row r="2"><c r="B2"><v>5</v></c></row></sheetData>')
  })

  it('断る理由に当たれば何も書かずに locked', async () => {
    const reject = async (bytes: Buffer, e: CellEdit, detail: string): Promise<void> => {
      const err = await applyCellEdits(bytes, [e]).catch((x: unknown) => x)
      expect(err).toBeInstanceOf(XlsxCellsError)
      expect((err as XlsxCellsError).code).toBe('locked')
      expect((err as XlsxCellsError).detail).toBe(detail)
    }
    // Parents and children of shared formulas are refused in stage 2 too.
    const shared = Buffer.from(
      makeXlsx({
        sheets: [
          {
            name: 'S',
            body: '<sheetData><row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">B1*2</f><v>2</v></c></row><row r="2"><c r="A2"><f t="shared" si="0"/><v>4</v></c></row></sheetData>'
          }
        ]
      })
    )
    await reject(shared, edit('A1', { t: 'f', v: 'B1*3' }), 'sharedFormula')
    await reject(shared, edit('A2', { t: 'n', v: 1 }), 'sharedFormula')
    await reject(book(), edit('B5', { t: 'n', v: 1 }), 'merged')
    // The top-left of a merge can be written.
    await expect(applyCellEdits(book(), [edit('A5', { t: 'n', v: 1 })])).resolves.toBeInstanceOf(Buffer)

    const special = Buffer.from(
      makeXlsx({
        sheets: [
          {
            name: 'S',
            body:
              '<sheetData><row r="1"><c r="A1"><f t="array" ref="A1:A3">B1:B3*2</f><v>2</v></c><c r="D1" cm="1"><v>1</v></c></row></sheetData>',
            rels: TABLE_REL('../tables/table1.xml') + PIVOT_REL('../pivotTables/pivotTable1.xml')
          },
          { name: 'P', body: '<sheetProtection sheet="1"/><sheetData/>' }
        ],
        parts: {
          'xl/tables/table1.xml': '<table xmlns="x" id="1" name="T" ref="F1:G4"/>',
          'xl/pivotTables/pivotTable1.xml': '<pivotTableDefinition xmlns="x"><location ref="J1:K9" firstHeaderRow="1"/></pivotTableDefinition>'
        }
      })
    )
    await reject(special, edit('A2', { t: 'n', v: 1 }), 'arrayFormula')
    await reject(special, edit('D1', { t: 'n', v: 1 }), 'richValue')
    await reject(special, edit('G1', { t: 's', v: 'h' }), 'tableHeader')
    await expect(applyCellEdits(special, [edit('G2', { t: 's', v: 'body' })])).resolves.toBeInstanceOf(Buffer)
    await reject(special, edit('K5', { t: 'n', v: 1 }), 'pivot')
    await reject(special, edit('A1', { t: 'n', v: 1 }, 'xl/worksheets/sheet2.xml'), 'protected')

    const signed = Buffer.from(
      makeXlsx({ sheets: [{ name: 'S', body: '<sheetData/>' }], parts: { '_xmlsignatures/sig1.xml': '<s/>' } })
    )
    await reject(signed, edit('A1', { t: 'n', v: 1 }), 'signed')
  })

  it('ワークシートでない部品・壊れた zip・CFB (暗号化) は unsupported / bad-file', async () => {
    const code = async (bytes: Buffer, edits: CellEdit[]): Promise<string> =>
      ((await applyCellEdits(bytes, edits).catch((x: unknown) => x)) as XlsxCellsError).code
    expect(await code(book(), [edit('A1', { t: 'n', v: 1 }, 'xl/styles.xml')])).toBe('unsupported')
    expect(await code(Buffer.from('not a zip at all, definitely not'), [edit('A1', { t: 'n', v: 1 })])).toBe('bad-file')
    const cfb = Buffer.alloc(64)
    cfb.writeUInt32BE(0xd0cf11e0, 0)
    expect(await code(cfb, [edit('A1', { t: 'n', v: 1 })])).toBe('unsupported')
  })

  it('既存の fixture (sample.xlsx) も往復する', async () => {
    const before = readFileSync(join(process.cwd(), 'test/fixtures/office/sample.xlsx'))
    const after = await applyCellEdits(before, [edit('B2', { t: 'n', v: 43 }), edit('A2', { t: 's', v: '大阪府' })])
    const rows = readWorkbook(after).sheets[0]?.rows ?? []
    expect(rows[1]?.slice(0, 2)).toEqual(['大阪府', 43])
    // Formula values are not calculated (they stay cached).
    expect(rows[4]?.[2]).toBe('名前x')
    const a = rawLocalRecords(before)
    const b = rawLocalRecords(after)
    for (const [name, raw] of a) {
      if (name === S1 || name === 'xl/workbook.xml') continue
      expect(Buffer.compare(raw, b.get(name) ?? Buffer.alloc(0)), name).toBe(0)
    }
  })
})

describe('数式の書き込み (TODO 1212 段 2)', () => {
  const CT =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>' +
    '</Types>'
  const CALC_REL = '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/>'

  /** A workbook that holds calcChain.xml (also listed in rels and [Content_Types].xml, the form Excel writes). */
  async function withCalcChain(): Promise<Buffer> {
    const base = Buffer.from(
      makeXlsx({
        sheets: [{ name: 'Data', body: BODY }, { name: 'My Sheet', body: '<sheetData/>' }],
        sharedStrings: ['名前'],
        parts: { 'xl/calcChain.xml': '<calcChain xmlns="x"><c r="C3" i="1"/></calcChain>', 'xl/media/image1.png': new Uint8Array([1, 2, 3]) }
      })
    )
    const relsText = await partText(base, 'xl/_rels/workbook.xml.rels')
    return await rewriteZip(
      readZip(base),
      new Map([
        ['[Content_Types].xml', Buffer.from(CT)],
        ['xl/_rels/workbook.xml.rels', Buffer.from(relsText.replace('</Relationships>', `${CALC_REL}</Relationships>`))]
      ])
    )
  }

  it('値のセルに式を書く: <f> だけで <v> も t も書かない。calcChain は触らない', async () => {
    const before = await withCalcChain()
    const after = await applyCellEdits(before, [
      edit('D1', { t: 'f', v: "A1&'My Sheet'!B2" }),
      edit('A1', { t: 'f', v: '_xlfn.IFS(B1>1,"a<b",TRUE,"c")' }),
      edit('E4', { t: 'f', v: 'SUM(A1:A3)' })
    ])
    const xml = await partText(after, S1)
    expect(xml).toContain(`<c r="D1"><f>A1&amp;'My Sheet'!B2</f></c>`)
    expect(xml).toContain('<c r="A1"><f>_xlfn.IFS(B1&gt;1,"a&lt;b",TRUE,"c")</f></c>')
    expect(xml).toContain('<row r="4"><c r="E4" s="2"><f>SUM(A1:A3)</f></c></row>')
    expect(xml).toContain('<dimension ref="A1:E4"/>')
    const a = rawLocalRecords(before)
    const b = rawLocalRecords(after)
    expect([...b.keys()]).toEqual([...a.keys()])
    for (const [name, raw] of a) {
      if (name === S1 || name === 'xl/workbook.xml') continue
      expect(Buffer.compare(raw, b.get(name) ?? Buffer.alloc(0)), name).toBe(0)
    }
    // The viewer's read: a formula with no cached value is shown as 'not calculated', with its formula.
    const read = readWorkbook(after)
    expect(read.sheets[0]?.rows[0]?.[3]).toBe("=A1&'My Sheet'!B2")
    expect(read.sheets[0]?.facts.formulas.get('0,3')?.computed).toBe(false)
  })

  it('式を書き換えるだけなら calcChain は残す', async () => {
    const before = await withCalcChain()
    const after = await applyCellEdits(before, [edit('C3', { t: 'f', v: 'A3*3' })])
    expect(await partText(after, S1)).toContain('<c r="C3"><f>A3*3</f></c>')
    expect(readZip(after).entries.some((e) => e.name === 'xl/calcChain.xml')).toBe(true)
    expect(await partText(after, '[Content_Types].xml')).toBe(CT)
  })

  it('式を値で上書きしたら calcChain.xml を部品・rels・[Content_Types].xml の 3 か所から落とす', async () => {
    const before = await withCalcChain()
    const after = await applyCellEdits(before, [edit('C3', { t: 'n', v: 5 })])
    expect(await partText(after, S1)).toContain('<c r="C3"><v>5</v></c>')
    const zip = readZip(after)
    expect(zip.entries.map((e) => e.name)).not.toContain('xl/calcChain.xml')
    expect(zip.entries).toHaveLength(readZip(before).entries.length - 1)
    const types = await partText(after, '[Content_Types].xml')
    expect(types).toBe(CT.replace('<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>', ''))
    expect(types).toContain('<Override PartName="/xl/workbook.xml"')
    const rels = await partText(after, 'xl/_rels/workbook.xml.rels')
    expect(rels).not.toContain('calcChain')
    expect(rels).toContain('/sharedStrings')
    // Untouched parts are byte-identical. They can be read by the viewer's read.
    const a = rawLocalRecords(before)
    const b = rawLocalRecords(after)
    for (const [name, raw] of b) {
      if ([S1, 'xl/workbook.xml', '[Content_Types].xml', 'xl/_rels/workbook.xml.rels'].includes(name)) continue
      expect(Buffer.compare(raw, a.get(name) ?? Buffer.alloc(0)), name).toBe(0)
    }
    expect(readWorkbook(after).sheets[0]?.rows[2]?.[2]).toBe(5)
    // Emptying it gives the same result.
    const emptied = await applyCellEdits(before, [edit('C3', { t: 'empty' })])
    expect(readZip(emptied).entries.map((e) => e.name)).not.toContain('xl/calcChain.xml')
  })

  it('ブックに無いシートの参照・正規でない式は書かない', async () => {
    const code = async (e: CellEdit): Promise<string> =>
      ((await applyCellEdits(book(), [e]).catch((x: unknown) => x)) as XlsxCellsError).detail
    expect(await code(edit('A1', { t: 'f', v: 'Gone!A1' }))).toBe('formula-unknown-sheet')
    expect(await code(edit('A1', { t: 'f', v: 'sum(a1' }))).toBe('formula')
    // Hidden sheets and chart sheets are allowed if the name is in the workbook (case does not matter).
    await expect(applyCellEdits(book(), [edit('A1', { t: 'f', v: 'two!A1' })])).resolves.toBeInstanceOf(Buffer)
  })
})

describe('.xlsm (TODO 1212 段 2)', () => {
  const MACRO_CT =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>' +
    '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>' +
    '</Types>'
  /** Stands in for the contents of vbaProject.bin (a CFB header plus any bytes; the contents are not read). */
  const VBA = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...Array.from({ length: 600 }, (_, i) => (i * 37) & 0xff)])

  async function macroBook(extra: Record<string, string | Uint8Array> = {}): Promise<Buffer> {
    const base = Buffer.from(
      makeXlsx({
        sheets: [{ name: 'Data', body: BODY }],
        sharedStrings: ['名前'],
        parts: {
          'xl/vbaProject.bin': VBA,
          'xl/calcChain.xml': '<calcChain xmlns="x"><c r="C3" i="1"/></calcChain>',
          'customUI/customUI14.xml': '<customUI xmlns="http://schemas.microsoft.com/office/2009/07/customui"/>',
          ...extra
        }
      })
    )
    const rels = await partText(base, 'xl/_rels/workbook.xml.rels')
    return await rewriteZip(
      readZip(base),
      new Map([
        ['[Content_Types].xml', Buffer.from(MACRO_CT)],
        [
          'xl/_rels/workbook.xml.rels',
          Buffer.from(
            rels.replace(
              '</Relationships>',
              '<Relationship Id="rId8" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>' +
                '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>'
            )
          )
        ]
      ])
    )
  }

  it('値と数式を書いても、マクロの部品と [Content_Types].xml はバイト列のまま', async () => {
    const before = await macroBook()
    const after = await applyCellEdits(before, [edit('A1', { t: 's', v: '値' }), edit('D1', { t: 'f', v: 'A3*2' })])
    const a = rawLocalRecords(before)
    const b = rawLocalRecords(after)
    expect([...b.keys()]).toEqual([...a.keys()])
    for (const [name, raw] of a) {
      if (name === S1 || name === 'xl/workbook.xml') continue
      expect(Buffer.compare(raw, b.get(name) ?? Buffer.alloc(0)), name).toBe(0)
    }
    const zip = readZip(after)
    const vba = zip.entries.find((e) => e.name === 'xl/vbaProject.bin')
    if (vba === undefined) throw new Error('vbaProject.bin')
    expect(Buffer.compare(await readEntry(zip, vba, 1 << 20), Buffer.from(VBA))).toBe(0)
    expect(await partText(after, '[Content_Types].xml')).toBe(MACRO_CT)
    expect(readWorkbook(after).sheets[0]?.rows[0]?.[0]).toBe('値')
  })

  it('式を値にして calcChain を落としても、マクロの型・関係は残り、[Content_Types].xml は calcChain の行だけ消える', async () => {
    const before = await macroBook()
    const after = await applyCellEdits(before, [edit('C3', { t: 'n', v: 1 })])
    const types = await partText(after, '[Content_Types].xml')
    expect(types).toContain('<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>')
    expect(types).toContain('application/vnd.ms-excel.sheet.macroEnabled.main+xml')
    expect(types).not.toContain('calcChain')
    expect(types.length).toBe(MACRO_CT.length - '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>'.length)
    // [Content_Types].xml can be read as XML (DOMParser).
    expect(new DOMParser().parseFromString(types, 'application/xml').getElementsByTagName('parsererror')).toHaveLength(0)
    const rels = await partText(after, 'xl/_rels/workbook.xml.rels')
    expect(rels).toContain('relationships/vbaProject" Target="vbaProject.bin"')
    expect(rels).not.toContain('calcChain')
    const a = rawLocalRecords(before)
    const b = rawLocalRecords(after)
    for (const name of ['xl/vbaProject.bin', 'customUI/customUI14.xml', 'xl/styles.xml', 'xl/sharedStrings.xml']) {
      expect(Buffer.compare(a.get(name) ?? Buffer.alloc(1), b.get(name) ?? Buffer.alloc(0)), name).toBe(0)
    }
  })

  it('署名付きのマクロは signedMacro で書かない', async () => {
    const signed = await macroBook({ 'xl/vbaProjectSignature.bin': new Uint8Array([9, 9]) })
    const err = await applyCellEdits(signed, [edit('A1', { t: 'n', v: 1 })]).catch((x: unknown) => x)
    expect(err).toBeInstanceOf(XlsxCellsError)
    expect((err as XlsxCellsError).code).toBe('locked')
    expect((err as XlsxCellsError).detail).toBe('signedMacro')
    expect(readWorkbook(signed).signature).toBe('signedMacro')
  })
})

describe('小さな部品', () => {
  it('encodeCellText は制御文字と _xHHHH_ を逃がす', () => {
    expect(encodeCellText('a\u0001b_x0041_<')).toBe('a_x0001_b_x005F_x0041_&lt;')
    expect(encodeCellText('tab\tok\n')).toBe('tab\tok\n')
  })

  it('patchWorkbookXml は既存の calcPr に足し、無ければ並びの正しい位置に挿す', () => {
    expect(patchWorkbookXml('<workbook><sheets/><calcPr calcId="191029"/></workbook>')).toBe(
      '<workbook><sheets/><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>'
    )
    expect(patchWorkbookXml('<x:workbook xmlns:x="n"><x:sheets/><x:pivotCaches/><x:extLst/></x:workbook>')).toBe(
      '<x:workbook xmlns:x="n"><x:sheets/><x:calcPr fullCalcOnLoad="1"/><x:pivotCaches/><x:extLst/></x:workbook>'
    )
    const already = '<workbook><calcPr fullCalcOnLoad="1"/></workbook>'
    expect(patchWorkbookXml(already)).toBe(already)
  })

  it('rewriteZip は先頭の項目を落としても前置きに中身を残さず、数を付け直す', async () => {
    const { zipSync, strToU8 } = await import('fflate')
    const base = Buffer.from(zipSync({ 'first.xml': strToU8('<gone/>'), 'second.xml': strToU8('<kept/>') }, { level: 0 }))
    const out = await rewriteZip(readZip(base), new Map(), new Set(['first.xml']))
    expect(out.includes(Buffer.from('<gone/>'))).toBe(false)
    const again = readZip(out)
    expect(again.entries.map((e) => e.name)).toEqual(['second.xml'])
    expect(out.readUInt16LE(again.eocdOffset + 10)).toBe(1)
    expect((await readEntry(again, again.entries[0]!, 1024)).toString()).toBe('<kept/>')
    await expect(rewriteZip(readZip(base), new Map(), new Set(['nope.xml']))).rejects.toThrow('missing-entry')
  })

  it('rewriteZip はデータ記述子付きの項目も記述子ごとそのまま写し、置き換えた項目は読み直せる', async () => {
    // fflate's zipSync does not use data descriptors, so a zip is built by hand with bit 3 set in the local header and the descriptor placed after the data.
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello'), descriptor: true },
      { name: 'b.xml', data: Buffer.from('<b/>'), descriptor: false }
    ]
    const locals: Buffer[] = []
    const centrals: Buffer[] = []
    let offset = 0
    for (const e of entries) {
      const crc = crc32(e.data) >>> 0
      const name = Buffer.from(e.name)
      const lh = Buffer.alloc(30)
      lh.writeUInt32LE(0x04034b50, 0)
      lh.writeUInt16LE(10, 4)
      lh.writeUInt16LE(e.descriptor ? 8 : 0, 6)
      lh.writeUInt32LE(e.descriptor ? 0 : crc, 14)
      lh.writeUInt32LE(e.descriptor ? 0 : e.data.length, 18)
      lh.writeUInt32LE(e.descriptor ? 0 : e.data.length, 22)
      lh.writeUInt16LE(name.length, 26)
      const desc = Buffer.alloc(e.descriptor ? 16 : 0)
      if (e.descriptor) {
        desc.writeUInt32LE(0x08074b50, 0)
        desc.writeUInt32LE(crc, 4)
        desc.writeUInt32LE(e.data.length, 8)
        desc.writeUInt32LE(e.data.length, 12)
      }
      const local = Buffer.concat([lh, name, e.data, desc])
      const ch = Buffer.alloc(46)
      ch.writeUInt32LE(0x02014b50, 0)
      ch.writeUInt16LE(10, 6)
      ch.writeUInt16LE(e.descriptor ? 8 : 0, 8)
      ch.writeUInt32LE(crc, 16)
      ch.writeUInt32LE(e.data.length, 20)
      ch.writeUInt32LE(e.data.length, 24)
      ch.writeUInt16LE(name.length, 28)
      ch.writeUInt32LE(offset, 42)
      centrals.push(Buffer.concat([ch, name]))
      locals.push(local)
      offset += local.length
    }
    const cd = Buffer.concat(centrals)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(2, 8)
    eocd.writeUInt16LE(2, 10)
    eocd.writeUInt32LE(cd.length, 12)
    eocd.writeUInt32LE(offset, 16)
    const base = Buffer.concat([...locals, cd, eocd])
    const out = await rewriteZip(readZip(base), new Map([['b.xml', Buffer.from('<b>changed</b>')]]))
    // a.txt stays as it was, including its header, data, and descriptor.
    expect(Buffer.compare(out.subarray(0, locals[0]?.length ?? 0), locals[0] ?? Buffer.alloc(0))).toBe(0)
    const again = readZip(out)
    const a = again.entries.find((e) => e.name === 'a.txt')
    const b = again.entries.find((e) => e.name === 'b.xml')
    if (a === undefined || b === undefined) throw new Error('entries')
    expect((await readEntry(again, a, 1024)).toString()).toBe('hello')
    expect((await readEntry(again, b, 1024)).toString()).toBe('<b>changed</b>')
  })
})
