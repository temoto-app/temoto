/**
 * Extraction of Office (OOXML: `.docx` / `.xlsx` / `.xlsm` / `.pptx`) bodies (TODO 997, 1239, ARCHITECTURE.md 6.2 / 6.5).
 *
 * **The extracted text is kept nowhere** (constraint 9). A chunk's byte range is "a position inside the text this module returns",
 * so **extraction must be deterministic**: the same bytes always give the same string (independent of time, randomness and environment).
 * When the output shape changes, raise `OOXML_EXTRACTOR_VERSION` (it goes into the version of fs rows, and raising it re-indexes: `fsVersion` in `store.ts`).
 *
 * The zip is read with our own small reader (`plugins/aios.zip` / `plugins/aios.office` are inside the plugin boundary, so they are not imported:
 * constraint 8). Inflation uses the asynchronous `inflateRaw` of `node:zlib` (it runs on a libuv thread and does not hold the index process's JS thread),
 * with `maxOutputLength` attached to stop a part that grows beyond its declaration (a zip bomb) midway. XML is not turned into a DOM; the sequence of tags and
 * characters is swept once with a regular expression (all that is needed is the characters and paragraph breaks).
 *
 * Defenses (the premise is reading a crafted file):
 *  - Number of entries (`MAX_ZIP_ENTRIES`), size of one part after inflation (`MAX_PART_BYTES`), total inflation (`MAX_INFLATED_BYTES`),
 *    and overall time (`OOXML_TIME_BUDGET_MS`). Exceeding any gives `OoxmlError` (the caller makes it `skipped`).
 *  - The extracted text goes up to the first `limitBytes` (UTF-8). Once reached, the remaining parts are not read.
 *  - Encrypted entries, compression other than stored / deflate, and zip64 are not read (Office documents do not need them).
 *  - Part names only resolve the `_rels` target inside the zip and are never used as a disk path.
 */
import { inflateRaw } from 'node:zlib'

/** Version of the extraction. Raise it when the output shape (order of parts, separators, target elements) changes. It goes into the version of fs rows. */
export const OOXML_EXTRACTOR_VERSION = 1

export type OoxmlKind = 'docx' | 'xlsx' | 'pptx'

/** Upper bound on the number of entries in the central directory. Office documents have dozens to thousands (thousands even for a pptx with many images). */
export const MAX_ZIP_ENTRIES = 20_000
/** Upper bound (bytes) of one part after inflation. The sheet XML of a large xlsx reaches tens of MB. */
export const MAX_PART_BYTES = 64 * 1024 * 1024
/** Upper bound (bytes) of the total inflated for one file. */
export const MAX_INFLATED_BYTES = 96 * 1024 * 1024
/** Upper bound (ms) of the time to extract one file. When exceeded it gives up (not re-taken until the version changes). */
export const OOXML_TIME_BUDGET_MS = 5_000

export type OoxmlErrorReason =
  | 'not-zip'
  | 'corrupt'
  | 'unsupported'
  | 'encrypted'
  | 'too-many-entries'
  | 'too-large'
  | 'timeout'
  | 'no-main-part'

/** Cannot be extracted. Carries only `reason` (so that fragments of the body are not written to logs). */
export class OoxmlError extends Error {
  constructor(readonly reason: OoxmlErrorReason) {
    super(reason)
  }
}

export interface OoxmlLimits {
  readonly limitBytes: number
  readonly timeBudgetMs?: number
  readonly maxEntries?: number
  readonly maxPartBytes?: number
  readonly maxInflatedBytes?: number
  readonly now?: () => number
}

export interface OoxmlText {
  readonly text: string
  /** Cut at `limitBytes` (the remaining parts / rows were not read). */
  readonly truncated: boolean
}

/**
 * Extension (no dot, lowercase) -> kind. `.xlsm` (a workbook with macros, TODO 1239) has the same sequence of parts as `.xlsx`, so it uses the
 * same extraction. The macro parts (`xl/vbaProject.bin`, etc.) are not read (only the sheet XML is looked at).
 */
