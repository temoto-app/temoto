/**
 * Writes cell values and formulas of `.xlsx` / `.xlsm` (TODO 1212 stages 1 / 2, wave 84 bundle E / wave 86 bundle D, ARCHITECTURE 7.4.9.1). **A home-grown diff rewrite**:
 * only the relevant `<c>` (and the added `<row>` / `<c>` and `<dimension>`) in the edited sheet's XML is rewritten as a string,
 * and `fullCalcOnLoad="1"` is added to `<calcPr>` of `workbook.xml`. Other parts stay as bytes inside the zip (`zip-rewrite.ts`).
 *
 * The only caller is `ViewerBroker.write` (a viewer whose draft has the shape `aios.xlsx-cells/1`, the manifest's `viewer.cellEdits`).
 * **The list of edits from the renderer / viewer is not trusted**: before writing, it is re-checked with the same rules as the viewer (`CellLockReason`), and if even one
 * hits, nothing is written and it is refused (`XlsxCellsError('locked')`).
 *
 * The XML is not made into a DOM (there is no DOMParser in main, and rebuilding changes attribute order, whitespace, and namespace spelling).
 * A small scanner that reads start tags while counting quotes picks up only the positions of `row` / `c` inside `sheetData`.
 *
 * Writing conventions (from the spike's "difficulties of a home-grown write-back"):
 *   - Strings are written as `t="inlineStr"` (`<is><t>`), so `sharedStrings.xml` is not touched.
 *   - The format number `s` is kept. A cell that is added inherits the row's format (`customFormat`) and then the column's (`<col style>`).
 *   - The parent and children of shared formulas, the range of array formulas, the inside of merges, table headers, pivot ranges, `cm` / `vm` cells, protected sheets, and
 *     signed workbooks (document signature, macro signature) are not written.
 *   - A formula (stage 2) writes only `<f>` and not the cached value `<v>` (aios does not calculate; Excel calculates with `fullCalcOnLoad`).
 *     The `<v>` of dependent cells stays stale (the viewer shows a "stale value" mark).
 *   - When a formula cell is overwritten with a value or emptied, `calcChain.xml` is dropped as a whole part (also its entries in rels and `[Content_Types].xml`).
 *     Leaving it would give an entry pointing at a non-formula cell and Excel would ask for repair. Formulas that were added or rewritten are rebuilt by Excel even if not listed.
 *   - The macros of an `.xlsm` (`xl/vbaProject.bin` and so on) are copied as bytes, like other parts.
 */
import { readEntry, readZip, rewriteZip, ZipRewriteError, type ZipArchive, type ZipEntry } from './zip-rewrite.js'
import {
  formatRef,
  normalizeFormulaInput,
  parseRange,
  parseRef,
  rangeContains,
  unknownSheetIn,
  workbookSignature,
  type CellEdit,
  type CellLockReason,
  type CellRange,
  type CellValue
} from '@shared/xlsx-cells.js'

/** Upper bound on unpacking one part (the same as the viewer's `MAX_PART_BYTES`). */
export const MAX_XLSX_PART_BYTES = 128 * 1024 * 1024

export type XlsxCellsErrorCode = 'locked' | 'unsupported' | 'bad-file'

/** Cannot write. `code` is the saving reason and `detail` is a short English text for logs (it contains no body or path). */
export class XlsxCellsError extends Error {
  constructor(
    readonly code: XlsxCellsErrorCode,
    readonly detail: string
  ) {
    super(`${code}: ${detail}`)
  }
}

// ---- Small XML scanner ----

export interface XmlTag {
  /** Position of `<`. */
  readonly start: number
  /** Position after `>`. */
  readonly end: number
  /** Namespace prefix (`x:`, or `''` if none). */
  readonly prefix: string
  readonly selfClosing: boolean
  /** The raw attribute string (from after the name up to before `>` / `/>`). */
  readonly attrsText: string
}

function tagPattern(local: string): RegExp {
  return new RegExp(`<([A-Za-z_][\\w.-]*:)?${local}(?=[\\s/>])`, 'g')
}

/** Returns, in order, the start tags with local name `local` from `from` onward (stopping at `to`). */
export function findTags(xml: string, local: string, from = 0, to = xml.length): XmlTag[] {
  const out: XmlTag[] = []
  const pattern = tagPattern(local)
  pattern.lastIndex = from
  for (;;) {
    const match = pattern.exec(xml)
    if (match === null || match.index >= to) break
    const tag = readTag(xml, match.index, match[1] ?? '', match[0].length)
    out.push(tag)
    pattern.lastIndex = tag.end
  }
  return out
}

