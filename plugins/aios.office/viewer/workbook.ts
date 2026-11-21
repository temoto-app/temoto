/**
 * Reading `.xlsx` (TODO 405 (4), wave 21 bundle H). **A small OOXML reader using fflate's `unzipSync` + DOMParser**.
 *
 * Why it was written in-house instead of using a library (bundle H of the note `docs/notes/wave21.md`):
 * - npm's `xlsx` (SheetJS) stopped at 0.18.5, and later versions are distributed from SheetJS's own CDN (outside the npm registry).
 * - `exceljs` (MIT) has had no release since 2023, and its browser build is an 860 KB minified bundle including polyfills, and contains `Function(…)`.
 * - `read-excel-file` (MIT) is light, but for unzipping it **always uses fflate's asynchronous `unzip`**, and anything over 512 KB
 *   is unzipped in a blob-URL Web Worker. The viewer's CSP (`script-src aios-plugin:`, and `worker-src` follows it)
 *   does not allow a blob Worker, so larger sheets could not be opened.
 * Display needs only "sheet names, cell values and whether a cell is a date", so synchronous unzip (`unzipSync`) and DOMParser are enough.
 *
 * What is read: `[Content_Types]` is not looked at; `_rels/.rels` -> workbook -> `workbook.xml.rels` -> each sheet,
 * `sharedStrings.xml` (excluding phonetic guides `<rPh>`), and `styles.xml` (only to decide date formats).
 * Formats (%, currency, digit grouping) are not applied, and numbers are shown as they are. Formulas are not calculated; the stored value (`<v>`) is shown.
 */
import { strFromU8, unzipSync } from 'fflate'
import {
  displayFormula,
  formulaReferences,
  parseRange,
  shiftReferences,
  workbookSignature,
  type CellLockReason,
  type CellRange,
  type FormulaRef
} from '@shared/xlsx-cells.js'
import type { SheetCell } from '../../_shared/sheet.js'

/** The facts about one formula cell. */
export interface FormulaFact {
  /** The formula (without `=`, as in the file). A child of a shared formula and a data table have no formula (null). */
  readonly text: string | null
  readonly refs: readonly FormulaRef[]
  readonly opaque: boolean
  /** The kind of `<f t>`. Shared formulas (parent and child), array formulas and data tables refuse editing (even in stage 2). */
  readonly kind: 'normal' | 'shared' | 'array'
  /** Whether it has a cached value `<v>`. A formula without one (a formula aios wrote, or a file from a writer that does not calculate) gets the "not calculated" mark. */
  readonly computed: boolean
}

/**
 * The facts about a sheet for editing cell values and formulas (TODO 1212 stage 1 / stage 2). The rule for reasons to refuse is `cellLockOf`
 * (main's `xlsx-cells-write.ts` rechecks with the same rule before writing).
 */
export interface SheetEditFacts {
  /** Formula cells (`${row},${col}`) -> facts. */
  readonly formulas: ReadonlyMap<string, FormulaFact>
  /** Cells with a `cm` / `vm` attribute (dynamic arrays, rich values). */
  readonly richCells: ReadonlySet<string>
  readonly protectedSheet: boolean
  readonly merges: readonly CellRange[]
  readonly arrayFormulas: readonly CellRange[]
  readonly tableHeaders: readonly CellRange[]
  readonly pivots: readonly CellRange[]
}

export interface WorkbookSheet {
  readonly name: string
  readonly rows: SheetCell[][]
  /** The path of the sheet part inside the zip (the `sheet` of an edit-list entry). */
  readonly path: string
  readonly facts: SheetEditFacts
}

export interface Workbook {
  readonly sheets: readonly WorkbookSheet[]
  /** A workbook with a 1904 epoch (for when a date input is turned into a serial number). */
  readonly date1904: boolean
  /** A workbook with a signature (a document signature or a macro signature) (editing is refused). */
  readonly signature: 'signed' | 'signedMacro' | null
  /** All sheet names of the workbook (including hidden and chart sheets). Used to validate the references of formulas. */
  readonly sheetNames: readonly string[]
}

/** The key of a cell position. */
export function cellPosKey(row: number, col: number): string {
  return `${row},${col}`
}

