/**
 * TODO 998 stage 2: OCR of images, separating labels from text, the order of confidence, extreme aspect ratios, and telling receipts from documents.
 * Vision is not called: the analyzer is fake (the contents are "label | text"), and the helper boundary is a fake child process that speaks the same protocol. User images are not read.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import { clearDerivedTextCache, extractFile } from '../src/index-kernel/extract.js'
import {
  configureVisionHelper,
  imageAnalyzer,
  imageIndexVersion,
  IMAGE_OCR_MAX_CHARS,
  sanitizeOcrText,
  setImageAnalyzer,
  storedImageLabelsOf
} from '../src/index-kernel/image.js'
import { chunkImageText } from '../src/index-kernel/chunk.js'
import { imageBoostText, imageTerms, imageWeightedTerms, labelWeight, APPLE_VISION_BACKEND } from '../src/common/image-labels/terms.js'
import { StdioHelper } from '../src/index-kernel/helper-process.js'
import { imageDocKind } from '../src/common/image-labels/receipt.js'
import type { ImageAnalyzer, ImageLabel } from '../src/common/os/image-analysis.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

/** Fake image: the contents are `label:confidence,… | text`. `STRIP` is a band, `LINE` is a line, and `OCRFAIL` fails only the OCR. */
const calls: { ocr: boolean; classify: boolean; body: string }[] = []
/** Plants an OCR failure: only `timeouts` times, or if `always` is set, it always times out (no response). */
const control = { timeouts: 0, always: false, classifyTimeouts: 0, classifyAlways: false }
const fake: ImageAnalyzer = {
  backend: APPLE_VISION_BACKEND,
  version: 1,
  ocrVersion: 1,
  async analyze(data, options) {
    const body = Buffer.from(data).toString('utf8')
    calls.push({ ocr: options.ocr === true, classify: options.classify !== false, body })
    if (body.startsWith('LINE')) return { ok: false, reason: 'shape' }
    if (options.ocr !== true && (control.classifyAlways || control.classifyTimeouts > 0)) {
      control.classifyTimeouts = Math.max(0, control.classifyTimeouts - 1)
      return { ok: false, reason: 'timeout' }
    }
    if (options.ocr === true && (control.always || control.timeouts > 0)) {
      control.timeouts = Math.max(0, control.timeouts - 1)
      return { ok: false, reason: 'timeout' }
    }
    const [labelPart = '', textPart = ''] = body.split('|')
    const ocrWanted = options.ocr === true
    if (ocrWanted && body.includes('OCRFAIL')) return { ok: true, width: 800, height: 600, labels: [], ocrFailed: true }
    const labels: ImageLabel[] =
      options.classify === false
        ? []
        : labelPart
            .split(',')
            .filter((part) => part.includes(':'))
            .map((part) => {
              const [id, conf] = part.split(':')
              return [id as string, Number(conf)] as const
            })
            .filter((label) => label[1] >= options.minConfidence)
    const strip = body.startsWith('STRIP') && options.classify !== false
    return {
      ok: true,
      width: strip ? 4000 : 800,
      height: strip ? 200 : 600,
      labels: strip ? [] : labels,
      ...(strip ? { strip: true } : {}),
      ...(ocrWanted ? { text: sanitizeOcrText(textPart.replaceAll('\\n', '\n')) } : {})
    }
  },
  dispose() {}
}

afterEach(() => {
  setImageAnalyzer(null)
  control.timeouts = 0
  control.always = false
  control.classifyTimeouts = 0
  control.classifyAlways = false
})