export function ooxmlKindOf(ext: string): OoxmlKind | null {
  if (ext === 'xlsm') return 'xlsx'
  return ext === 'docx' || ext === 'xlsx' || ext === 'pptx' ? ext : null
}

// ---- zip ----

interface ZipEntry {
  readonly name: string
  readonly flags: number
  readonly method: number
  readonly compressedSize: number
  readonly size: number
  readonly localOffset: number
}

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

function readCentralDirectory(buf: Buffer, maxEntries: number): Map<string, ZipEntry> {
  if (buf.byteLength < 22 || buf.readUInt32LE(0) !== SIG_LOCAL) throw new OoxmlError('not-zip')
  let eocd = -1
  const stop = Math.max(0, buf.byteLength - 22 - 0xffff)
  for (let i = buf.byteLength - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new OoxmlError('not-zip')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new OoxmlError('unsupported')
  if (count > maxEntries) throw new OoxmlError('too-many-entries')
  if (cdOffset + cdSize > buf.byteLength) throw new OoxmlError('corrupt')
  const entries = new Map<string, ZipEntry>()
  let at = cdOffset
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buf.byteLength || buf.readUInt32LE(at) !== SIG_CENTRAL) throw new OoxmlError('corrupt')
    const flags = buf.readUInt16LE(at + 8)
    const method = buf.readUInt16LE(at + 10)
    const compressedSize = buf.readUInt32LE(at + 20)
    const size = buf.readUInt32LE(at + 24)
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength = buf.readUInt16LE(at + 32)
    const localOffset = buf.readUInt32LE(at + 42)
    if (at + 46 + nameLength > buf.byteLength) throw new OoxmlError('corrupt')
    // OOXML part names are ASCII (ECMA-376 Part 2). Reading them as UTF-8 is enough.
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength)
    // If the same name appears twice, the first is used (it only has to be deterministic).
    if (!entries.has(name)) entries.set(name, { name, flags, method, compressedSize, size, localOffset })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Looks up with case folded for names (some tools write part names in uppercase, even other than `[Content_Types].xml`). */
function findEntry(entries: Map<string, ZipEntry>, name: string): ZipEntry | undefined {
  const exact = entries.get(name)
  if (exact !== undefined) return exact
  const folded = name.toLowerCase()
  for (const entry of entries.values()) if (entry.name.toLowerCase() === folded) return entry
  return undefined
}

function inflateAsync(data: Buffer, maxOutputLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    inflateRaw(data, { maxOutputLength }, (err, out) => (err === null ? resolve(out) : reject(err)))
  })
}

class Reader {
  private inflated = 0
  private readonly deadline: number
  private readonly now: () => number
  private readonly maxPartBytes: number
  private readonly maxInflatedBytes: number

  constructor(
    private readonly buf: Buffer,
    readonly entries: Map<string, ZipEntry>,
    limits: OoxmlLimits
  ) {
    this.now = limits.now ?? Date.now
    this.deadline = this.now() + (limits.timeBudgetMs ?? OOXML_TIME_BUDGET_MS)
    this.maxPartBytes = limits.maxPartBytes ?? MAX_PART_BYTES
    this.maxInflatedBytes = limits.maxInflatedBytes ?? MAX_INFLATED_BYTES
  }

  checkTime(): void {
    if (this.now() > this.deadline) throw new OoxmlError('timeout')
  }