/** The first start tag from `from` onward (null if none before `to`). */
function nextTag(xml: string, local: string, from: number, to: number): XmlTag | null {
  const pattern = tagPattern(local)
  pattern.lastIndex = from
  const match = pattern.exec(xml)
  if (match === null || match.index >= to) return null
  return readTag(xml, match.index, match[1] ?? '', match[0].length)
}

function readTag(xml: string, start: number, prefix: string, nameLength: number): XmlTag {
  let i = start + nameLength
  let quote: string | null = null
  for (; i < xml.length; i++) {
    const ch = xml[i]
    if (quote !== null) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') break
  }
  if (i >= xml.length) throw new XlsxCellsError('bad-file', 'unterminated-tag')
  const selfClosing = xml[i - 1] === '/'
  const attrsText = xml.slice(start + nameLength, selfClosing ? i - 1 : i)
  return { start, end: i + 1, prefix, selfClosing, attrsText }
}

/** Position of the closing tag `</prefix:local>` (throws if absent). */
function findClose(xml: string, tag: XmlTag, local: string): { readonly start: number; readonly end: number } {
  const close = `</${tag.prefix}${local}>`
  const at = xml.indexOf(close, tag.end)
  if (at < 0) throw new XlsxCellsError('bad-file', 'unclosed')
  return { start: at, end: at + close.length }
}

export interface XmlAttr {
  readonly name: string
  readonly value: string
  /** The raw string including leading whitespace (used as is when writing back). */
  readonly raw: string
}

export function parseAttrs(attrsText: string): XmlAttr[] {
  const out: XmlAttr[] = []
  const pattern = /(\s+)([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  for (let match = pattern.exec(attrsText); match !== null; match = pattern.exec(attrsText)) {
    out.push({ name: match[2] ?? '', value: decodeEntities(match[4] ?? match[5] ?? ''), raw: match[0] })
  }
  return out
}

function attr(attrs: readonly XmlAttr[], name: string): string | null {
  return attrs.find((a) => a.name === name)?.value ?? null
}

/** An attribute regardless of namespace prefix (`r:id`). */
function attrByLocal(attrs: readonly XmlAttr[], local: string): string | null {
  return attrs.find((a) => a.name === local || a.name.endsWith(`:${local}`))?.value ?? null
}

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-fA-F]+));/g, (all, name: string, dec?: string, hex?: string) => {
    if (dec !== undefined) return String.fromCodePoint(Number(dec))
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16))
    switch (name) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default:
        return all
    }
  })
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(text: string): string {
  return escapeXml(text).replace(/"/g, '&quot;')
}

/**
 * Turns a cell's string into OOXML characters. Control characters that XML 1.0 cannot hold become `_xHHHH_`, and text that already looks like `_xHHHH_` is
 * escaped with `_x005F_` (the ECMA-376 ST_Xstring rule, the same as Excel).
 */
export function encodeCellText(text: string): string {
  const escaped = text
    .replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_')
    // eslint-disable-next-line no-control-regex -- a regex that escapes control characters XML 1.0 cannot carry
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, (ch) => `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`)
  return escapeXml(escaped)
}

// ---- Part relationships ----

interface Relationship {
  readonly type: string
  readonly target: string
  readonly external: boolean
}

function readRels(xml: string | null): Map<string, Relationship> {
  const map = new Map<string, Relationship>()
  if (xml === null) return map
  for (const tag of findTags(xml, 'Relationship')) {
    const attrs = parseAttrs(tag.attrsText)
    const id = attr(attrs, 'Id')
    const target = attr(attrs, 'Target')
    if (id === null || target === null) continue
    map.set(id, { type: attr(attrs, 'Type') ?? '', target, external: attr(attrs, 'TargetMode') === 'External' })
  }
  return map
}

/** Turns a relative target seen from `base` (a part's path) into a path inside the zip (the same as the viewer's `resolvePart`). */
export function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.' && segment !== '') parts.push(segment)
  }
  return parts.join('/')
}

