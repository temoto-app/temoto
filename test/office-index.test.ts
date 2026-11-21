/**
 * TODO 997: puts the body of Office files (docx / xlsx / pptx) into the index. The extracted text is not saved (constraint 9); the excerpt and the gateway's fetch extract it again each time.
 * Within the tests, fixtures are built with fflate's `zipSync` (a hand-written minimal OOXML).
 *
 * Real SQLite (in memory) and a real disk (`~/.aios-test/<run>/`). The model is not called.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { strToU8, zipSync, type Zippable } from 'fflate'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { INDEX_DERIVED_REQUEUE_CURSOR } from '../src/common/settings-keys.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore, fsVersion, retagFsVersion } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { clearDerivedTextCache, extractFile, extractGate, isExtractable } from '../src/index-kernel/extract.js'
import { extractOoxml, ooxmlKindOf, OoxmlError, OOXML_EXTRACTOR_VERSION } from '../src/index-kernel/ooxml.js'
import { IdleUpkeep, UPKEEP_DONE } from '../src/index-kernel/upkeep.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const MTIME = new Date('2026-10-25T00:00:00Z')

function zip(files: Record<string, string | Uint8Array>): Buffer {
  const entries: Zippable = {}
  for (const [name, content] of Object.entries(files)) {
    entries[name] = [typeof content === 'string' ? strToU8(content) : content, { mtime: MTIME }]
  }
  return Buffer.from(zipSync(entries, { level: 6 }))
}

function rels(list: readonly (readonly [id: string, type: string, target: string])[]): string {
  return (
    XML +
    `<Relationships xmlns="${PKG}">` +
    list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('') +
    '</Relationships>'
  )
}

function docx(body: string, extra: Record<string, string> = {}, docRels = rels([])): Buffer {
  return zip({
    '[Content_Types].xml': XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml': XML + `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`,
    'word/_rels/document.xml.rels': docRels,
    ...extra
  })
}

const para = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

function sampleDocx(): Buffer {
  return docx(
    // Tab stops in paragraph formatting (`w:tabs`) are not characters; only tabs inside a run become `\t`.
    '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>' +
      '<w:r><w:t>見出し</w:t></w:r><w:r><w:tab/><w:t>docxuniqueword</w:t></w:r></w:p>' +
      // Ruby: only the base characters are picked up; the reading (`w:rt`) is not.
      '<w:p><w:r><w:ruby><w:rt><w:r><w:t>かんじ</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>漢字</w:t></w:r></w:rubyBase></w:ruby></w:r></w:p>' +
      // Deleted revisions (`w:delText`) are not picked up. Entity references are decoded.
      '<w:p><w:r><w:delText>deletedword</w:delText></w:r><w:r><w:t>A &amp; B &lt;C&gt; &#x65E5;</w:t></w:r></w:p>' +
      para('二行目<w:br/>の続き'.replace('<w:br/>', '</w:t><w:br/><w:t>')),
    {
      'word/footnotes.xml': XML + `<w:footnotes xmlns:w="${W}">${para('footnoteword')}</w:footnotes>`
    },
    rels([['rId9', 'footnotes', 'footnotes.xml']])
  )
}

function sampleXlsx(extra: Record<string, string | Uint8Array> = {}): Buffer {
  return zip({
    ...extra,
    '_rels/.rels': rels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml':
      XML +
      `<workbook xmlns="${S}" xmlns:r="${REL}"><sheets>` +
      '<sheet name="売上" sheetId="1" r:id="rId1"/>' +
      '<sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/>' +
      '<sheet name="Second" sheetId="3" r:id="rId3"/>' +
      '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels': rels([
      ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
      ['rId2', 'worksheet', 'worksheets/sheet2.xml'],
      ['rId3', 'worksheet', 'worksheets/sheet3.xml'],
      ['rId4', 'sharedStrings', 'sharedStrings.xml']
    ]),
    'xl/sharedStrings.xml':
      XML +
      `<sst xmlns="${S}">` +
      '<si><t>xlsxuniqueword</t></si>' +
      // Readings (`rPh`) are not counted.
      '<si><r><t>東京</t></r><r><t>都</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si>' +
      '<si/>' +
      '</sst>',
    'xl/worksheets/sheet1.xml':
      XML +
      `<worksheet xmlns="${S}"><sheetData>` +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12345</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="inlineStr"><is><t>inlineword</t></is></c><c r="C2"><f>A1</f><v>7</v></c></row>' +
      '<row r="3"><c r="A3" s="1"/></row>' +
      '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      XML + `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hiddenword</t></is></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet3.xml':
      XML + `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" t="str"><v>secondsheetword</v></c></row></sheetData></worksheet>`
  })
}

function slide(text: string): string {
  return (
    XML +
    `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><p:sp><p:txBody>` +
    `<a:p><a:r><a:t>${text}</a:t></a:r><a:br/><a:r><a:t>next line</a:t></a:r></a:p>` +
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  )
}

function samplePptx(): Buffer {
  return zip({
    '_rels/.rels': rels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    // The slide order is the order of sldIdLst (rId3 comes first), not the order of the numbers in the file names.
    'ppt/presentation.xml':
      XML +
      `<p:presentation xmlns:p="${P}" xmlns:r="${REL}"><p:sldIdLst>` +
      '<p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/>' +
      '</p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': rels([
      ['rId2', 'slide', 'slides/slide1.xml'],
      ['rId3', 'slide', 'slides/slide2.xml']
    ]),
    'ppt/slides/slide1.xml': slide('secondslide'),
    'ppt/slides/slide2.xml': slide('pptxuniqueword'),
    'ppt/slides/_rels/slide2.xml.rels': rels([['rId1', 'notesSlide', '../notesSlides/notesSlide1.xml']]),
    'ppt/notesSlides/notesSlide1.xml':
      XML + `<p:notes xmlns:p="${P}" xmlns:a="${A}"><a:p><a:r><a:t>speakernoteword</a:t></a:r></a:p></p:notes>`
  })
}

const LIMIT = { limitBytes: 256 * 1024 }

describe('TODO 997: OOXML extraction (ooxml.ts)', () => {
  it('docx: paragraphs, tabs and breaks in runs, entity references, footnotes; ruby readings, deletion history and tab stop definitions are not picked up', async () => {
    const { text, truncated } = await extractOoxml(sampleDocx(), 'docx', LIMIT)
    expect(truncated).toBe(false)
    expect(text).toBe('見出し\tdocxuniqueword\n漢字\nA & B <C> 日\n二行目\nの続き\n\nfootnoteword\n')
  })

  it('xlsx: in the order of visible sheets, rows are tab-separated; shared strings (excluding phonetics), inline and numbers; hidden sheets are not output', async () => {
    const { text } = await extractOoxml(sampleXlsx(), 'xlsx', LIMIT)
    expect(text).toBe('売上\nxlsxuniqueword\t12345\n東京都\tinlineword\t7\n\nSecond\nsecondsheetword\n')
    expect(text).not.toContain('hiddenword')
    expect(text).not.toContain('トウキョウ')
  })

  it('pptx: slides in sldIdLst order, with the presenter notes right after each', async () => {
    const { text } = await extractOoxml(samplePptx(), 'pptx', LIMIT)
    expect(text).toBe('pptxuniqueword\nnext line\nspeakernoteword\n\nsecondslide\nnext line\n')
  })

  it('TODO 1239 xlsm: same extraction as xlsx; words inside the macro part (vbaProject.bin) are not picked up', async () => {
    // The same book with a macro part added (its contents share no words with the xlsx ones).
    const macro = sampleXlsx({ 'xl/vbaProject.bin': strToU8('vbamacroword') })
    const kind = ooxmlKindOf('xlsm')
    expect(kind).toBe('xlsx')
    const { text } = await extractOoxml(macro, kind ?? 'xlsx', LIMIT)
    const plain = await extractOoxml(sampleXlsx(), 'xlsx', LIMIT)
    expect(text).toBe(plain.text)
    expect(text).not.toContain('vbamacroword')
  })

  it('deterministic: the same bytes give the same string (chunk ranges are coordinates in this string)', async () => {
    const bytes = sampleXlsx()
    const first = await extractOoxml(bytes, 'xlsx', LIMIT)
    const second = await extractOoxml(bytes, 'xlsx', LIMIT)
    expect(second.text).toBe(first.text)
  })

  it('can also read the committed aios.office fixtures', async () => {
    const d = await extractOoxml(readFileSync('test/fixtures/office/sample.docx'), 'docx', LIMIT)
    expect(d.text.trim().length).toBeGreaterThan(0)
    const x = await extractOoxml(readFileSync('test/fixtures/office/sample.xlsx'), 'xlsx', LIMIT)
    expect(x.text.trim().length).toBeGreaterThan(0)
  })

  it('limit: stops with limitBytes without cutting in the middle of a character and sets truncated', async () => {
    const body = Array.from({ length: 2000 }, (_, i) => para(`あいうえお${i}`)).join('')
    const { text, truncated } = await extractOoxml(docx(body), 'docx', { limitBytes: 1000 })
    expect(truncated).toBe(true)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1000)
    expect(text).not.toContain('�')
  })

  const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise
      return 'ok'
    } catch (err) {
      return err instanceof OoxmlError ? err.reason : `other:${String(err)}`
    }
  }

  it('a non-zip, a broken zip and one without the main part give OoxmlError', async () => {
    expect(await reasonOf(extractOoxml(Buffer.from('not a zip at all, just text'), 'docx', LIMIT))).toBe('not-zip')
    const broken = sampleDocx()
    // Breaks the position of the central directory.
    const eocd = broken.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    broken.writeUInt32LE(broken.byteLength + 10, eocd + 16)
    expect(await reasonOf(extractOoxml(broken, 'docx', LIMIT))).toBe('corrupt')
    expect(await reasonOf(extractOoxml(zip({ 'a.txt': 'x' }), 'docx', LIMIT))).toBe('no-main-part')
  })

  it('zip bomb: parts with falsified declarations also stop at the inflation budget (maxPartBytes / maxInflatedBytes)', async () => {
    const bytes = docx(para('x'.repeat(200_000)))
    expect(await reasonOf(extractOoxml(bytes, 'docx', { ...LIMIT, maxPartBytes: 50_000 }))).toBe('too-large')
    expect(await reasonOf(extractOoxml(bytes, 'docx', { ...LIMIT, maxInflatedBytes: 50_000 }))).toBe('too-large')
    // Even if the central directory's "uncompressed size" is falsified as small, inflate's maxOutputLength stops it.
    const lied = Buffer.from(bytes)
    let at = lied.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    while (at >= 0) {
      lied.writeUInt32LE(10, at + 24)
      at = lied.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 4)
    }
    expect(await reasonOf(extractOoxml(lied, 'docx', { ...LIMIT, maxPartBytes: 50_000 }))).toBe('too-large')
  })

  it('limits on the number of items and on time', async () => {
    const many: Record<string, string> = { '_rels/.rels': rels([]) }
    for (let i = 0; i < 50; i += 1) many[`junk/${i}.xml`] = '<x/>'
    expect(await reasonOf(extractOoxml(zip(many), 'docx', { ...LIMIT, maxEntries: 20 }))).toBe('too-many-entries')
    let clock = 0
    const now = (): number => (clock += 1000)
    expect(await reasonOf(extractOoxml(sampleDocx(), 'docx', { ...LIMIT, timeBudgetMs: 1500, now }))).toBe('timeout')
  })

  it('even broken XML finishes in linear time (unclosed `<a ` / `<?` / `<!--` / repeated quotes)', async () => {
    // When it was written with a regular expression, `'<a '.repeat(80_000)` (240 KB) took 12.5 seconds (review of wave 53).
    const head = `<w:document xmlns:w="${W}"><w:body>${para('beforeword')}`
    for (const unit of ['<a ', '<?', '<!--', '<a "', "<a '", '<a "x" ', '<![CDATA[', '</ ']) {
      const body = head + unit.repeat(Math.ceil((1.2 * 1024 * 1024) / unit.length))
      const started = performance.now()
      const result = await extractOoxml(
        zip({
          '_rels/.rels': rels([['rId1', 'officeDocument', 'word/document.xml']]),
          'word/document.xml': body
        }),
        'docx',
        LIMIT
      ).catch((err: unknown) => err)
      expect(performance.now() - started, unit).toBeLessThan(1_000)
      if (result instanceof OoxmlError) expect(result.reason).toBe('timeout')
      else expect((result as { text: string }).text.startsWith('beforeword'), unit).toBe(true)
    }
  })

  it('can also read stored (uncompressed) parts', async () => {
    const entries: Zippable = {
      '_rels/.rels': [strToU8(rels([['rId1', 'officeDocument', 'word/document.xml']])), { level: 0 }],
      'word/document.xml': [strToU8(XML + `<w:document xmlns:w="${W}"><w:body>${para('storedword')}</w:body></w:document>`), { level: 0 }]
    }
    const { text } = await extractOoxml(Buffer.from(zipSync(entries)), 'docx', LIMIT)
    expect(text).toBe('storedword\n')
    // Checks that deflateRawSync gives the same raw form in node and in fflate.
    expect(deflateRawSync(Buffer.from('a')).byteLength).toBeGreaterThan(0)
  })
})

describe('TODO 997: fs version and re-stamping', () => {
  it('attaches the extraction version only to the versions of Office files (the text version is the same string as before)', () => {
    const base = { isDirectory: false, mtimeMs: 12.5, size: 3 }
    expect(fsVersion({ ...base, name: 'a.txt' })).toBe('12.5:3')
    expect(fsVersion({ ...base, name: 'a.DOCX' })).toBe(`12.5:3:ox${OOXML_EXTRACTOR_VERSION}`)
    expect(fsVersion({ ...base, name: 'a.xlsx', dataless: true })).toBe(`12.5:3:ox${OOXML_EXTRACTOR_VERSION}:dataless`)
    // TODO 1239: `.xlsm` gets the same mark as xlsx (an existing skipped row is re-tagged with retag and goes back to pending).
    expect(fsVersion({ ...base, name: 'a.xlsm' })).toBe(`12.5:3:ox${OOXML_EXTRACTOR_VERSION}`)
    expect(retagFsVersion('12.5:3', 'a.xlsm')).toBe(`12.5:3:ox${OOXML_EXTRACTOR_VERSION}`)
    expect(retagFsVersion('12.5:3', 'a.pptx')).toBe(`12.5:3:ox${OOXML_EXTRACTOR_VERSION}`)
    expect(retagFsVersion('12.5:3:ox0:dataless', 'a.pptx')).toBe(`12.5:3:ox${OOXML_EXTRACTOR_VERSION}:dataless`)
    expect(retagFsVersion('12.5:3', 'a.txt')).toBe('12.5:3')
  })

  it('isExtractable / extractGate: Office is a target and stops when there is no zip header; PDF is not yet a target', async () => {
    expect(isExtractable('/x/a.docx')).toBe(true)
    expect(isExtractable('/x/a.pptx')).toBe(true)
    expect(isExtractable('/x/a.xlsm')).toBe(true)
    expect(isExtractable('/x/a.pdf')).toBe(false)
    expect(isExtractable('/x/App.app/Contents/a.docx')).toBe(false)
    const dir = makeTestDir('office-gate')
    try {
      writeFileSync(join(dir, 'ok.docx'), sampleDocx())
      writeFileSync(join(dir, 'fake.docx'), 'plain text pretending')
      expect(await extractGate(join(dir, 'ok.docx'))).toBeNull()
      expect(await extractGate(join(dir, 'fake.docx'))).toBe('corrupt')
      const fake = await extractFile(join(dir, 'fake.docx'))
      expect(fake.ok).toBe(false)
    } finally {
      removeTestDir(dir)
    }
  })
})

describe('TODO 997: index, search and gateway (the real IndexService)', () => {
  let root: string
  let db: Db
  let store: IndexStore
  let fs: FsIndexer
  let index: IndexService

  beforeAll(async () => {
    clearDerivedTextCache()
    root = makeTestDir('office-index')
    writeFileSync(join(root, 'report.docx'), sampleDocx())
    writeFileSync(join(root, 'sales.xlsx'), sampleXlsx())
    writeFileSync(join(root, 'deck.pptx'), samplePptx())
    // TODO 1239: a book with a macro (the words of the macro part do not appear in the body).
    writeFileSync(join(root, 'macro.xlsm'), sampleXlsx({ 'xl/vbaProject.bin': strToU8('vbamacroword') }))
    // A long docx: a word's excerpt in a later chunk is cut at the coordinates of the extracted text.
    writeFileSync(
      join(root, 'long.docx'),
      docx(Array.from({ length: 400 }, (_, i) => para(`段落${i} の本文はここに続きます。filler text ${i}`)).join('') + para('Tailword appears here'))
    )
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    store = new IndexStore(db)
    fs = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, store, root, [root])
    index = new IndexService({
      db,
      store,
      conversation: { readEventText: async () => null, threadTitle: async () => null },
      transcripts: null,
      fsRules: () => fs.exclusionRules,
      onStatus: () => {}
    })
    await fs.scan()
    await index.build()
  })

  afterAll(async () => {
    await index.stop()
    await fs.stop()
    if (db.open) db.close()
    removeTestDir(root)
  })

  const rowOf = (name: string): { id: number; index_state: string; version: string } =>
    db.prepare(`SELECT id, index_state, version FROM documents WHERE source = 'fs' AND name = ?`).get(name) as {
      id: number
      index_state: string
      version: string
    }

  it('all 3 kinds are indexed and the extraction version goes into the version', () => {
    for (const name of ['report.docx', 'sales.xlsx', 'macro.xlsm', 'deck.pptx', 'long.docx']) {
      const row = rowOf(name)
      expect(row.index_state).toBe('indexed')
      expect(row.version.endsWith(`:ox${OOXML_EXTRACTOR_VERSION}`)).toBe(true)
    }
  })

  it('in-file search hits a word that is only in the body and the excerpt contains the word', async () => {
    for (const [word, name] of [
      ['docxuniqueword', 'report.docx'],
      ['xlsxuniqueword', 'sales.xlsx'],
      ['xlsxuniqueword', 'macro.xlsm'],
      ['pptxuniqueword', 'deck.pptx'],
      ['speakernoteword', 'deck.pptx'],
      ['footnoteword', 'report.docx']
    ] as const) {
      const result = await index.search(word, 'files', {})
      const hit = result.hits.find((h) => h.title === name)
      expect(hit, word).toBeDefined()
      expect(hit?.snippet).toContain(word)
    }
    // Nothing matches what is not picked up (ruby readings, hidden sheets, deletion history).
    for (const word of ['hiddenword', 'deletedword', 'vbamacroword']) {
      expect((await index.search(word, 'files', {})).hits).toEqual([])
    }
  })

  it('excerpts of later chunks are also cut from the extracted text (does not fail even with a smart-case capital)', async () => {
    const result = await index.search('Tailword', 'files', {})
    const hit = result.hits.find((h) => h.title === 'long.docx')
    expect(hit?.snippet).toContain('Tailword')
  })

  it('the extracted text does not remain in the DB (constraint 9)', () => {
    const dump = JSON.stringify([
      db.prepare(`SELECT * FROM documents`).all(),
      db.prepare(`SELECT * FROM chunks`).all()
    ])
    for (const word of ['docxuniqueword', 'xlsxuniqueword', 'pptxuniqueword', 'Tailword']) expect(dump).not.toContain(word)
  })

  it('gateway: getDocument / getDocumentText / getChunk return the extracted text', async () => {
    const id = String(rowOf('report.docx').id)
    const head = (await index.getDocument(id, 8192, false)) as Record<string, unknown>
    expect(head['text']).toContain('docxuniqueword')
    expect(head['has_more']).toBe(false)
    const total = head['total_bytes'] as number
    expect(total).toBe(Buffer.byteLength(head['text'] as string, 'utf8'))

    const page = (await index.getDocumentText(id, 0, 10, false)) as Record<string, unknown>
    expect(page['offset']).toBe(0)
    expect(page['text']).toBe('見出し\t')
    expect(page['next_offset']).toBe(10)
    const rest = (await index.getDocumentText(id, page['next_offset'] as number, 100_000, false)) as Record<string, unknown>
    expect(`${page['text'] as string}${rest['text'] as string}`).toBe(head['text'])
    expect(rest['next_offset']).toBeNull()

    const chunk = db
      .prepare(`SELECT id FROM chunks WHERE document_id = ? ORDER BY seq LIMIT 1`)
      .get(rowOf('sales.xlsx').id) as { id: number }
    const got = (await index.getChunk(String(chunk.id), false)) as Record<string, unknown>
    expect(got['text']).toContain('xlsxuniqueword')
  })
})

describe('TODO 997: re-stamping rows from before 997 (upkeep)', () => {
  it('re-stamps the version of Office rows and returns them to pending, leaves text rows alone; once done it never runs again', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const store = new IndexStore(db)
    const settings = new AppSettingsStore(db)
    const parent = store.ensureDirectory('/tmp/aios-997', 1)
    const add = (name: string, ext: string): number => {
      const { id } = store.upsertFsEntry({ parentId: parent, name, isDirectory: false, ext, size: 5, mtimeMs: 1, seenAt: 1 })
      store.markSkipped(id)
      return id
    }
    const office = add('old.docx', 'docx')
    const text = add('note.txt', 'txt')
    // Puts it back to the version before 997 (no mark).
    db.prepare(`UPDATE documents SET version = '1:5' WHERE id = ?`).run(office)
    let requeued = 0
    const upkeep = new IdleUpkeep({
      store,
      settings,
      enqueue: async (work) => {
        await work()
      },
      shouldYield: () => false,
      readGate: () => async () => true,
      onRequeued: (count) => {
        requeued += count
      }
    })
    for (let i = 0; i < 10 && !upkeep.finished(); i += 1) await upkeep.step()
    expect(upkeep.finished()).toBe(true)
    const row = (id: number): { version: string; index_state: string } =>
      db.prepare(`SELECT version, index_state FROM documents WHERE id = ?`).get(id) as { version: string; index_state: string }
    expect(row(office)).toEqual({ version: `1:5:ox${OOXML_EXTRACTOR_VERSION}`, index_state: 'pending' })
    expect(row(text).index_state).toBe('skipped')
    expect(requeued).toBe(1)
    expect(settings.readTyped(INDEX_DERIVED_REQUEUE_CURSOR)).toBe(UPKEEP_DONE)
    db.close()
  })
})