  /** Reads a part as a string. null if absent. */
  async part(name: string): Promise<string | null> {
    this.checkTime()
    const entry = findEntry(this.entries, name)
    if (entry === undefined) return null
    if ((entry.flags & 0x1) !== 0) throw new OoxmlError('encrypted')
    const { buf } = this
    const at = entry.localOffset
    if (at + 30 > buf.byteLength || buf.readUInt32LE(at) !== SIG_LOCAL) throw new OoxmlError('corrupt')
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)
    const end = start + entry.compressedSize
    if (end > buf.byteLength) throw new OoxmlError('corrupt')
    const room = Math.min(this.maxPartBytes, this.maxInflatedBytes - this.inflated)
    if (entry.size > room) throw new OoxmlError('too-large')
    let out: Buffer
    if (entry.method === 0) {
      out = buf.subarray(start, end)
      if (out.byteLength > room) throw new OoxmlError('too-large')
    } else if (entry.method === 8) {
      try {
        // The declaration (`entry.size`) can lie, so the cap is applied not by the declaration but by the remaining budget.
        out = await inflateAsync(buf.subarray(start, end), Math.max(1, room))
      } catch (err) {
        if (err instanceof RangeError || (err as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new OoxmlError('too-large')
        }
        throw new OoxmlError('corrupt')
      }
    } else {
      throw new OoxmlError('unsupported')
    }
    this.inflated += out.byteLength
    this.checkTime()
    return out.toString('utf8')
  }
}

// ---- XML ----

const ENTITY = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(ENTITY, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED[name] ?? whole
    const code = dec !== undefined ? Number(dec) : parseInt(hex ?? '', 16)
    // An invalid code point is dropped (deterministically; it does not become U+FFFD).
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ''
    return String.fromCodePoint(code)
  })
}

function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon < 0 ? name : name.slice(colon + 1)
}

const ATTR_PATTERNS = new Map<string, RegExp>()