/** The reason to refuse (`CellLockReason` of `@shared/xlsx-cells.ts`). null if none. */
export function cellLockOf(
  book: Pick<Workbook, 'signature'>,
  facts: SheetEditFacts,
  row: number,
  col: number
): CellLockReason | null {
  if (book.signature !== null) return book.signature
  if (facts.protectedSheet) return 'protected'
  const inside = (range: CellRange): boolean => row >= range.r1 && row <= range.r2 && col >= range.c1 && col <= range.c2
  if (facts.merges.some((m) => inside(m) && !(m.r1 === row && m.c1 === col))) return 'merged'
  if (facts.arrayFormulas.some(inside)) return 'arrayFormula'
  if (facts.tableHeaders.some(inside)) return 'tableHeader'
  if (facts.pivots.some(inside)) return 'pivot'
  const key = cellPosKey(row, col)
  const formula = facts.formulas.get(key)
  if (formula?.kind === 'shared') return 'sharedFormula'
  if (formula?.kind === 'array') return 'arrayFormula'
  if (facts.richCells.has(key)) return 'richValue'
  return null
}

/** Cannot be read (not a zip, a required part is missing, or too large). `message` is a short English reason (it does not include the body). */
export class WorkbookError extends Error {}

/** The upper limit of one part after unzipping (judged by the size the zip's central directory claims). */
export const MAX_PART_BYTES = 128 * 1024 * 1024
/** The upper limit of the total after unzipping. So that a zip bomb cannot eat the iframe's memory. */
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024

export type XmlParser = (xml: string) => Document

const defaultParser: XmlParser = (xml) => new DOMParser().parseFromString(xml, 'application/xml')

/** Look up child elements by `localName` (some files use a namespace prefix such as `x:`). */
function childElements(parent: Element, local: string): Element[] {
  const out: Element[] = []
  for (let child = parent.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (child.localName === local) out.push(child)
  }
  return out
}

function firstChild(parent: Element, local: string): Element | null {
  for (let child = parent.firstElementChild; child !== null; child = child.nextElementSibling) {
    if (child.localName === local) return child
  }
  return null
}

function descendants(parent: Element | Document, local: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS('*', local))
}

/** Look up an attribute with a namespace such as `r:id` regardless of the prefix. */
function attrByLocal(el: Element, local: string): string | null {
  for (const attr of Array.from(el.attributes)) {
    if (attr.localName === local) return attr.value
  }
  return null
}

/** The characters of a shared string / inline string. A `<t>` inside `<rPh>` (phonetic guide) is not counted. */
function richText(el: Element): string {
  let text = ''
  for (const t of descendants(el, 't')) {
    let inPhonetic = false
    for (let p = t.parentElement; p !== null && p !== el; p = p.parentElement) {
      if (p.localName === 'rPh') {
        inPhonetic = true
        break
      }
    }
    if (!inPhonetic) text += t.textContent ?? ''
  }
  return text
}

/** Turn a target relative to `base` (the part's path) into a path inside the zip. */
export function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.' && segment !== '') parts.push(segment)
  }
  return parts.join('/')
}

/** `B12` -> { row: 11, col: 1 } (0-based). */
export function parseCellRef(ref: string): { row: number; col: number } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref)
  if (match === null) return null
  const letters = (match[1] ?? '').toUpperCase()
  let col = 0
  for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64)
  const row = Number(match[2])
  if (!Number.isSafeInteger(row) || row < 1) return null
  return { row: row - 1, col: col - 1 }
}

/** The IDs of built-in date / time formats (ECMA-376 18.8.30, and 27-36 / 50-58 of the Japanese edition). */
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55,
  56, 57, 58
])

/**
 * Whether a format string is a date / time. After removing quoted parts, `\x` escapes, square brackets such as `[$-411]` (except elapsed time such as `[h]`), and
 * `_x` / `*x`, it counts as a date if y / m / d / h / s remain (`0.00"m"` is a number).
 */
export function isDateFormatCode(code: string): boolean {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '')
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, '')
  // Look only at the first section (`;`) (positive; negative; zero; text).
  const first = stripped.split(';')[0] ?? ''
  return /[ymdhs]/i.test(first) && !/^General$/i.test(first.trim())
}

/** Excel serial number (days) -> Date (UTC wall clock). The "1900-02-29" error of the 1900 system is absorbed from March onward. */
export function excelSerialToDate(serial: number, date1904: boolean): Date {
  const days = date1904 ? serial + 1462 : serial
  // Round to seconds (so floating-point error does not give 12:29:59.999).
  const seconds = Math.round((days - 25569) * 86400)
  return new Date(seconds * 1000)
}