function relsPathOf(part: string): string {
  const slash = part.lastIndexOf('/')
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

class Parts {
  private readonly byName: Map<string, ZipEntry>
  readonly cache = new Map<string, string>()

  constructor(readonly zip: ZipArchive) {
    this.byName = new Map(zip.entries.map((entry) => [entry.name, entry]))
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  names(): string[] {
    return [...this.byName.keys()]
  }

  async text(name: string): Promise<string | null> {
    const cached = this.cache.get(name)
    if (cached !== undefined) return cached
    const entry = this.byName.get(name)
    if (entry === undefined) return null
    const bytes = await readEntry(this.zip, entry, MAX_XLSX_PART_BYTES)
    if (bytes.length >= 2 && ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe))) {
      throw new XlsxCellsError('unsupported', 'utf16-part')
    }
    let text: string
    try {
      text = decoder.decode(bytes)
    } catch {
      throw new XlsxCellsError('bad-file', 'not-utf8')
    }
    this.cache.set(name, text)
    return text
  }
}

// ---- Sheet facts (material for refusal reasons) ----

interface SheetLocks {
  readonly protectedSheet: boolean
  readonly merges: readonly CellRange[]
  readonly arrayFormulas: readonly CellRange[]
  readonly tableHeaders: readonly CellRange[]
  readonly pivots: readonly CellRange[]
}

async function sheetLocks(parts: Parts, sheetPath: string, xml: string): Promise<SheetLocks> {
  const protectedSheet = findTags(xml, 'sheetProtection').some((tag) => {
    const value = attr(parseAttrs(tag.attrsText), 'sheet')
    return value === '1' || value === 'true'
  })
  const merges: CellRange[] = []
  for (const tag of findTags(xml, 'mergeCell')) {
    const range = parseRange(attr(parseAttrs(tag.attrsText), 'ref') ?? '')
    if (range !== null) merges.push(range)
  }
  const arrayFormulas: CellRange[] = []
  for (const tag of findTags(xml, 'f')) {
    const attrs = parseAttrs(tag.attrsText)
    const type = attr(attrs, 't')
    if (type !== 'array' && type !== 'dataTable') continue
    const range = parseRange(attr(attrs, 'ref') ?? '')
    if (range !== null) arrayFormulas.push(range)
  }
  const tableHeaders: CellRange[] = []
  const pivots: CellRange[] = []
  const rels = readRels(await parts.text(relsPathOf(sheetPath)))
  for (const rel of rels.values()) {
    if (rel.external) continue
    if (rel.type.endsWith('/table')) {
      const table = await parts.text(resolvePart(sheetPath, rel.target))
      const tag = table === null ? undefined : findTags(table, 'table')[0]
      if (tag === undefined) continue
      const attrs = parseAttrs(tag.attrsText)
      const range = parseRange(attr(attrs, 'ref') ?? '')
      const headerRows = Number(attr(attrs, 'headerRowCount') ?? '1')
      if (range !== null && headerRows > 0) {
        tableHeaders.push({ r1: range.r1, c1: range.c1, r2: range.r1 + headerRows - 1, c2: range.c2 })
      }
    } else if (rel.type.endsWith('/pivotTable')) {
      const pivot = await parts.text(resolvePart(sheetPath, rel.target))
      const tag = pivot === null ? undefined : findTags(pivot, 'location')[0]
      const range = tag === undefined ? null : parseRange(attr(parseAttrs(tag.attrsText), 'ref') ?? '')
      if (range !== null) pivots.push(range)
    }
  }
  return { protectedSheet, merges, arrayFormulas, tableHeaders, pivots }
}

/** A reason decided by position alone (before looking at the cell's contents). */
function positionLock(locks: SheetLocks, row: number, col: number): CellLockReason | null {
  if (locks.protectedSheet) return 'protected'
  if (locks.merges.some((m) => rangeContains(m, row, col) && !(m.r1 === row && m.c1 === col))) return 'merged'
  if (locks.arrayFormulas.some((range) => rangeContains(range, row, col))) return 'arrayFormula'
  if (locks.tableHeaders.some((range) => rangeContains(range, row, col))) return 'tableHeader'
  if (locks.pivots.some((range) => rangeContains(range, row, col))) return 'pivot'
  return null
}

// ---- Rewriting a sheet ----

interface RowInfo {
  readonly index: number
  readonly tag: XmlTag
  /** End of the row element (for a self-closing one, the end of the start tag). */
  readonly end: number
  /** Range of the contents (empty for a self-closing one). */
  readonly innerStart: number
  readonly innerEnd: number
}