/** Looks up an attribute by local name (`r:id` -> `id`). `sheetId` etc. are different names and do not match. */
function attr(attrs: string, local: string): string | null {
  // xlsx looks attributes up per cell, so the regular expression is built only once per name.
  let re = ATTR_PATTERNS.get(local)
  if (re === undefined) {
    re = new RegExp(`(?:^|\\s)(?:[\\w.\\-]+:)?${local}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)
    ATTR_PATTERNS.set(local, re)
  }
  const match = re.exec(attrs)
  if (match === null) return null
  return decodeEntities(match[1] ?? match[2] ?? '')
}

/**
 * The relationship id (`r:id`). Looks only at the `id` with a prefix: the pptx `<p:sldId id="256" r:id="rId2"/>` also has an `id`
 * without a prefix (the slide number).
 */
function relId(attrs: string): string | null {
  const match = /(?:^|\s)[\w.-]+:id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs)
  return match === null ? null : decodeEntities(match[1] ?? match[2] ?? '')
}

interface XmlHandler {
  open?(local: string, attrs: string, empty: boolean): void
  close?(local: string): void
  text?(text: string): void
}

/** Interval (in tokens) at which the time limit is checked. */
const TIME_CHECK_EVERY = 4096
/** Interval (in characters) at which the time limit is checked while walking inside one tag. */
const TIME_CHECK_CHARS = 1 << 20

/**
 * Remembers the "not found" of `indexOf`. If it was not found at a position, it is not there from any later position either, so an unclosed `<!--` / `<?` / `"` does not
 * make the sweep to the end start over however many times it appears (when written as a regular expression, `'<a '.repeat(n)` was O(n^2): review of wave 53).
 */
class Finder {
  private readonly none = new Map<string, number>()

  constructor(private readonly xml: string) {}

  find(needle: string, from: number): number {
    const none = this.none.get(needle)
    if (none !== undefined && from >= none) return -1
    const at = this.xml.indexOf(needle, from)
    if (at < 0) this.none.set(needle, none === undefined ? from : Math.min(none, from))
    return at
  }
}

/** `[A-Za-z_]` */
function isNameStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
}

/** `[\w.-]` */
function isNameChar(c: number): boolean {
  return isNameStart(c) || (c >= 48 && c <= 57) || c === 46 || c === 45
}

/**
 * Sweeps the XML once and passes tags, CDATA and characters to `handler`. No DOM is built. A `>` inside an attribute value is let through.
 * Linear: each character is looked at a constant number of times at most. On meeting an unclosed construct (no `>` / `?>` / closing quote up to the end) it
 * stops there: valid XML never has one, and advancing one character at a time without stopping would be O(n^2). A `<` with no name (`< ` or
 * `</ `) is dropped, just that `<`, and it continues (the same as the earlier regular expression). Comments, processing instructions and `<!DOCTYPE …>` are skipped.
 */
function walkXml(xml: string, handler: XmlHandler, reader: Reader, out: TextOut | null): void {
  const finder = new Finder(xml)
  const len = xml.length
  let n = 0
  let p = 0
  while (p < len) {
    n += 1
    if (n % TIME_CHECK_EVERY === 0) {
      reader.checkTime()
      if (out !== null && out.full) return
    }
    if (xml.charCodeAt(p) !== 60 /* < */) {
      const lt = finder.find('<', p)
      const end = lt < 0 ? len : lt
      handler.text?.(decodeEntities(xml.slice(p, end)))
      p = end
      continue
    }
    const c1 = xml.charCodeAt(p + 1)
    if (c1 === 33 /* ! */) {
      if (xml.startsWith('!--', p + 1)) {
        const close = finder.find('-->', p + 4)
        if (close >= 0) {
          p = close + 3
          continue
        }
      } else if (xml.startsWith('![CDATA[', p + 1)) {
        const close = finder.find(']]>', p + 9)
        if (close >= 0) {
          handler.text?.(xml.slice(p + 9, close))
          p = close + 3
          continue
        }
      }
      // `<!DOCTYPE …>` etc. (an unclosed comment / CDATA falls here too: the same as `![^>]*>` of the earlier regular expression).
      const gt = finder.find('>', p + 2)
      if (gt < 0) return
      p = gt + 1
      continue
    }
    if (c1 === 63 /* ? */) {
      const close = finder.find('?>', p + 2)
      if (close < 0) return
      p = close + 2
      continue
    }
    // A tag: opening, closing or self-closing, with a name and attributes.
    const closing = c1 === 47 /* / */
    const nameStart = closing ? p + 2 : p + 1
    if (!isNameStart(xml.charCodeAt(nameStart))) {
      // A `<` with no name is dropped, and what follows is read as characters.
      const lt = finder.find('<', p + 1)
      const end = lt < 0 ? len : lt
      if (end > p + 1) handler.text?.(decodeEntities(xml.slice(p + 1, end)))
      p = end
      continue
    }
    let q = nameStart + 1
    while (q < len && isNameChar(xml.charCodeAt(q))) q += 1
    if (xml.charCodeAt(q) === 58 /* : */ && q + 1 < len && isNameChar(xml.charCodeAt(q + 1))) {
      q += 2
      while (q < len && isNameChar(xml.charCodeAt(q))) q += 1
    }
    const nameEnd = q
    // Attributes: up to the first `>` outside quotes.
    let gt = -1
    let walked = 0
    while (q < len) {
      const c = xml.charCodeAt(q)
      if (c === 62 /* > */) {
        gt = q
        break
      }
      if (c === 34 /* " */ || c === 39 /* ' */) {
        const close = finder.find(c === 34 ? '"' : "'", q + 1)
        if (close < 0) return
        q = close + 1
        continue
      }
      q += 1
      walked += 1
      if (walked % TIME_CHECK_CHARS === 0) reader.checkTime()
    }
    if (gt < 0) return
    const local = localName(xml.slice(nameStart, nameEnd))
    if (closing) handler.close?.(local)
    else {
      // The `/` of `/>` is outside quotes (right after a closing quote it is not a `/`).
      const empty = gt > nameEnd && xml.charCodeAt(gt - 1) === 47
      handler.open?.(local, xml.slice(nameEnd, empty ? gt - 1 : gt), empty)
      if (empty) handler.close?.(local)
    }
    p = gt + 1
  }
}

/** A pool for the extracted text. Becomes `full` when it reaches `limit` bytes in UTF-8. */
class TextOut {
  private readonly parts: string[] = []
  private bytes = 0
  full = false

  constructor(private readonly limit: number) {}

  push(text: string): void {
    if (this.full || text === '') return
    this.parts.push(text)
    this.bytes += Buffer.byteLength(text, 'utf8')
    if (this.bytes >= this.limit) this.full = true
  }

  /** End of a line (not added if the previous one is already a newline: empty paragraphs are collapsed). */
  newline(): void {
    const last = this.parts[this.parts.length - 1]
    if (last === undefined || last.endsWith('\n')) return
    this.push('\n')
  }

  /** Separator between parts (one blank line). */
  separator(): void {
    if (this.parts.length === 0) return
    this.newline()
    const last = this.parts[this.parts.length - 1] ?? ''
    if (!last.endsWith('\n\n')) this.push('\n')
  }

  result(): OoxmlText {
    const text = this.parts.join('')
    const buffer = Buffer.from(text, 'utf8')
    if (buffer.byteLength <= this.limit) return { text, truncated: this.full }
    // Cut at the limit. Do not cut in the middle of a character (go back to the lead byte).
    let end = this.limit
    while (end > 0 && ((buffer[end] as number) & 0xc0) === 0x80) end -= 1
    return { text: buffer.subarray(0, end).toString('utf8'), truncated: true }
  }
}

/**
 * A part of prose with paragraphs (docx body and notes, pptx slides and notes). Picks up only the characters inside `t`,
 * a newline at the end of `p`, a tab for `tab`, and a newline for `br` / `cr`. Phonetic guides (`rt` = Word's ruby, `rPh` = Excel) are not picked up.
 * `delText` (deletions in tracked changes) and `instrText` (field instructions) are not `t`, so they are not picked up.
 */
function proseOf(xml: string, reader: Reader, out: TextOut): void {
  let inText = 0
  let inRun = 0
  let skip = 0
  walkXml(
    xml,
    {
      open(local, _attrs, empty) {
        if (local === 'rt' || local === 'rPh') {
          if (!empty) skip += 1
        } else if (local === 't') {
          if (!empty) inText += 1
        } else if (local === 'r') {
          if (!empty) inRun += 1
          // The paragraph-format `<w:tabs><w:tab …/>` (a definition of tab stops) is not text. Only tabs inside a run are picked up.
        } else if (skip === 0 && local === 'tab' && inRun > 0) out.push('\t')
        else if (skip === 0 && (local === 'br' || local === 'cr')) out.push('\n')
      },
      close(local) {
        if (local === 'rt' || local === 'rPh') skip = Math.max(0, skip - 1)
        else if (local === 't') inText = Math.max(0, inText - 1)
        else if (local === 'r') inRun = Math.max(0, inRun - 1)
        else if (local === 'p' && skip === 0) out.newline()
      },
      text(text) {
        if (inText > 0 && skip === 0) out.push(text)
      }
    },
    reader,
    out
  )
}

interface Relationship {
  readonly type: string
  readonly target: string
  readonly external: boolean
}

async function relationships(reader: Reader, path: string): Promise<Map<string, Relationship>> {
  const map = new Map<string, Relationship>()
  const xml = await reader.part(path)
  if (xml === null) return map
  walkXml(
    xml,
    {
      open(local, attrs) {
        if (local !== 'Relationship') return
        const id = attr(attrs, 'Id')
        const target = attr(attrs, 'Target')
        if (id === null || target === null || map.has(id)) return
        map.set(id, { type: attr(attrs, 'Type') ?? '', target, external: attr(attrs, 'TargetMode') === 'External' })
      }
    },
    reader,
    null
  )
  return map
}

/** The path of the rels of part `base` (`word/document.xml` -> `word/_rels/document.xml.rels`). */
function relsPathOf(base: string): string {
  const slash = base.lastIndexOf('/')
  return `${base.slice(0, slash + 1)}_rels/${base.slice(slash + 1)}.rels`
}

/** Turns a target relative to `base` into a path inside the zip. */
export function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.' && segment !== '') parts.push(segment)
  }
  return parts.join('/')
}

