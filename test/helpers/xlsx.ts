/**
 * Builds a small `.xlsx` for tests (TODO 1212 stage 1). It has the part names Excel writes, relative rels, shared strings, and styles. The sheet's XML and extra parts (tables, pivots, images, unknown parts, signatures) are given by the caller. The model is not called.
 */
import { strToU8, zipSync, type Zippable } from 'fflate'

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export interface XlsxSheetSpec {
  readonly name: string
  /** The contents of `<worksheet>` (`<sheetData>…</sheetData>` etc.). */
  readonly body: string
  /** The list of `<Relationship>` in the sheet's rels (tables, pivots). */
  readonly rels?: string
}

export interface XlsxSpec {
  readonly sheets: readonly XlsxSheetSpec[]
  readonly workbookExtra?: string
  readonly sharedStrings?: readonly string[]
  /** Additional parts (path → contents). */
  readonly parts?: Readonly<Record<string, string | Uint8Array>>
  /** The compression level (0 = stored, uncompressed). */
  readonly level?: 0 | 6
}

export function worksheet(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}" xmlns:r="${R}">${body}</worksheet>`
}

export function makeXlsx(spec: XlsxSpec): Uint8Array {
  const files: Zippable = {}
  const sheetRels = spec.sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('')
  const n = spec.sheets.length
  files['[Content_Types].xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/></Types>'
  )
  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  )
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS}" xmlns:r="${R}"><workbookPr/><sheets>` +
      spec.sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      `</sheets>${spec.workbookExtra ?? ''}</workbook>`
  )
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}` +
      `<Relationship Id="rId${n + 1}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
      `<Relationship Id="rId${n + 2}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`
  )
  const strings = spec.sharedStrings ?? []
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NS}" count="${strings.length}" uniqueCount="${strings.length}">` +
      strings.map((t) => `<si><t>${t}</t></si>`).join('') +
      '</sst>'
  )
  files['xl/styles.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS}"><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="0"/></cellXfs></styleSheet>`
  )
  spec.sheets.forEach((sheet, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(worksheet(sheet.body))
    if (sheet.rels !== undefined) {
      files[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheet.rels}</Relationships>`
      )
    }
  })
  for (const [path, content] of Object.entries(spec.parts ?? {})) {
    files[path] = typeof content === 'string' ? strToU8(content) : content
  }
  return zipSync(files, { level: spec.level ?? 6 })
}

export const TABLE_REL = (target: string): string =>
  `<Relationship Id="rIdT" Type="${REL}/table" Target="${target}"/>`
export const PIVOT_REL = (target: string): string =>
  `<Relationship Id="rIdP" Type="${REL}/pivotTable" Target="${target}"/>`