interface CellInfo {
  readonly col: number
  readonly tag: XmlTag
  readonly end: number
  readonly inner: string
}

function rowsOf(xml: string, from: number, to: number): RowInfo[] {
  const rows: RowInfo[] = []
  let next = 0
  let pos = from
  for (;;) {
    const tag = nextTag(xml, 'row', pos, to)
    if (tag === null) break
    const r = Number(attr(parseAttrs(tag.attrsText), 'r'))
    const index = Number.isSafeInteger(r) && r >= 1 ? r - 1 : next
    next = index + 1
    if (tag.selfClosing) {
      rows.push({ index, tag, end: tag.end, innerStart: tag.end, innerEnd: tag.end })
      pos = tag.end
    } else {
      const close = findClose(xml, tag, 'row')
      rows.push({ index, tag, end: close.end, innerStart: tag.end, innerEnd: close.start })
      pos = close.end
    }
  }
  return rows
}

function cellsOf(xml: string, row: RowInfo): CellInfo[] {
  const cells: CellInfo[] = []
  let next = 0
  let pos = row.innerStart
  for (;;) {
    const tag = nextTag(xml, 'c', pos, row.innerEnd)
    if (tag === null) break
    const ref = attr(parseAttrs(tag.attrsText), 'r')
    const at = ref === null ? null : parseRef(ref)
    const col = at?.col ?? next
    next = col + 1
    if (tag.selfClosing) {
      cells.push({ col, tag, end: tag.end, inner: '' })
      pos = tag.end
    } else {
      const close = findClose(xml, tag, 'c')
      cells.push({ col, tag, end: close.end, inner: xml.slice(tag.end, close.start) })
      pos = close.end
    }
  }
  return cells
}

function numberText(n: number): string {
  if (Object.is(n, -0)) return '0'
  return String(n)
}

/** A cell element. `attrsRaw` is the original attributes other than `t` (`r` / `s` for a new cell). */
function cellXml(prefix: string, attrsRaw: string, value: CellValue): string {
  switch (value.t) {
    case 'empty':
      return `<${prefix}c${attrsRaw}/>`
    case 'n':
      return `<${prefix}c${attrsRaw}><${prefix}v>${numberText(value.v)}</${prefix}v></${prefix}c>`
    case 'b':
      return `<${prefix}c${attrsRaw} t="b"><${prefix}v>${value.v ? 1 : 0}</${prefix}v></${prefix}c>`
    case 's':
      return (
        `<${prefix}c${attrsRaw} t="inlineStr"><${prefix}is><${prefix}t xml:space="preserve">` +
        `${encodeCellText(value.v)}</${prefix}t></${prefix}is></${prefix}c>`
      )
    case 'f':
      // The cached value `<v>` is not written (aios does not calculate, so there is no value). `t` is not set either (Excel decides the result type).
      return `<${prefix}c${attrsRaw}><${prefix}f>${escapeXml(value.v)}</${prefix}f></${prefix}c>`
  }
}

/** The start tag of `<f>` in a cell's contents (null if none). */
function formulaTagOf(inner: string): XmlTag | null {
  return nextTag(inner, 'f', 0, inner.length)
}

interface ColumnStyle {
  readonly min: number
  readonly max: number
  readonly style: string
}

function columnStyles(xml: string, sheetDataStart: number): ColumnStyle[] {
  const out: ColumnStyle[] = []
  for (const tag of findTags(xml, 'col', 0, sheetDataStart)) {
    const attrs = parseAttrs(tag.attrsText)
    const style = attr(attrs, 'style')
    const min = Number(attr(attrs, 'min'))
    const max = Number(attr(attrs, 'max'))
    if (style !== null && style !== '0' && Number.isInteger(min) && Number.isInteger(max)) out.push({ min, max, style })
  }
  return out
}

/** The format of a new cell: the row's format (`customFormat`), then the column's. null if none. */
function inheritedStyle(rowAttrs: readonly XmlAttr[] | null, cols: readonly ColumnStyle[], col: number): string | null {
  if (rowAttrs !== null) {
    const custom = attr(rowAttrs, 'customFormat')
    const s = attr(rowAttrs, 's')
    if ((custom === '1' || custom === 'true') && s !== null && s !== '0') return s
  }
  const hit = cols.find((c) => col + 1 >= c.min && col + 1 <= c.max)
  return hit?.style ?? null
}