/** The main part of the document (the officeDocument of `_rels/.rels`). The default location if absent. */
async function mainPart(reader: Reader, fallback: string): Promise<string> {
  for (const rel of (await relationships(reader, '_rels/.rels')).values()) {
    if (!rel.external && rel.type.endsWith('/officeDocument')) return resolvePart('', rel.target)
  }
  return fallback
}

function relsOfType(rels: Map<string, Relationship>, suffix: string): Relationship[] {
  return [...rels.values()].filter((rel) => !rel.external && rel.type.endsWith(suffix))
}

async function extractDocx(reader: Reader, out: TextOut): Promise<void> {
  const main = await mainPart(reader, 'word/document.xml')
  const xml = await reader.part(main)
  if (xml === null) throw new OoxmlError('no-main-part')
  proseOf(xml, reader, out)
  const rels = await relationships(reader, relsPathOf(main))
  // Footnotes, endnotes and comments go after the body (in a fixed order of kinds, not in the order of rels Ids).
  for (const suffix of ['/footnotes', '/endnotes', '/comments']) {
    for (const rel of relsOfType(rels, suffix)) {
      if (out.full) return
      const part = await reader.part(resolvePart(main, rel.target))
      if (part === null) continue
      out.separator()
      proseOf(part, reader, out)
    }
  }
}