interface Styles {
  /** Index into cellXfs -> whether it is a date format. */
  readonly dateStyles: readonly boolean[]
}

function readStyles(doc: Document | null): Styles {
  if (doc === null) return { dateStyles: [] }
  const custom = new Map<number, string>()
  for (const fmt of descendants(doc, 'numFmt')) {
    const id = Number(fmt.getAttribute('numFmtId'))
    const code = fmt.getAttribute('formatCode')
    if (Number.isInteger(id) && code !== null) custom.set(id, code)
  }
  const cellXfs = descendants(doc, 'cellXfs')[0]
  const dateStyles: boolean[] = []
  if (cellXfs !== undefined) {
    for (const xf of childElements(cellXfs, 'xf')) {
      const id = Number(xf.getAttribute('numFmtId') ?? '0')
      const code = custom.get(id)
      dateStyles.push(code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_FORMATS.has(id))
    }
  }
  return { dateStyles }
}

function readRelationships(doc: Document | null): Map<string, { type: string; target: string; external: boolean }> {
  const map = new Map<string, { type: string; target: string; external: boolean }>()
  if (doc === null) return map
  for (const rel of descendants(doc, 'Relationship')) {
    const id = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (id === null || target === null) continue
    map.set(id, {
      type: rel.getAttribute('Type') ?? '',
      target,
      external: rel.getAttribute('TargetMode') === 'External'
    })
  }
  return map
}

function readCell(
  c: Element,
  sharedStrings: readonly string[],
  styles: Styles,
  date1904: boolean
): SheetCell {
  const type = c.getAttribute('t') ?? 'n'
  if (type === 'inlineStr') {
    const is = firstChild(c, 'is')
    return is === null ? null : richText(is)
  }
  const v = firstChild(c, 'v')?.textContent ?? null
  if (v === null || v === '') return null
  switch (type) {
    case 's': {
      const index = Number(v)
      return Number.isInteger(index) ? (sharedStrings[index] ?? '') : ''
    }
    case 'str':
    case 'e':
      return v
    case 'b':
      return v === '1' || v.toLowerCase() === 'true'
    case 'd': {
      const date = new Date(v.endsWith('Z') || /[+-]\d\d:\d\d$/.test(v) ? v : `${v}Z`)
      return Number.isNaN(date.getTime()) ? v : date
    }
    default: {
      const n = Number(v)
      if (!Number.isFinite(n)) return v
      const style = Number(c.getAttribute('s') ?? '0')
      if (styles.dateStyles[style] === true) return excelSerialToDate(n, date1904)
      return n
    }
  }
}

interface SheetRead {
  readonly rows: SheetCell[][]
  readonly formulas: Map<string, FormulaFact>
  readonly richCells: Set<string>
  readonly arrayFormulas: CellRange[]
}