function newCellAttrs(row: number, col: number, style: string | null): string {
  return ` r="${formatRef(row, col)}"${style === null ? '' : ` s="${escapeAttr(style)}"`}`
}

/** Attributes of a start tag with `spans="1:4"` widened to the new column. As is if there is no `spans`. */
function widenSpans(attrs: readonly XmlAttr[], cols: readonly number[]): string {
  return attrs
    .map((a) => {
      if (a.name !== 'spans' || cols.length === 0) return a.raw
      const match = /^(\d+):(\d+)$/.exec(a.value)
      if (match === null) return a.raw
      const lo = Math.min(Number(match[1]), ...cols.map((c) => c + 1))
      const hi = Math.max(Number(match[2]), ...cols.map((c) => c + 1))
      return ` spans="${lo}:${hi}"`
    })
    .join('')
}

interface Splice {
  readonly start: number
  readonly end: number
  readonly text: string
}

function applySplices(xml: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => a.start - b.start || a.end - b.end)
  let out = ''
  let pos = 0
  for (const splice of sorted) {
    if (splice.start < pos) throw new XlsxCellsError('bad-file', 'overlap')
    out += xml.slice(pos, splice.start) + splice.text
    pos = splice.end
  }
  return out + xml.slice(pos)
}

function unionRange(a: CellRange | null, row: number, col: number): CellRange {
  if (a === null) return { r1: row, c1: col, r2: row, c2: col }
  return { r1: Math.min(a.r1, row), c1: Math.min(a.c1, col), r2: Math.max(a.r2, row), c2: Math.max(a.c2, col) }
}

function rangeText(range: CellRange): string {
  const a = formatRef(range.r1, range.c1)
  const b = formatRef(range.r2, range.c2)
  return a === b ? a : `${a}:${b}`
}

export interface SheetPatch {
  readonly xml: string
  /** A formula cell was overwritten with a value or emptied (`calcChain.xml` is dropped). */
  readonly removedFormula: boolean
}