async function extractPptx(reader: Reader, out: TextOut): Promise<void> {
  const main = await mainPart(reader, 'ppt/presentation.xml')
  const xml = await reader.part(main)
  if (xml === null) throw new OoxmlError('no-main-part')
  const rels = await relationships(reader, relsPathOf(main))
  // The order of slides is the order of `sldIdLst` in presentation.xml.
  const order: string[] = []
  walkXml(
    xml,
    {
      open(local, attrs) {
        if (local !== 'sldId') return
        const id = relId(attrs)
        const rel = id === null ? undefined : rels.get(id)
        if (rel !== undefined && !rel.external && rel.type.endsWith('/slide')) order.push(resolvePart(main, rel.target))
      }
    },
    reader,
    null
  )
  for (const slide of order) {
    if (out.full) return
    const part = await reader.part(slide)
    if (part === null) continue
    out.separator()
    proseOf(part, reader, out)
    // The presenter's notes go right after the slide.
    for (const rel of relsOfType(await relationships(reader, relsPathOf(slide)), '/notesSlide')) {
      if (out.full) return
      const notes = await reader.part(resolvePart(slide, rel.target))
      if (notes === null) continue
      out.newline()
      proseOf(notes, reader, out)
    }
  }
}

/** Shared strings (per `<si>`). A `<t>` inside a phonetic guide (`<rPh>`) is not counted. */
function sharedStringsOf(xml: string, reader: Reader): string[] {
  const strings: string[] = []
  let current: string[] | null = null
  let inText = 0
  let skip = 0
  walkXml(
    xml,
    {
      open(local, _attrs, empty) {
        if (empty) return
        if (local === 'si') current = []
        else if (local === 'rPh') skip += 1
        else if (local === 't') inText += 1
      },
      close(local) {
        if (local === 'si') {
          strings.push(current?.join('') ?? '')
          current = null
        } else if (local === 'rPh') skip = Math.max(0, skip - 1)
        else if (local === 't') inText = Math.max(0, inText - 1)
      },
      text(text) {
        if (current !== null && inText > 0 && skip === 0) current.push(text)
      }
    },
    reader,
    null
  )
  return strings
}

/**
 * One sheet: one line per row, with cells separated by tabs (empty cells are closed up). The value is the stored `<v>` (formulas are not computed,
 * and no formatting is applied: numbers are the raw value). Shared strings (`t="s"`) and inline ones (`inlineStr`) are resolved to text.
 */