describe('TODO 998 stage 2: confidence ordering and shape terms and kind terms (pure functions)', () => {
  it('the higher the confidence of a label, the heavier its term; a broad term inherits the weight of the label it was derived from and becomes a repeat of the shadow', () => {
    expect(labelWeight(0.9)).toBe(3)
    expect(labelWeight(0.4)).toBe(2)
    expect(labelWeight(0.16)).toBe(1)
    const labels: ImageLabel[] = [['dog', 0.9], ['cat', 0.2]]
    const weighted = new Map(imageWeightedTerms(labels, APPLE_VISION_BACKEND))
    expect(weighted.get('犬')).toBe(3)
    expect(weighted.get('猫')).toBe(1)
    const boost = imageBoostText(labels, APPLE_VISION_BACKEND).split(' ')
    expect(boost.filter((t) => t === '犬')).toHaveLength(2)
    expect(boost).not.toContain('猫')
    // No repetition in the word row (the canonical sentence).
    const line = imageTerms(labels, APPLE_VISION_BACKEND)
    expect(new Set(line).size).toBe(line.length)
  })

  it('an image with an extreme aspect ratio gets only a shape term; if OCR shows it is a document, the receipt term is dropped, and if it is a receipt it is added', () => {
    expect(imageTerms([], APPLE_VISION_BACKEND, 0.15, { shape: 'wide' })).toEqual(['横長', 'バナー'])
    expect(imageTerms([], APPLE_VISION_BACKEND, 0.15, { shape: 'tall' })).toEqual(['縦長'])
    const labels: ImageLabel[] = [['receipt', 0.5]]
    expect(imageTerms(labels, APPLE_VISION_BACKEND)).toContain('レシート')
    const asDocument = imageTerms(labels, APPLE_VISION_BACKEND, 0.15, { kind: 'document' })
    expect(asDocument).not.toContain('レシート')
    expect(asDocument).not.toContain('領収書')
    expect(asDocument).toContain('書類')
    expect(imageTerms([], APPLE_VISION_BACKEND, 0.15, { kind: 'receipt' })).toContain('レシート')
  })

  it('receipt and document: two or more OCR clues make a receipt; many characters but not enough clues make a document; few characters are left undecided', () => {
    expect(imageDocKind('合計 1,280円\n税込\nお預り 2,000')).toBe('receipt')
    expect(imageDocKind('TOTAL 12.50\nTAX 1.00')).toBe('receipt')
    expect(imageDocKind('レシート\n¥100\n¥200\n¥300')).toBe('receipt')
    expect(imageDocKind('議事録 '.repeat(60))).toBe('document')
    expect(imageDocKind('合計')).toBeNull()
    expect(imageDocKind('')).toBeNull()
  })

  it('the term row is a single seq 0 chunk; the OCR characters come after it and shift the byte positions', () => {
    const chunks = chunkImageText('犬 動物\nこんにちは\n世界')
    expect(chunks[0]).toMatchObject({ seq: 0, text: '犬 動物', byteStart: 0 })
    expect(chunks[0]!.byteEnd).toBe(Buffer.byteLength('犬 動物'))
    expect(chunks[1]).toMatchObject({ seq: 1, byteStart: Buffer.byteLength('犬 動物') + 1 })
    expect(chunkImageText('犬 動物')).toHaveLength(1)
  })

  it('OCR characters are validated: control characters, length, type', () => {
    expect(sanitizeOcrText('a\u0000b\r\n\n\n\nc‮d ')).toBe('a b\n\nc d')
    expect(sanitizeOcrText('x'.repeat(IMAGE_OCR_MAX_CHARS + 50)).length).toBe(IMAGE_OCR_MAX_CHARS)
    expect(sanitizeOcrText(42)).toBe('')
    const stored = storedImageLabelsOf({
      image: { v: 1, backend: 'b', at: '1:2', labels: [], ocr: { v: 1, state: 'done', kind: 'receipt' }, shape: 'wide' }
    })
    expect(stored?.ocr).toEqual({ v: 1, state: 'done', kind: 'receipt' })
    expect(stored?.shape).toBe('wide')
    expect(storedImageLabelsOf({ image: { v: 1, backend: 'b', at: '1:2', labels: [], ocr: { v: 1, state: 'x' } } })?.ocr).toBeUndefined()
  })
})