/** Applies edits to one sheet's XML. Throws if a refusal reason applies. */
export function patchSheetXml(xml: string, edits: readonly CellEdit[], locks: SheetLocks): SheetPatch {
  const sheetData = findTags(xml, 'sheetData')[0]
  if (sheetData === undefined) throw new XlsxCellsError('bad-file', 'no-sheetData')
  const prefix = sheetData.prefix
  const sheetDataClose = sheetData.selfClosing ? null : findClose(xml, sheetData, 'sheetData')
  const dataEnd = sheetDataClose?.start ?? sheetData.end
  const cols = columnStyles(xml, sheetData.start)

  // Group by row (in column order).
  const byRow = new Map<number, { col: number; edit: CellEdit }[]>()
  for (const edit of edits) {
    const at = parseRef(edit.ref)
    if (at === null) throw new XlsxCellsError('unsupported', 'bad-ref')
    const lock = positionLock(locks, at.row, at.col)
    if (lock !== null) throw new XlsxCellsError('locked', lock)
    const list = byRow.get(at.row)
    if (list === undefined) byRow.set(at.row, [{ col: at.col, edit }])
    else list.push({ col: at.col, edit })
  }
  for (const list of byRow.values()) list.sort((a, b) => a.col - b.col)

  const rows = sheetData.selfClosing ? [] : rowsOf(xml, sheetData.end, dataEnd)
  const rowByIndex = new Map<number, RowInfo>()
  for (const row of rows) rowByIndex.set(row.index, row)

  const splices: Splice[] = []
  let removedFormula = false
  /** Rows to add (insertion position -> list of row XML). */
  const newRows = new Map<number, string[]>()
  let dimension: CellRange | null = null

  for (const [rowIndex, all] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    const row = rowByIndex.get(rowIndex)
    const existing = new Set(row === undefined ? [] : cellsOf(xml, row).map((cell) => cell.col))
    // An edit that empties a cell that does not exist does nothing (no empty `<c>` is added).
    const list = all.filter((item) => item.edit.value.t !== 'empty' || existing.has(item.col))
    if (list.length === 0) continue
    for (const item of list) if (item.edit.value.t !== 'empty') dimension = unionRange(dimension, rowIndex, item.col)
    if (row === undefined) {
      // No such row: add it, inheriting only the column's format. The insertion position is before the next row (or the end of sheetData if none).
      const cells = list.map((item) => cellXml(prefix, newCellAttrs(rowIndex, item.col, inheritedStyle(null, cols, item.col)), item.edit.value))
      const after = rows.find((r) => r.index > rowIndex)
      const at = after?.tag.start ?? dataEnd
      const text = `<${prefix}row r="${rowIndex + 1}">${cells.join('')}</${prefix}row>`
      const pending = newRows.get(at)
      if (pending === undefined) newRows.set(at, [text])
      else pending.push(text)
      continue
    }
    const rowAttrs = parseAttrs(row.tag.attrsText)
    const cells = cellsOf(xml, row)
    const byCol = new Map<number, CellInfo>()
    for (const cell of cells) byCol.set(cell.col, cell)
    const added: number[] = []
    for (const item of list) {
      const cell = byCol.get(item.col)
      if (cell === undefined) {
        added.push(item.col)
        continue
      }
      const attrs = parseAttrs(cell.tag.attrsText)
      if (attr(attrs, 'cm') !== null || attr(attrs, 'vm') !== null) throw new XlsxCellsError('locked', 'richValue')
      const formula = formulaTagOf(cell.inner)
      if (formula !== null) {
        const type = attr(parseAttrs(formula.attrsText), 't')
        if (type === 'shared') throw new XlsxCellsError('locked', 'sharedFormula')
        if (type !== null && type !== 'normal') throw new XlsxCellsError('locked', 'arrayFormula')
        if (item.edit.value.t !== 'f') removedFormula = true
      }
    }
    // Rebuild the row element: the original cells and the text between them stay as they are, edited cells are replaced, and added cells are inserted in column order.
    let inner = ''
    let pos = row.innerStart
    const pendingNew = list.filter((item) => !byCol.has(item.col))
    let k = 0
    for (const cell of cells) {
      while (k < pendingNew.length && (pendingNew[k]?.col ?? 0) < cell.col) {
        const item = pendingNew[k++]
        if (item !== undefined) inner += cellXml(prefix, newCellAttrs(rowIndex, item.col, inheritedStyle(rowAttrs, cols, item.col)), item.edit.value)
      }
      inner += xml.slice(pos, cell.tag.start)
      const edit = list.find((item) => item.col === cell.col)
      if (edit === undefined) inner += xml.slice(cell.tag.start, cell.end)
      else {
        const keep = parseAttrs(cell.tag.attrsText)
          .filter((a) => a.name !== 't')
          .map((a) => a.raw)
          .join('')
        inner += cellXml(cell.tag.prefix, keep, edit.edit.value)
      }
      pos = cell.end
    }
    while (k < pendingNew.length) {
      const item = pendingNew[k++]
      if (item !== undefined) inner += cellXml(prefix, newCellAttrs(rowIndex, item.col, inheritedStyle(rowAttrs, cols, item.col)), item.edit.value)
    }
    inner += xml.slice(pos, row.innerEnd)
    const rowPrefix = row.tag.prefix
    const startTag = `<${rowPrefix}row${widenSpans(rowAttrs, added)}>`
    splices.push({ start: row.tag.start, end: row.end, text: `${startTag}${inner}</${rowPrefix}row>` })
  }

  for (const [at, texts] of newRows) splices.push({ start: at, end: at, text: texts.join('') })
  if (sheetData.selfClosing && newRows.size > 0) {
    // Make `<sheetData/>` the open-and-close form (the insertion above is at sheetData.end = after the self-closing tag, so rebuild it).
    const inner = [...newRows.values()].flat().join('')
    splices.length = 0
    splices.push({
      start: sheetData.start,
      end: sheetData.end,
      text: `<${prefix}sheetData${sheetData.attrsText}>${inner}</${prefix}sheetData>`
    })
  }

  // Widen `<dimension ref>` up to the edited cell (it is never shrunk).
  const dim = findTags(xml, 'dimension', 0, sheetData.start)[0]
  if (dim !== undefined && dimension !== null) {
    const attrs = parseAttrs(dim.attrsText)
    const current = parseRange(attr(attrs, 'ref') ?? '')
    let merged = current
    if (merged === null) merged = dimension
    else {
      merged = unionRange(merged, dimension.r1, dimension.c1)
      merged = unionRange(merged, dimension.r2, dimension.c2)
    }
    const raw = attrs.map((a) => (a.name === 'ref' ? ` ref="${rangeText(merged)}"` : a.raw)).join('')
    const hasRef = attrs.some((a) => a.name === 'ref')
    splices.push({
      start: dim.start,
      end: dim.end,
      text: `<${dim.prefix}dimension${hasRef ? raw : `${raw} ref="${rangeText(merged)}"`}${dim.selfClosing ? '/>' : '>'}`
    })
  }
  return { xml: applySplices(xml, splices), removedFormula }
}