function sheetOf(xml: string, shared: readonly string[], reader: Reader, out: TextOut): void {
  let cellType: string | null = null
  let inCell = false
  let inValue = false
  let inInline = 0
  let inText = 0
  let skip = 0
  let value: string[] = []
  let row: string[] = []
  walkXml(
    xml,
    {
      open(local, attrs, empty) {
        if (local === 'row') row = []
        else if (local === 'c') {
          inCell = !empty
          cellType = attr(attrs, 't')
          value = []
        } else if (empty) return
        else if (!inCell) return
        else if (local === 'v') inValue = true
        else if (local === 'is') inInline += 1
        else if (local === 'rPh') skip += 1
        else if (local === 't') inText += 1
      },
      close(local) {
        if (local === 'v') inValue = false
        else if (local === 'is') inInline = Math.max(0, inInline - 1)
        else if (local === 'rPh') skip = Math.max(0, skip - 1)
        else if (local === 't') inText = Math.max(0, inText - 1)
        else if (local === 'c') {
          if (inCell) {
            const raw = value.join('')
            let cell = raw
            if (cellType === 's') {
              const index = Number(raw)
              cell = Number.isInteger(index) ? (shared[index] ?? '') : ''
            }
            if (cell.trim() !== '') row.push(cell.replace(/[\t\r\n]+/g, ' '))
          }
          inCell = false
        } else if (local === 'row') {
          if (row.length > 0) {
            out.push(row.join('\t'))
            out.push('\n')
          }
          row = []
        }
      },
      text(text) {
        if (!inCell || skip > 0) return
        if (inValue || (inInline > 0 && inText > 0)) value.push(text)
      }
    },
    reader,
    out
  )
}

async function extractXlsx(reader: Reader, out: TextOut): Promise<void> {
  const main = await mainPart(reader, 'xl/workbook.xml')
  const xml = await reader.part(main)
  if (xml === null) throw new OoxmlError('no-main-part')
  const rels = await relationships(reader, relsPathOf(main))
  let shared: string[] = []
  for (const rel of relsOfType(rels, '/sharedStrings')) {
    const part = await reader.part(resolvePart(main, rel.target))
    if (part !== null) shared = sharedStringsOf(part, reader)
    break
  }
  // Sheets are in the order of workbook.xml. Hidden sheets are not shown, the same as in the viewer (aios.office).
  const sheets: { name: string; path: string }[] = []
  walkXml(
    xml,
    {
      open(local, attrs) {
        if (local !== 'sheet') return
        const state = attr(attrs, 'state')
        if (state === 'hidden' || state === 'veryHidden') return
        const id = relId(attrs)
        const rel = id === null ? undefined : rels.get(id)
        if (rel === undefined || rel.external || !rel.type.endsWith('/worksheet')) return
        sheets.push({ name: attr(attrs, 'name') ?? '', path: resolvePart(main, rel.target) })
      }
    },
    reader,
    null
  )
  for (const sheet of sheets) {
    if (out.full) return
    const part = await reader.part(sheet.path)
    if (part === null) continue
    out.separator()
    if (sheet.name !== '') {
      out.push(sheet.name)
      out.push('\n')
    }
    sheetOf(part, shared, reader, out)
  }
}

/**
 * Extracts the body from the bytes of an OOXML document. Deterministic (same bytes -> same string).
 * Throws `OoxmlError` if it cannot be extracted.
 */
export async function extractOoxml(buf: Buffer, kind: OoxmlKind, limits: OoxmlLimits): Promise<OoxmlText> {
  const entries = readCentralDirectory(buf, limits.maxEntries ?? MAX_ZIP_ENTRIES)
  const reader = new Reader(buf, entries, limits)
  const out = new TextOut(limits.limitBytes)
  if (kind === 'docx') await extractDocx(reader, out)
  else if (kind === 'pptx') await extractPptx(reader, out)
  else await extractXlsx(reader, out)
  return out.result()
}