describe('TODO 998 stage 2: OCR in extractFile', () => {
  it('normal ingestion does not run OCR; when the OCR stage is enabled the characters follow the sentence and a marker (kind) is set; images marked done are extracted again', async () => {
    const dir = makeTestDir('image-ocr-extract')
    try {
      setImageAnalyzer(fake)
      clearDerivedTextCache()
      const path = join(dir, 'a.png')
      writeFileSync(path, 'receipt:0.5|合計 1,280円\\n税込\\nお預り 2,000')
      const first = await extractFile(path)
      expect(first.ok && first.text.includes('\n')).toBe(false)
      expect(calls.at(-1)).toMatchObject({ ocr: false, classify: true })
      const stored = first.ok ? first.image! : null
      expect(stored?.ocr).toBeUndefined()
      // OCR stage: classification is not run again (classify:false), and the text is read.
      const ocr = await extractFile(path, { image: stored, ocr: 'run' })
      expect(calls.at(-1)).toMatchObject({ ocr: true, classify: false })
      expect(ocr.ok && ocr.text.split('\n')).toHaveLength(4)
      expect(ocr.ok && ocr.image?.ocr).toEqual({ v: 1, state: 'done', kind: 'receipt' })
      // If there is a mark, the text is taken out again and made into the same sentence even when not in the OCR stage (excerpt, re-index).
      clearDerivedTextCache()
      const again = await extractFile(path, { image: ocr.ok ? ocr.image : null, ocr: 'reread' })
      expect(again.ok && again.text).toBe(ocr.ok && ocr.text)
      expect(calls.at(-1)).toMatchObject({ ocr: true, classify: false })
      // Building (ocr omitted) does not call OCR; it removes the done mark, so that only the word row remains (the OCR stage takes it again).
      const callsBefore = calls.length
      clearDerivedTextCache()
      const build = await extractFile(path, { image: ocr.ok ? ocr.image : null })
      expect(calls.length).toBe(callsBefore)
      expect(build.ok && build.text.includes('\n')).toBe(false)
      expect(build.ok && build.image?.ocr).toBeUndefined()
      // Discard the mark of an old OCR version and keep only the word row (taking it again is the job of the OCR stage).
      clearDerivedTextCache()
      const old = await extractFile(path, { image: { ...ocr.ok ? ocr.image! : stored!, ocr: { v: 0, state: 'done' } } })
      expect(old.ok && old.text.includes('\n')).toBe(false)
      expect(old.ok && old.image?.ocr).toBeUndefined()
    } finally {
      removeTestDir(dir)
    }
  })

  it('no characters or an OCR failure sets only the marker (the sentence stays as the term row); a line with an extreme aspect ratio is out of scope, and a band gets a shape term', async () => {
    const dir = makeTestDir('image-ocr-edge')
    try {
      setImageAnalyzer(fake)
      clearDerivedTextCache()
      writeFileSync(join(dir, 'none.png'), 'dog:0.9|')
      writeFileSync(join(dir, 'fail.png'), 'dog:0.9|OCRFAIL')
      writeFileSync(join(dir, 'line.png'), 'LINE')
      writeFileSync(join(dir, 'strip.png'), 'STRIP|新製品 発売')
      const none = await extractFile(join(dir, 'none.png'))
      const noneOcr = await extractFile(join(dir, 'none.png'), { image: none.ok ? none.image : null, ocr: 'run' })
      expect(noneOcr.ok && noneOcr.image?.ocr).toEqual({ v: 1, state: 'none' })
      expect(noneOcr.ok && noneOcr.text.includes('\n')).toBe(false)
      const fail = await extractFile(join(dir, 'fail.png'))
      const failOcr = await extractFile(join(dir, 'fail.png'), { image: fail.ok ? fail.image : null, ocr: 'run' })
      // For an unreadable image, only the OCR stage sets the mark `failed` (extractFile returns only the reason in the result and makes no mark).
      expect(failOcr).toEqual({ ok: false, reason: 'ocr-failed' })
      expect(await extractFile(join(dir, 'line.png'))).toEqual({ ok: false, reason: 'empty' })
      const strip = await extractFile(join(dir, 'strip.png'))
      expect(strip.ok && strip.text).toBe('横長 バナー')
      expect(strip.ok && strip.image?.shape).toBe('wide')
      const stripOcr = await extractFile(join(dir, 'strip.png'), { image: strip.ok ? strip.image : null, ocr: 'run' })
      expect(stripOcr.ok && stripOcr.text).toBe('横長 バナー\n新製品 発売')
    } finally {
      removeTestDir(dir)
    }
  })

  it('the OCR version goes into the version marker; an analyzer that cannot OCR (no ocrVersion) does not go to the OCR stage', () => {
    setImageAnalyzer(fake)
    const withOcr = imageIndexVersion()
    setImageAnalyzer({ ...fake, ocrVersion: undefined })
    expect(imageIndexVersion()).toBe(withOcr - 10_000)
  })
})