/** Children of `workbook` that may come after `<calcPr>` (the order of CT_Workbook). */
const AFTER_CALC_PR = [
  'oleSize',
  'customWorkbookViews',
  'pivotCaches',
  'smartTagPr',
  'smartTagTypes',
  'webPublishing',
  'fileRecoveryPr',
  'webPublishObjects',
  'extLst'
]

/** Adds `fullCalcOnLoad="1"` to `workbook.xml` (Excel recalculates everything on open). */
export function patchWorkbookXml(xml: string): string {
  const root = findTags(xml, 'workbook')[0]
  if (root === undefined || root.selfClosing) throw new XlsxCellsError('bad-file', 'no-workbook')
  const calc = findTags(xml, 'calcPr')[0]
  if (calc !== undefined) {
    const attrs = parseAttrs(calc.attrsText)
    if (attr(attrs, 'fullCalcOnLoad') === '1' || attr(attrs, 'fullCalcOnLoad') === 'true') return xml
    const raw = attrs.filter((a) => a.name !== 'fullCalcOnLoad').map((a) => a.raw).join('')
    const text = `<${calc.prefix}calcPr${raw} fullCalcOnLoad="1"${calc.selfClosing ? '/>' : '>'}`
    return xml.slice(0, calc.start) + text + xml.slice(calc.end)
  }
  const close = findClose(xml, root, 'workbook')
  let at = close.start
  for (const local of AFTER_CALC_PR) {
    const tag = findTags(xml, local, root.end, close.start)[0]
    if (tag !== undefined && tag.start < at) at = tag.start
  }
  return `${xml.slice(0, at)}<${root.prefix}calcPr fullCalcOnLoad="1"/>${xml.slice(at)}`
}

// ---- Entry point ----

/**
 * Removes from the XML the elements with local name `local` that satisfy `match` (whether self-closing or open-and-close).
 * Surrounding whitespace and newlines are kept (it closes up by the amount of the removed element).
 */
function removeElements(xml: string, local: string, match: (attrs: readonly XmlAttr[]) => boolean): string {
  const splices: Splice[] = []
  for (const tag of findTags(xml, local)) {
    if (!match(parseAttrs(tag.attrsText))) continue
    const end = tag.selfClosing ? tag.end : findClose(xml, tag, local).end
    splices.push({ start: tag.start, end, text: '' })
  }
  return splices.length === 0 ? xml : applySplices(xml, splices)
}

/**
 * Drops `calcChain.xml` as a whole part (when a formula cell was overwritten with a value). The workbook's rels entry and the `Override` in `[Content_Types].xml`
 * are also removed: leaving only one would give a relationship / type pointing at a missing part, and Excel would ask for repair.
 */
async function dropCalcChain(
  parts: Parts,
  workbookPath: string,
  replacements: Map<string, Buffer>,
  removals: Set<string>
): Promise<void> {
  const relsPath = relsPathOf(workbookPath)
  const relsXml = await parts.text(relsPath)
  if (relsXml === null) return
  const isCalcChain = (attrs: readonly XmlAttr[]): boolean =>
    (attr(attrs, 'Type') ?? '').endsWith('/calcChain') && attr(attrs, 'TargetMode') !== 'External'
  const targets = findTags(relsXml, 'Relationship')
    .map((tag) => parseAttrs(tag.attrsText))
    .filter(isCalcChain)
    .map((attrs) => resolvePart(workbookPath, attr(attrs, 'Target') ?? ''))
  if (targets.length === 0) return
  replacements.set(relsPath, Buffer.from(removeElements(relsXml, 'Relationship', isCalcChain), 'utf8'))
  for (const target of targets) if (parts.has(target)) removals.add(target)
  const typesXml = await parts.text('[Content_Types].xml')
  if (typesXml !== null) {
    const names = new Set(targets.map((target) => `/${target}`.toLowerCase()))
    const next = removeElements(typesXml, 'Override', (attrs) => names.has((attr(attrs, 'PartName') ?? '').toLowerCase()))
    if (next !== typesXml) replacements.set('[Content_Types].xml', Buffer.from(next, 'utf8'))
  }
}