function readSheet(doc: Document, sharedStrings: readonly string[], styles: Styles, date1904: boolean): SheetRead {
  const rows: SheetCell[][] = []
  const formulas = new Map<string, FormulaFact>()
  const richCells = new Set<string>()
  const arrayFormulas: CellRange[] = []
  /** The parent of a shared formula (si -> position and references), and the children to resolve later. */
  const sharedParents = new Map<string, { row: number; col: number; refs: readonly FormulaRef[]; opaque: boolean }>()
  const sharedChildren: { key: string; si: string; row: number; col: number; computed: boolean }[] = []
  const out: SheetRead = { rows, formulas, richCells, arrayFormulas }
  const sheetData = descendants(doc, 'sheetData')[0]
  if (sheetData === undefined) return out
  let nextRow = 0
  for (const row of childElements(sheetData, 'row')) {
    const rAttr = Number(row.getAttribute('r'))
    const rowIndex = Number.isSafeInteger(rAttr) && rAttr >= 1 ? rAttr - 1 : nextRow
    nextRow = rowIndex + 1
    const cells: SheetCell[] = []
    let nextCol = 0
    for (const c of childElements(row, 'c')) {
      const ref = c.getAttribute('r')
      const parsed = ref === null ? null : parseCellRef(ref)
      const col = parsed?.col ?? nextCol
      nextCol = col + 1
      const key = cellPosKey(rowIndex, col)
      if (c.hasAttribute('cm') || c.hasAttribute('vm')) richCells.add(key)
      const f = firstChild(c, 'f')
      /** A cell with a formula but no cached value (not calculated) — show the formula instead of the value. */
      let uncomputed: string | null = null
      if (f !== null) {
        const type = f.getAttribute('t')
        const text = f.textContent ?? ''
        if ((type === 'array' || type === 'dataTable') && f.getAttribute('ref') !== null) {
          const range = parseRange(f.getAttribute('ref') ?? '')
          if (range !== null) arrayFormulas.push(range)
        }
        const kind = type === 'shared' ? 'shared' : type === 'array' || type === 'dataTable' ? 'array' : 'normal'
        const computed = firstChild(c, 'v') !== null || c.getAttribute('t') === 'inlineStr'
        const si = f.getAttribute('si')
        if (type === 'shared' && si !== null && text === '') {
          sharedChildren.push({ key, si, row: rowIndex, col, computed })
          formulas.set(key, { text: null, refs: [], opaque: true, kind, computed })
        } else {
          const found = type === 'dataTable' ? { refs: [], opaque: true } : formulaReferences(text)
          formulas.set(key, { text: type === 'dataTable' ? null : text, refs: found.refs, opaque: found.opaque, kind, computed })
          if (type === 'shared' && si !== null) sharedParents.set(si, { row: rowIndex, col, ...found })
          if (!computed && type !== 'dataTable' && text !== '') uncomputed = `=${displayFormula(text)}`
        }
      }
      const value = readCell(c, sharedStrings, styles, date1904) ?? uncomputed
      if (value === null) continue
      while (cells.length < col) cells.push(null)
      cells[col] = value
    }
    if (cells.length === 0) continue
    while (rows.length < rowIndex) rows.push([])
    rows[rowIndex] = cells
  }
  // A child of a shared formula: shift the parent's references by the position offset. If the parent is not found, the references stay unreadable (the stale-value mark is shown conservatively).
  for (const child of sharedChildren) {
    const parent = sharedParents.get(child.si)
    if (parent === undefined) continue
    formulas.set(child.key, {
      text: null,
      refs: shiftReferences(parent.refs, child.row - parent.row, child.col - parent.col),
      opaque: parent.opaque,
      kind: 'shared',
      computed: child.computed
    })
  }
  return out
}

/** From a sheet's relationships (tables, pivots), pick up the heading row and the pivot range. */
function readSheetParts(
  xml: (path: string) => Document | null,
  sheetPath: string
): { tableHeaders: CellRange[]; pivots: CellRange[] } {
  const tableHeaders: CellRange[] = []
  const pivots: CellRange[] = []
  const rels = readRelationships(xml(resolvePart(sheetPath, `_rels/${sheetPath.split('/').pop() ?? ''}.rels`)))
  for (const rel of rels.values()) {
    if (rel.external) continue
    if (rel.type.endsWith('/table')) {
      const table = xml(resolvePart(sheetPath, rel.target))?.documentElement ?? null
      const range = parseRange(table?.getAttribute('ref') ?? '')
      const headerRows = Number(table?.getAttribute('headerRowCount') ?? '1')
      if (range !== null && headerRows > 0) {
        tableHeaders.push({ r1: range.r1, c1: range.c1, r2: range.r1 + headerRows - 1, c2: range.c2 })
      }
    } else if (rel.type.endsWith('/pivotTable')) {
      const doc = xml(resolvePart(sheetPath, rel.target))
      const location = doc === null ? undefined : descendants(doc, 'location')[0]
      const range = parseRange(location?.getAttribute('ref') ?? '')
      if (range !== null) pivots.push(range)
    }
  }
  return { tableHeaders, pivots }
}

function sheetFacts(doc: Document | null, read: SheetRead, parts: { tableHeaders: CellRange[]; pivots: CellRange[] }): SheetEditFacts {
  const merges: CellRange[] = []
  let protectedSheet = false
  if (doc !== null) {
    for (const merge of descendants(doc, 'mergeCell')) {
      const range = parseRange(merge.getAttribute('ref') ?? '')
      if (range !== null) merges.push(range)
    }
    const protection = descendants(doc, 'sheetProtection')[0]
    const flag = protection?.getAttribute('sheet') ?? null
    protectedSheet = flag === '1' || flag === 'true'
  }
  return {
    formulas: read.formulas,
    richCells: read.richCells,
    protectedSheet,
    merges,
    arrayFormulas: read.arrayFormulas,
    tableHeaders: parts.tableHeaders,
    pivots: parts.pivots
  }
}

