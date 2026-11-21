#!/usr/bin/env node
/**
 * `aios.office` のテスト用の小さな .docx / .xlsx を作る (TODO 405 (4)、第 21 波 束 H)。
 * 生成物 (`sample.docx` / `sample.xlsx`) は commit してあり、テストはそれを読むだけ。作り直すときだけ
 * `node test/fixtures/office/make-fixtures.mjs` を回す。中身は手書きの最小の OOXML (Office は使っていない)。
 */
import { Buffer } from 'node:buffer'
import { writeFileSync } from 'node:fs'
import { stdout } from 'node:process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'

const here = dirname(fileURLToPath(import.meta.url))
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
// zip の時刻を固定して、作り直しても同じバイト列になるようにする。
const MTIME = new Date('2026-10-04T00:00:00Z')

function zip(files) {
  const entries = {}
  for (const [name, content] of Object.entries(files)) {
    entries[name] = [typeof content === 'string' ? strToU8(content) : content, { mtime: MTIME }]
  }
  return zipSync(entries, { level: 6 })
}

// 1×1 の PNG (赤)。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
)

const docx = zip({
  '[Content_Types].xml':
    XML +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>',
  '_rels/.rels':
    XML +
    `<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/_rels/document.xml.rels':
    XML +
    `<Relationships xmlns="${PKG_REL}">` +
    `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="${REL}/hyperlink" Target="https://example.com/" TargetMode="External"/>` +
    `<Relationship Id="rId3" Type="${REL}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>` +
    `<Relationship Id="rId4" Type="${REL}/image" Target="media/image1.png"/>` +
    '</Relationships>',
  'word/styles.xml':
    XML +
    `<w:styles xmlns:w="${W}">` +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
    '</w:styles>',
  'word/document.xml':
    XML +
    `<w:document xmlns:w="${W}" xmlns:r="${REL}" ` +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>見出しの段落</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">本文の </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>太字</w:t></w:r>' +
    '<w:r><w:t xml:space="preserve"> と &lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>' +
    '<w:p><w:hyperlink r:id="rId2"><w:r><w:t>外部のリンク</w:t></w:r></w:hyperlink></w:p>' +
    '<w:p><w:hyperlink r:id="rId3"><w:r><w:t>危ないリンク</w:t></w:r></w:hyperlink></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Picture 1" descr="赤い点"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    '<pic:nvPicPr><pic:cNvPr id="0" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="rId4"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r></w:p>' +
    '</w:body></w:document>',
  'word/media/image1.png': new Uint8Array(PNG)
})

// .xlsx: 表示 2 枚 + 隠し 1 枚。共有文字列 (ふりがな付き)・日付・時刻・真偽・エラー・インライン文字列・数式の値。
const xlsx = zip({
  '[Content_Types].xml':
    XML +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '</Types>',
  '_rels/.rels':
    XML +
    `<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  'xl/_rels/workbook.xml.rels':
    XML +
    `<Relationships xmlns="${PKG_REL}">` +
    `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/>` +
    `<Relationship Id="rId3" Type="${REL}/worksheet" Target="worksheets/sheet3.xml"/>` +
    `<Relationship Id="rId4" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
    `<Relationship Id="rId5" Type="${REL}/styles" Target="styles.xml"/>` +
    '</Relationships>',
  'xl/workbook.xml':
    XML +
    `<workbook xmlns="${S}" xmlns:r="${REL}"><workbookPr/><sheets>` +
    '<sheet name="一覧" sheetId="1" r:id="rId1"/>' +
    '<sheet name="Hidden" sheetId="3" state="hidden" r:id="rId3"/>' +
    '<sheet name="Empty" sheetId="2" r:id="rId2"/>' +
    '</sheets></workbook>',
  'xl/sharedStrings.xml':
    XML +
    `<sst xmlns="${S}" count="3" uniqueCount="3">` +
    '<si><t>名前</t></si>' +
    '<si><r><t>東京</t></r><r><rPr><b/></rPr><t>都</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si>' +
    '<si><t xml:space="preserve"> 前後に空白 </t></si>' +
    '</sst>',
  'xl/styles.xml':
    XML +
    `<styleSheet xmlns="${S}"><numFmts count="2">` +
    '<numFmt numFmtId="164" formatCode="yyyy/mm/dd\\ hh:mm"/>' +
    '<numFmt numFmtId="165" formatCode="0.00&quot;m&quot;"/>' +
    '</numFmts><cellXfs count="5">' +
    '<xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="20"/>' +
    '</cellXfs></styleSheet>',
  'xl/worksheets/sheet1.xml':
    XML +
    `<worksheet xmlns="${S}"><sheetData>` +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>インライン</t></is></c><c r="D1" t="s"><v>2</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c><c r="C2"><v>0.30000000000000004</v></c></row>' +
    '<row r="4"><c r="A4" s="1"><v>46299</v></c><c r="B4" s="2"><v>46299.5</v></c><c r="C4" s="3"><v>1.5</v></c><c r="D4" s="4"><v>0.75</v></c></row>' +
    '<row r="5"><c r="A5" t="b"><v>1</v></c><c r="B5" t="e"><v>#DIV/0!</v></c><c r="C5" t="str"><f>A1&amp;"x"</f><v>名前x</v></c><c r="D5"/></row>' +
    '</sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': XML + `<worksheet xmlns="${S}"><sheetData/></worksheet>`,
  'xl/worksheets/sheet3.xml':
    XML + `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`
})

writeFileSync(join(here, 'sample.docx'), docx)
writeFileSync(join(here, 'sample.xlsx'), xlsx)
stdout.write(`sample.docx ${docx.length} bytes, sample.xlsx ${xlsx.length} bytes\n`)