describe('TODO 998 stage 2: indexing and search (real IndexService, OCR later and newest first)', () => {
  let root: string
  let db: Db
  let store: IndexStore
  let fs: FsIndexer
  let index: IndexService
  beforeEach(() => setImageAnalyzer(fake))
  const step = (): Promise<void> => (index as unknown as { ocrStep(p: string): Promise<void> }).ocrStep('slow')

  beforeAll(async () => {
    setImageAnalyzer(fake)
    clearDerivedTextCache()
    calls.length = 0
    root = makeTestDir('image-ocr-index')
    const files: [string, string, number][] = [
      ['old.png', 'cat:0.2|古い猫の絵のメモ', 1_600_000_000],
      ['mid.png', 'dog:0.9|', 1_650_000_000],
      ['new.png', 'cat:0.2|会議の議事録 犬の話', 1_700_000_000],
      ['receipt.png', 'receipt:0.5|合計 1,280円\\n税込\\nお預り 2,000\\nお釣り 720', 1_690_000_000],
      ['a4.png', 'receipt:0.5|' + '会議の議事録です。次回の予定について説明します。'.repeat(8), 1_680_000_000],
      ['strip.png', 'STRIP|横断幕の文字', 1_670_000_000]
    ]
    for (const [name, body, mtime] of files) {
      writeFileSync(join(root, name), body)
      utimesSync(join(root, name), mtime, mtime)
    }
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
    setImageAnalyzer(null)
  })

  const titles = async (q: string): Promise<string[]> => (await index.search(q, 'files', {})).hits.map((h) => h.title)

  it('classifies all images first (OCR is not called); classified images enter a queue in newest-first order', () => {
    expect(calls.some((c) => c.ocr)).toBe(false)
    expect(store.ocrQueueSize()).toBe(6)
    expect(store.ocrCandidates(1).rows[0]?.id).toBe(
      (db.prepare(`SELECT id FROM documents WHERE name = 'new.png'`).get() as { id: number }).id
    )
  })

  it('OCR runs one image per step, newest first; the characters are not saved (metadata is only the marker), and can be looked up by terms', async () => {
    calls.length = 0
    clearDerivedTextCache()
    await step()
    expect(calls.map((c) => c.body.split('|')[1]?.slice(0, 4))).toEqual(['会議の議'])
    for (let i = 0; i < 5; i += 1) await step()
    // Newest first: new → receipt → a4 → strip → mid → old.
    expect(calls.filter((c) => c.ocr)).toHaveLength(6)
    expect(store.ocrQueueSize()).toBe(0)
    const dump = JSON.stringify(db.prepare(`SELECT metadata FROM documents`).all())
    expect(dump).not.toContain('議事録')
    expect(dump).toContain('ocr')
    // Can be looked up by text (a word that is not in the labels).
    expect(await titles('横断幕')).toEqual(['strip.png'])
    expect(await titles('議事録')).toContain('new.png')
    // The excerpt is cut from the text taken out again.
    const hit = (await index.search('横断幕', 'files', {})).hits[0]
    expect(hit?.snippet).toContain('横断幕')
  })

  it('a label match ranks above a character match (a dog label > 「犬」 in the characters); images with higher confidence come first', async () => {
    expect((await titles('犬'))[0]).toBe('mid.png')
    expect(await titles('犬')).toContain('new.png')
  })

  it('a receipt is a receipt and an A4 document is a document (the label is the same receipt)', async () => {
    expect(await titles('レシート')).toEqual(['receipt.png'])
    expect(await titles('書類')).toContain('a4.png')
    expect(await titles('横長')).toEqual(['strip.png'])
  })

  it('redoing OCR on the same file keeps the queue empty and does not rerun classification', async () => {
    calls.length = 0
    await step()
    expect(calls).toEqual([])
  })
})

describe('TODO 998 stage 2: helper entry point (fake child process)', () => {
  const script = `#!${process.execPath}
let buf = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const nl = buf.indexOf(10)
    if (nl < 0) return
    const req = JSON.parse(buf.subarray(0, nl).toString('utf8'))
    if (buf.length < nl + 1 + req.size) return
    const body = buf.subarray(nl + 1, nl + 1 + req.size).toString('utf8')
    buf = buf.subarray(nl + 1 + req.size)
    const base = { id: req.id, ok: true, w: 640, h: 480, cpuUs: 7000, labels: [] }
    if (body === 'shape') console.log(JSON.stringify({ id: req.id, ok: false, error: 'shape', cpuUs: 5 }))
    else if (body === 'strip') console.log(JSON.stringify({ ...base, w: 4000, h: 100, strip: true, text: 'x' }))
    else if (body === 'ocrfail') console.log(JSON.stringify({ ...base, ocrFailed: true }))
    else if (body === 'dirty') console.log(JSON.stringify({ ...base, text: 'a\\u0000b\\n\\n\\n' + 'x'.repeat(50000) }))
    else console.log(JSON.stringify({ ...base, req: [req.classify, req.ocr, req.ocrSide, req.ocrMaxChars, req.stripAspect, req.maxAspect], text: req.ocr ? '文字' : undefined }))
  }
})
`
  const bytes = (text: string): Buffer => Buffer.from(text, 'utf8')
  const options = { minConfidence: 0.1, minSide: 128, maxSide: 16_384, maxPixels: 100_000_000, decodeSide: 2048 }
  it.skipIf(process.platform !== 'darwin')('how OCR is requested, bands, lines, failures and the output limit', async () => {
    const dir = makeTestDir('vision-ocr-helper')
    try {
      const helper = join(dir, 'fake-helper')
      writeFileSync(helper, script)
      chmodSync(helper, 0o755)
      expect(configureVisionHelper(helper)).toBe(true)
      const x = imageAnalyzer()!
      expect(x.ocrVersion).toBe(1)
      // Fix Y-4: since the handling of the aspect ratio was changed, the output version is 2.
      expect(x.version).toBe(2)
      const ok = await x.analyze(bytes('ok'), { ...options, classify: false, ocr: true })
      expect(ok).toMatchObject({ ok: true, text: '文字' })
      expect(await x.analyze(bytes('ok'), options)).not.toHaveProperty('text')
      expect(await x.analyze(bytes('shape'), options)).toEqual({ ok: false, reason: 'shape' })
      expect(await x.analyze(bytes('strip'), { ...options, ocr: true })).toMatchObject({ ok: true, strip: true, text: 'x' })
      expect(await x.analyze(bytes('ocrfail'), { ...options, ocr: true })).toMatchObject({ ok: true, ocrFailed: true })
      const dirty = await x.analyze(bytes('dirty'), { ...options, ocr: true })
      expect(dirty.ok && dirty.text!.length).toBeLessThanOrEqual(IMAGE_OCR_MAX_CHARS)
      expect(dirty.ok && dirty.text!.startsWith('a b')).toBe(true)
    } finally {
      setImageAnalyzer(null)
      removeTestDir(dir)
    }
  })
})