/** New bytes made by applying edits to the bytes of an `.xlsx` / `.xlsm`. `XlsxCellsError` when refusing. */
export async function applyCellEdits(file: Buffer, edits: readonly CellEdit[]): Promise<Buffer> {
  if (file.length >= 4 && file.readUInt32BE(0) === 0xd0cf11e0) {
    // CFB (an encrypted .xlsx, an old .xls).
    throw new XlsxCellsError('unsupported', 'cfb')
  }
  let zip: ZipArchive
  try {
    zip = readZip(file)
  } catch (err) {
    if (err instanceof ZipRewriteError) throw new XlsxCellsError(err.message === 'not-a-zip' ? 'bad-file' : 'unsupported', err.message)
    throw err
  }
  const parts = new Parts(zip)
  try {
    const signature = workbookSignature(parts.names())
    if (signature !== null) throw new XlsxCellsError('locked', signature)
    const rootRels = readRels(await parts.text('_rels/.rels'))
    let workbookPath = 'xl/workbook.xml'
    for (const rel of rootRels.values()) {
      if (rel.type.endsWith('/officeDocument') && !rel.external) workbookPath = resolvePart('', rel.target)
    }
    const workbookXml = await parts.text(workbookPath)
    if (workbookXml === null) throw new XlsxCellsError('bad-file', 'no-workbook')
    const rels = readRels(await parts.text(relsPathOf(workbookPath)))
    const worksheets = new Set<string>()
    /** Sheet names a formula may refer to (all of them, including hidden sheets and chart sheets). */
    const sheetNames: string[] = []
    for (const tag of findTags(workbookXml, 'sheet')) {
      const sheetAttrs = parseAttrs(tag.attrsText)
      const name = attr(sheetAttrs, 'name')
      if (name !== null) sheetNames.push(name)
      const rel = rels.get(attrByLocal(sheetAttrs, 'id') ?? '')
      if (rel !== undefined && !rel.external && rel.type.endsWith('/worksheet')) {
        worksheets.add(resolvePart(workbookPath, rel.target))
      }
    }
    const bySheet = new Map<string, CellEdit[]>()
    for (const edit of edits) {
      if (!worksheets.has(edit.sheet)) throw new XlsxCellsError('unsupported', 'not-a-worksheet')
      if (edit.value.t === 'f') {
        // The shape was checked by `parseCellEdits`. A reference to a sheet that is not in the workbook is treated by Excel as an external reference, so refuse it.
        const checked = normalizeFormulaInput(edit.value.v)
        if (!checked.ok || checked.formula !== edit.value.v) throw new XlsxCellsError('unsupported', 'formula')
        if (unknownSheetIn(checked.sheets, sheetNames)) throw new XlsxCellsError('unsupported', 'formula-unknown-sheet')
      }
      const list = bySheet.get(edit.sheet)
      if (list === undefined) bySheet.set(edit.sheet, [edit])
      else list.push(edit)
    }
    const replacements = new Map<string, Buffer>()
    let removedFormula = false
    for (const [sheetPath, list] of bySheet) {
      const xml = await parts.text(sheetPath)
      if (xml === null) throw new XlsxCellsError('bad-file', 'missing-sheet')
      const locks = await sheetLocks(parts, sheetPath, xml)
      const patched = patchSheetXml(xml, list, locks)
      if (patched.removedFormula) removedFormula = true
      replacements.set(sheetPath, Buffer.from(patched.xml, 'utf8'))
    }
    if (replacements.size === 0) return file
    const nextWorkbook = patchWorkbookXml(workbookXml)
    if (nextWorkbook !== workbookXml) replacements.set(workbookPath, Buffer.from(nextWorkbook, 'utf8'))
    const removals = new Set<string>()
    if (removedFormula) await dropCalcChain(parts, workbookPath, replacements, removals)
    return await rewriteZip(zip, replacements, removals)
  } catch (err) {
    if (err instanceof ZipRewriteError) throw new XlsxCellsError(err.message === 'part-too-large' ? 'unsupported' : 'bad-file', err.message)
    throw err
  }
}