/** Open the zip. Unzip only `.xml` / `.rels`, checking the size limits. Put all part names into `names`. */
function unzipParts(bytes: Uint8Array, names: string[] = []): Record<string, Uint8Array> {
  let total = 0
  try {
    return unzipSync(bytes, {
      filter: (file) => {
        names.push(file.name)
        if (!/\.(xml|rels)$/i.test(file.name)) return false
        if (file.originalSize > MAX_PART_BYTES) throw new WorkbookError('part-too-large')
        total += file.originalSize
        if (total > MAX_TOTAL_BYTES) throw new WorkbookError('too-large')
        return true
      }
    })
  } catch (err) {
    if (err instanceof WorkbookError) throw err
    throw new WorkbookError('not-a-zip')
  }
}

/** Read the bytes of an .xlsx. Hidden sheets (`state="hidden"` / `veryHidden`) are not shown as tabs, same as Excel. */
export function readWorkbook(input: ArrayBuffer | Uint8Array, parse: XmlParser = defaultParser): Workbook {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const names: string[] = []
  const files = unzipParts(bytes, names)
  const xml = (path: string): Document | null => {
    const data = files[path]
    if (data === undefined) return null
    const doc = parse(strFromU8(data))
    if (doc.getElementsByTagName('parsererror').length > 0) throw new WorkbookError('bad-xml')
    return doc
  }

  const rootRels = readRelationships(xml('_rels/.rels'))
  let workbookPath = 'xl/workbook.xml'
  for (const rel of rootRels.values()) {
    if (rel.type.endsWith('/officeDocument')) workbookPath = resolvePart('', rel.target)
  }
  const workbookDoc = xml(workbookPath)
  if (workbookDoc === null) throw new WorkbookError('no-workbook')
  const relsPath = resolvePart(workbookPath, `_rels/${workbookPath.split('/').pop() ?? ''}.rels`)
  const rels = readRelationships(xml(relsPath))

  const workbookPr = descendants(workbookDoc, 'workbookPr')[0]
  const date1904Attr = workbookPr?.getAttribute('date1904') ?? ''
  const date1904 = date1904Attr === '1' || date1904Attr.toLowerCase() === 'true'

  let sharedStrings: string[] = []
  let stylesDoc: Document | null = null
  for (const rel of rels.values()) {
    if (rel.external) continue
    if (rel.type.endsWith('/sharedStrings')) {
      const doc = xml(resolvePart(workbookPath, rel.target))
      if (doc !== null) sharedStrings = descendants(doc, 'si').map(richText)
    } else if (rel.type.endsWith('/styles')) {
      stylesDoc = xml(resolvePart(workbookPath, rel.target))
    }
  }
  const styles = readStyles(stylesDoc)

  const sheets: WorkbookSheet[] = []
  const sheetNames: string[] = []
  for (const sheet of descendants(workbookDoc, 'sheet')) {
    const sheetName = sheet.getAttribute('name')
    if (sheetName !== null) sheetNames.push(sheetName)
    const state = sheet.getAttribute('state')
    if (state === 'hidden' || state === 'veryHidden') continue
    const name = sheet.getAttribute('name') ?? `Sheet${sheets.length + 1}`
    const rel = rels.get(attrByLocal(sheet, 'id') ?? '')
    // Chart-only sheets (chartsheet) and external references are not made into tables.
    if (rel === undefined || rel.external || !rel.type.endsWith('/worksheet')) continue
    const path = resolvePart(workbookPath, rel.target)
    const doc = xml(path)
    const read: SheetRead =
      doc === null
        ? { rows: [], formulas: new Map(), richCells: new Set(), arrayFormulas: [] }
        : readSheet(doc, sharedStrings, styles, date1904)
    sheets.push({ name, rows: read.rows, path, facts: sheetFacts(doc, read, readSheetParts(xml, path)) })
  }
  // If there is a signature (`_xmlsignatures/`, or a macro signature), refuse editing (ARCHITECTURE 7.4.9.1).
  return { sheets, date1904, signature: workbookSignature(names), sheetNames }
}