// ---- wave 85 fix Y (code-review) ----

describe('fix Y-5: the same term takes the larger weight', () => {
  it('a term that entered first from a label is also overwritten by the weight 3 of a kind term (receipt, document) confirmed by OCR', () => {
    const labels: ImageLabel[] = [['receipt', 0.2]]
    const without = new Map(imageWeightedTerms(labels, APPLE_VISION_BACKEND))
    expect(without.get('レシート')).toBe(1)
    const withKind = new Map(imageWeightedTerms(labels, APPLE_VISION_BACKEND, { kind: 'receipt' }))
    expect(withKind.get('レシート')).toBe(3)
    // The position stays as the first (the order of the word rows does not change).
    expect(imageTerms(labels, APPLE_VISION_BACKEND, 0.15, { kind: 'receipt' })).toEqual(imageTerms(labels, APPLE_VISION_BACKEND))
    expect(
      imageBoostText(labels, APPLE_VISION_BACKEND, { kind: 'receipt' })
        .split(' ')
        .filter((t) => t === 'レシート')
    ).toHaveLength(2)
    // The same for documents (3, even if the word came in earlier from the labels).
    const doc = new Map(imageWeightedTerms([['receipt', 0.2]], APPLE_VISION_BACKEND, { kind: 'document' }))
    expect(doc.get('書類')).toBe(3)
  })
})

describe("fix Y-7: the helper's first OCR has a long warm-up limit", () => {
  const script = `#!${process.execPath}
let buf = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const nl = buf.indexOf(10)
    if (nl < 0) return
    const req = JSON.parse(buf.subarray(0, nl).toString('utf8'))
    if (buf.length < nl + 1 + req.size) return
    buf = buf.subarray(nl + 1 + req.size)
    setTimeout(() => console.log(JSON.stringify({ id: req.id, ok: true })), 400)
  }
})
`
  it.skipIf(process.platform !== 'darwin')('only the first per child has the long limit; after warming up the usual limit applies, and exceeding it gives null (= timeout)', async () => {
    const dir = makeTestDir('stdio-warmup')
    try {
      const path = join(dir, 'slow-helper')
      writeFileSync(path, script)
      chmodSync(path, 0o755)
      const helper = new StdioHelper(path, { name: 'image', timeoutMs: 150, idleMs: 60_000 })
      const data = Buffer.from('x')
      const warm = { warmKey: 'ocr', warmTimeoutMs: 3_000 }
      // Without warm-up, a response of 400 ms cannot make the 150 ms limit (the child is killed).
      expect(await helper.request({}, data)).toBeNull()
      // The warm-up request returns within the long limit.
      expect(await helper.request({}, data, warm)).toMatchObject({ ok: true })
      // After warming up, even for the same kind, the usual limit (150 ms) applies: a 400 ms response is too late, so it is null.
      expect(await helper.request({}, data, warm)).toBeNull()
      // Since the child was killed on timeout, the next request is, as the first request of a cold child, back to the warm-up limit.
      expect(await helper.request({}, data, warm)).toMatchObject({ ok: true })
      helper.dispose()
    } finally {
      removeTestDir(dir)
    }
  })
})

describe('fix Y: indexing and search (transient OCR failures, limits, build, images with an empty term row)', () => {
  let root: string
  let db: Db
  let store: IndexStore
  let fs: FsIndexer
  let index: IndexService
  const docId = (name: string): number => (db.prepare(`SELECT id FROM documents WHERE name = ?`).get(name) as { id: number }).id
  const state = (name: string): string =>
    (db.prepare(`SELECT index_state FROM documents WHERE name = ?`).get(name) as { index_state: string }).index_state
  const ocrMark = (name: string): unknown => {
    const row = db.prepare(`SELECT metadata FROM documents WHERE name = ?`).get(name) as { metadata: string | null }
    return (JSON.parse(row.metadata ?? '{}') as { image?: { ocr?: unknown } }).image?.ocr
  }
  interface Internals {
    ocrStep(p: string): Promise<void>
    ocrDeferred: Map<number, { fails: number; until: number }>
  }
  const internals = (): Internals => index as unknown as Internals
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 40 && store.ocrQueueSize() > 0; i += 1) await internals().ocrStep('slow')
  }
  const requeue = (id: number): void => {
    store.atomically(() => {
      db.prepare(`UPDATE documents SET metadata = json_remove(metadata, '$.image.ocr') WHERE id = ?`).run(id)
      db.prepare(
        `INSERT OR REPLACE INTO image_ocr_queue (document_id, mtime_ms) SELECT id, mtime_ms FROM documents WHERE id = ?`
      ).run(id)
    })
  }

  beforeAll(async () => {
    setImageAnalyzer(fake)
    clearDerivedTextCache()
    root = makeTestDir('image-ocr-fix-y')
    const files: [string, string, number][] = [
      ['cat.png', 'cat:0.9|', 1_700_000_100],
      ['receipt.png', 'receipt:0.5|合計 1,280円\\n税込\\nお預り 2,000', 1_700_000_090],
      ['textonly.png', '|議事録 第三回 定例', 1_700_000_080],
      ['blank.png', '|', 1_700_000_070],
      ['flaky.png', 'cat:0.9|ふらふら画像の文字', 1_700_000_060],
      ['line.png', 'LINE', 1_700_000_050]
    ]
    // For checking the search limit: 8 images that have the same word in their OCR text.
    for (let i = 0; i < 8; i += 1) files.push([`many${i}.png`, `|共通語 ${i}番`, 1_600_000_000 + i])
    for (const [name, body, mtime] of files) {
      writeFileSync(join(root, name), body)
      utimesSync(join(root, name), mtime, mtime)
    }
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
  beforeEach(() => setImageAnalyzer(fake))
  afterAll(async () => {
    await index.stop()
    await fs.stop()
    if (db.open) db.close()
    removeTestDir(root)
    setImageAnalyzer(null)
  })

  it('Y-8: an image with an empty term row (characters only, or nothing) also enters the OCR queue and can be looked up if it has characters; a line does not enter', async () => {
    expect(state('textonly.png')).toBe('skipped')
    expect(state('line.png')).toBe('skipped')
    expect(store.ocrQueueSize()).toBe(13)
    calls.length = 0
    clearDerivedTextCache()
    await drain()
    expect(store.ocrQueueSize()).toBe(0)
    expect(state('textonly.png')).toBe('indexed')
    expect((await index.search('議事録', 'files', {})).hits.map((h) => h.title)).toEqual(['textonly.png'])
    // If there are no characters even after OCR, it is none (not put in the index; it stays skipped, and only the mark is set).
    expect(ocrMark('blank.png')).toEqual({ v: 1, state: 'none' })
    expect(state('blank.png')).toBe('skipped')
    expect(ocrMark('line.png')).toBeUndefined()
  })

  it('Y-2: a label hit (seq 0) builds the excerpt from the saved label only and does not call OCR; a character hit re-fetches the OCR', async () => {
    calls.length = 0
    clearDerivedTextCache()
    const labelHit = (await index.search('猫', 'files', {})).hits.find((h) => h.title === 'cat.png')
    expect(labelHit?.snippet).toContain('猫')
    expect(calls).toEqual([])
    clearDerivedTextCache()
    const textHit = (await index.search('議事録', 'files', {})).hits[0]
    expect(textHit?.snippet).toContain('議事録')
    expect(calls.filter((c) => c.ocr)).toHaveLength(1)
  })

  it('Y-2: one search re-fetches OCR for at most 5 images; the rest are returned without an excerpt (the hit remains)', async () => {
    clearDerivedTextCache()
    calls.length = 0
    const res = await index.search('共通語', 'files', {})
    expect(res.hits).toHaveLength(8)
    expect(calls.filter((c) => c.ocr).length).toBeLessThanOrEqual(5)
    expect(res.hits.filter((h) => h.snippet === '').length).toBeGreaterThanOrEqual(3)
    expect(res.hits.filter((h) => h.snippet.includes('共通語')).length).toBeGreaterThanOrEqual(1)
  })

  it('Y-1: an OCR failure on a reread is transient: it changes neither the marker nor the state, does not put the failed result in storage, and does not return the document to pending', async () => {
    const before = ocrMark('textonly.png')
    expect(before).toMatchObject({ state: 'done' })
    clearDerivedTextCache()
    control.always = true
    const failing = await index.search('議事録', 'files', {})
    control.always = false
    // The hit remains (without an excerpt).
    expect(failing.hits.map((h) => h.title)).toEqual(['textonly.png'])
    expect(failing.hits[0]?.snippet).toBe('')
    expect(ocrMark('textonly.png')).toEqual(before)
    expect(state('textonly.png')).toBe('indexed')
    // The next search takes it again and the excerpt appears (no failure remains in the place).
    const again = await index.search('議事録', 'files', {})
    expect(again.hits[0]?.snippet).toContain('議事録')
    expect(state('textonly.png')).toBe('indexed')
    // Directly on extractFile: a failure of the reread is transient (no mark is made).
    const meta = (db.prepare(`SELECT metadata FROM documents WHERE name = 'textonly.png'`).get() as { metadata: string }).metadata
    const stored = storedImageLabelsOf(JSON.parse(meta) as Record<string, unknown>)
    clearDerivedTextCache()
    control.always = true
    expect(await extractFile(join(root, 'textonly.png'), { image: stored, ocr: 'reread' })).toEqual({
      ok: false,
      reason: 'transient'
    })
    control.always = false
  })

  it('Y-7: a timeout is retried later only once, and failed after two in a row; the first one changes neither the marker nor the queue', async () => {
    const id = docId('flaky.png')
    requeue(id)
    expect(store.ocrQueueSize()).toBe(1)
    control.timeouts = 1
    await internals().ocrStep('slow')
    expect(ocrMark('flaky.png')).toBeUndefined()
    expect(store.ocrQueueSize()).toBe(1)
    expect(internals().ocrDeferred.get(id)?.fails).toBe(1)
    // While waiting, it drops out of the candidates (so the same image is not hit repeatedly).
    calls.length = 0
    await internals().ocrStep('slow')
    expect(calls).toEqual([])
    // When the wait ends, take it again: this time it succeeds.
    internals().ocrDeferred.set(id, { fails: 1, until: Date.now() - 1 })
    await internals().ocrStep('slow')
    expect(ocrMark('flaky.png')).toMatchObject({ state: 'done' })
    expect(store.ocrQueueSize()).toBe(0)
    // If it times out twice in a row, it is failed (the word row remains).
    requeue(id)
    control.timeouts = 2
    await internals().ocrStep('slow')
    internals().ocrDeferred.set(id, { fails: 1, until: Date.now() - 1 })
    await internals().ocrStep('slow')
    expect(ocrMark('flaky.png')).toEqual({ v: 1, state: 'failed' })
    expect(store.ocrQueueSize()).toBe(0)
    expect(state('flaky.png')).toBe('indexed')
  })

  it("Y-6: fetching candidates only reads; rows to be removed are deleted inside the writer's queue", async () => {
    const id = docId('cat.png')
    store.atomically(() => {
      db.prepare(
        `INSERT OR REPLACE INTO image_ocr_queue (document_id, mtime_ms) SELECT id, mtime_ms FROM documents WHERE id = ?`
      ).run(id)
      db.prepare(`UPDATE documents SET index_state = 'failed' WHERE id = ?`).run(id)
    })
    const got = store.ocrCandidates(1)
    expect(got.stale).toEqual([id])
    expect(got.rows).toEqual([])
    expect(store.ocrQueueSize()).toBe(1) // It is not erased by fetching
    await internals().ocrStep('slow')
    expect(store.ocrQueueSize()).toBe(0)
    db.prepare(`UPDATE documents SET index_state = 'indexed' WHERE id = ?`).run(id)
  })

  it('Y-3: a build for a reindex with a bumped version does not call OCR; the done marker is cleared and goes back to the queue, and the OCR stage re-fetches', async () => {
    expect(ocrMark('receipt.png')).toMatchObject({ state: 'done', kind: 'receipt' })
    for (const name of ['receipt.png', 'textonly.png']) store.requeueIndexed(docId(name))
    calls.length = 0
    clearDerivedTextCache()
    await index.build()
    expect(calls.filter((c) => c.ocr)).toEqual([])
    expect(ocrMark('receipt.png')).toBeUndefined()
    expect(store.ocrQueueSize()).toBeGreaterThanOrEqual(2)
    // After the build, the text is only the word rows (the characters cannot be looked up until the OCR stage returns them).
    expect((await index.search('議事録', 'files', {})).hits).toEqual([])
    await drain()
    expect(ocrMark('receipt.png')).toMatchObject({ state: 'done', kind: 'receipt' })
    expect((await index.search('議事録', 'files', {})).hits.map((h) => h.title)).toEqual(['textonly.png'])
  })
})

describe('TODO 1234: a classification timeout in the build is retried once, like OCR', () => {
  let root: string
  let db: Db
  let store: IndexStore
  let fs: FsIndexer
  let index: IndexService
  interface Internals {
    classifyDeferred: Map<number, { fails: number; until: number }>
    classifyPollMs: number
    pruneClassifyDeferred(): void
  }
  const internals = (): Internals => index as unknown as Internals
  const state = (name: string): string =>
    (db.prepare(`SELECT index_state FROM documents WHERE name = ?`).get(name) as { index_state: string }).index_state
  const hasLabels = (name: string): boolean => {
    const row = db.prepare(`SELECT metadata FROM documents WHERE name = ?`).get(name) as { metadata: string | null }
    return (JSON.parse(row.metadata ?? '{}') as { image?: unknown }).image !== undefined
  }

  beforeEach(async () => {
    setImageAnalyzer(fake)
    clearDerivedTextCache()
    root = makeTestDir('image-classify-timeout')
    writeFileSync(join(root, 'flaky.png'), 'cat:0.9|')
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
  })
  afterEach(async () => {
    await index.stop()
    await fs.stop()
    if (db.open) db.close()
    removeTestDir(root)
  })

  /** Runs the build; each time the image is deferred it makes the retry due at once (the real wait is 60 s). */
  async function buildMakingDue(): Promise<void> {
    const running = index.build()
    let done = false
    void running.finally(() => (done = true))
    while (!done) {
      for (const [id, entry] of internals().classifyDeferred) internals().classifyDeferred.set(id, { ...entry, until: Date.now() - 1 })
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await running
  }

  it('one timeout leaves the row pending and the second attempt classifies it', async () => {
    control.classifyTimeouts = 1
    await buildMakingDue()
    expect(state('flaky.png')).toBe('indexed')
    expect(hasLabels('flaky.png')).toBe(true)
    expect(internals().classifyDeferred.size).toBe(0)
  })

  it('two timeouts in a row settle as before (skipped, no labels) and are not repeated', async () => {
    control.classifyAlways = true
    calls.length = 0
    await buildMakingDue()
    expect(state('flaky.png')).toBe('skipped')
    expect(hasLabels('flaky.png')).toBe(false)
    expect(calls.filter((c) => c.body.startsWith('cat'))).toHaveLength(2)
    expect(internals().classifyDeferred.size).toBe(0)
  })

  const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
    const end = Date.now() + ms
    while (!cond() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20))
  }

  it('a file that becomes pending while the build waits for a retry is indexed without waiting for the retry', async () => {
    internals().classifyPollMs = 20
    control.classifyTimeouts = 1
    const running = index.build()
    await waitFor(() => internals().classifyDeferred.size === 1)
    expect(internals().classifyDeferred.size).toBe(1)
    writeFileSync(join(root, 'late.txt'), 'late text')
    await fs.scan()
    await waitFor(() => state('late.txt') === 'indexed')
    expect(state('late.txt')).toBe('indexed')
    expect(state('flaky.png')).toBe('pending')
    // Let the retry come due so the build can finish.
    for (const [id, entry] of internals().classifyDeferred) internals().classifyDeferred.set(id, { ...entry, until: Date.now() - 1 })
    await running
    expect(state('flaky.png')).toBe('indexed')
  })

  it('a subtree request that leaves a deferred image behind starts a normal build that retries it', async () => {
    internals().classifyPollMs = 20
    control.classifyTimeouts = 1
    const result = await index.buildScope(root)
    expect(result.pending).toBe(1)
    expect(state('flaky.png')).toBe('pending')
    await waitFor(() => {
      for (const [id, entry] of internals().classifyDeferred) internals().classifyDeferred.set(id, { ...entry, until: Date.now() - 1 })
      return state('flaky.png') === 'indexed'
    })
    expect(state('flaky.png')).toBe('indexed')
  })

  it('deferral records of rows that are gone or never revisited are forgotten, with their failure count', () => {
    internals().classifyDeferred.set(987654, { fails: 1, until: Date.now() + 60_000 })
    const flaky = (db.prepare(`SELECT id FROM documents WHERE name = 'flaky.png'`).get() as { id: number }).id
    internals().classifyDeferred.set(flaky, { fails: 1, until: Date.now() - 3_600_000 })
    internals().pruneClassifyDeferred()
    expect(internals().classifyDeferred.size).toBe(0)
    internals().classifyDeferred.set(flaky, { fails: 1, until: Date.now() + 60_000 })
    internals().pruneClassifyDeferred()
    expect(internals().classifyDeferred.size).toBe(1)
  })
})
