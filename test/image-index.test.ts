/**
 * TODO 998: find images by their contents ("photo of a dog"). It passes even without Vision: the analyzer (`ImageAnalyzer`) is replaced, and the boundary with the real helper is checked with a "fake helper that speaks the same protocol" (a node script). The model is not called. User images are not read.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore, fsVersion, retagFsVersion } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import {
  clearDerivedTextCache,
  derivedEpoch,
  extractFile,
  extractGate,
  isDerivedText,
  isExtractable
} from '../src/index-kernel/extract.js'
import {
  configureVisionHelper,
  imageAnalyzer,
  imageAvailable,
  imageIndexVersion,
  setImageAnalyzer,
  storedImageLabelsOf
} from '../src/index-kernel/image.js'
import {
  APPLE_VISION_BACKEND,
  IMAGE_TERMS_VERSION,
  imageLabelText,
  imageTerms,
  labelsToKeep,
  sanitizeImageLabels
} from '../src/common/image-labels/terms.js'
import vocabulary from '../src/common/image-labels/vocabulary.json' with { type: 'json' }
import appleVision from '../src/common/image-labels/apple-vision.json' with { type: 'json' }
import type { ImageAnalyzeOptions, ImageAnalyzer, ImageLabel } from '../src/common/os/image-analysis.js'
import { isPlainQuery, parseQueryFilter } from '../src/index-kernel/query-filter.js'
import { isImageHit } from '../src/renderer/src/components/SearchMode.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

/**
 * Fake images: the contents are a list of labels (`dog:0.3,grass:0.9`). `SMALL` has too short a longest side, and `BAD` cannot be read.
 * The analyzer receives the contents, not the path (the caller reads with O_NOFOLLOW).
 */
const calls: string[] = []
const seenOptions: ImageAnalyzeOptions[] = []
const fake: ImageAnalyzer = {
  backend: APPLE_VISION_BACKEND,
  version: 1,
  async analyze(data, options) {
    const body = Buffer.from(data).toString('utf8')
    calls.push(body)
    if (body === 'SMALL') return { ok: false, reason: 'small' }
    if (body === 'HUGE') return { ok: false, reason: 'large' }
    seenOptions.push(options)
    if (body === 'BAD') return { ok: false, reason: 'corrupt' }
    const labels: ImageLabel[] = body
      .split(',')
      .filter((part) => part.includes(':'))
      .map((part) => {
        const [id, conf] = part.split(':')
        return [id as string, Number(conf)] as const
      })
      .filter((label) => label[1] >= options.minConfidence)
    return { ok: true, width: 640, height: 480, labels }
  },
  dispose() {}
}

afterEach(() => setImageAnalyzer(null))

describe('TODO 998: shared vocabulary and mapping table', () => {
  it('the mapping table may point to terms outside the vocabulary, but broader is only terms inside the vocabulary (followed transitively)', () => {
    const words = vocabulary.words as Record<string, { broader?: string[] }>
    for (const [word, entry] of Object.entries(words)) {
      for (const broader of entry.broader ?? []) expect(words[broader], `${word} → ${broader}`).toBeDefined()
    }
    expect(Object.keys(appleVision.map).length).toBe(appleVision.identifierCount)
  })

  it('label to term: labels at or above the 0.15 floor become terms via the mapping table, with broader and aliases added; in descending order of confidence', () => {
    const terms = imageTerms(
      [
        ['grass', 0.9],
        ['beagle', 0.29],
        ['dog', 0.29],
        ['cat', 0.1]
      ],
      APPLE_VISION_BACKEND
    )
    expect(terms).toContain('犬')
    expect(terms).toContain('dog')
    expect(terms).toContain('ビーグル')
    expect(terms).toContain('動物')
    expect(terms).not.toContain('猫')
    // The word of the label with higher confidence (grass) comes first.
    expect(terms.indexOf('芝生')).toBeGreaterThanOrEqual(0)
    expect(terms.indexOf('芝生')).toBeLessThan(terms.indexOf('犬'))
    expect(new Set(terms).size).toBe(terms.length)
  })

  it('noise labels (an empty array), labels not in the mapping table and unknown backends do not become terms', () => {
    expect(imageTerms([['water', 0.9]], APPLE_VISION_BACKEND)).toEqual([])
    expect(imageTerms([['no_such_label', 0.9]], APPLE_VISION_BACKEND)).toEqual([])
    expect(imageTerms([['__proto__', 0.9]], APPLE_VISION_BACKEND)).toEqual([])
    expect(imageTerms([['dog', 0.9]], 'other-backend')).toEqual([])
    expect(imageLabelText([], APPLE_VISION_BACKEND)).toBe('')
  })

  it('saved labels are those at 0.1 or above in descending order; on restore, elements of the wrong shape are dropped', () => {
    expect(labelsToKeep([['a', 0.05], ['b', 0.2], ['c', 0.5]])).toEqual([['c', 0.5], ['b', 0.2]])
    expect(sanitizeImageLabels([['dog', 0.3], ['x'], [1, 0.2], ['y', 2], 'z', ['cat', 0.4]])).toEqual([
      ['dog', 0.3],
      ['cat', 0.4]
    ])
    expect(sanitizeImageLabels(null)).toEqual([])
    expect(storedImageLabelsOf({})).toBeNull()
    expect(storedImageLabelsOf({ image: { v: 1, backend: 'b', at: '1:2', labels: [['dog', 0.3]] } })).toEqual({
      v: 1,
      backend: 'b',
      at: '1:2',
      labels: [['dog', 0.3]]
    })
  })
})

describe('TODO 998: the search term 「〜の写真」', () => {
  const images = { images: true }
  it('drops the trailing 「(の)写真 / (の)画像」 to narrow to images, and splits the rest at 「の」', () => {
    expect(parseQueryFilter('犬の写真', images)).toMatchObject({ text: '犬', images: true })
    expect(parseQueryFilter('猫画像', images)).toMatchObject({ text: '猫', images: true })
    expect(parseQueryFilter('手書きのメモの写真', images)).toMatchObject({ text: '手書き メモ', images: true })
    // A hiragana "no" between two kana is part of a word.
    expect(parseQueryFilter('きのこの写真', images)).toMatchObject({ text: 'きのこ', images: true })
    expect(parseQueryFilter('dog photo', images)).toMatchObject({ text: 'dog', images: true })
    expect(parseQueryFilter('ｄｏｇ　ＰＨＯＴＯ', images).images).toBe(true)
  })

  it('only 「写真」, no image word, and no options (conversation, file name) behave as before', () => {
    expect(parseQueryFilter('写真', images)).toMatchObject({ text: '写真', images: false })
    expect(parseQueryFilter('犬', images)).toMatchObject({ text: '犬', images: false })
    expect(parseQueryFilter('犬の写真')).toMatchObject({ text: '犬の写真', images: false })
    expect(isPlainQuery(parseQueryFilter('犬の写真'))).toBe(true)
    expect(isPlainQuery(parseQueryFilter('犬の写真', images))).toBe(false)
    // It can be combined with narrowing by extension.
    expect(parseQueryFilter('ext:png 犬の写真', images)).toMatchObject({ text: '犬', exts: ['png'], images: true })
  })
})

describe('TODO 998: environment without an analyzer', () => {
  it('images remain out of scope as before (no marker is set either)', () => {
    expect(imageAvailable()).toBe(false)
    expect(isExtractable('/x/a.png')).toBe(false)
    expect(isDerivedText('/x/a.png')).toBe(true)
    expect(fsVersion({ isDirectory: false, mtimeMs: 1, size: 2, name: 'a.png' })).toBe('1:2')
    expect(imageIndexVersion()).toBe(0)
    expect(configureVisionHelper('/no/such/helper')).toBe(false)
    expect(configureVisionHelper(null)).toBe(false)
  })

  it('with an analyzer they are in scope, the version gets :vl, and the generation changes; the inside of the Photos app library is out of scope', () => {
    const before = derivedEpoch()
    setImageAnalyzer(fake)
    expect(isExtractable('/x/a.JPG')).toBe(true)
    expect(isExtractable('/x/Photos Library.photoslibrary/originals/a.heic')).toBe(false)
    expect(isExtractable('/x/a.svg')).toBe(true)
    expect(isDerivedText('/x/a.svg')).toBe(false)
    const tag = `:vl${1 * 100_000 + IMAGE_TERMS_VERSION}`
    expect(fsVersion({ isDirectory: false, mtimeMs: 1, size: 2, name: 'a.heic' })).toBe(`1:2${tag}`)
    expect(retagFsVersion('1:2', 'a.png')).toBe(`1:2${tag}`)
    expect(retagFsVersion(`1:2${tag}:dataless`, 'a.txt')).toBe('1:2:dataless')
    expect(derivedEpoch()).not.toBe(before)
    expect(Number.isSafeInteger(derivedEpoch())).toBe(true)
  })
})

describe('TODO 998: extractFile / extractGate', () => {
  it('TODO 998: extractFile / extractGate: term row, too small, unreadable, an image that yields no terms', async () => {
    const dir = makeTestDir('image-extract')
    try {
      setImageAnalyzer(fake)
      clearDerivedTextCache()
      writeFileSync(join(dir, 'dog.png'), 'grass:0.9,dog:0.29')
      writeFileSync(join(dir, 'icon.png'), 'SMALL')
      writeFileSync(join(dir, 'bad.jpg'), 'BAD')
      writeFileSync(join(dir, 'noise.png'), 'water:0.9')
      writeFileSync(join(dir, 'bomb.png'), 'HUGE')
      const ok = await extractFile(join(dir, 'dog.png'))
      expect(ok.ok && ok.text.split(' ')).toContain('犬')
      expect(ok.ok && ok.derived).toBe(true)
      expect(ok.ok && ok.image?.labels).toEqual([
        ['grass', 0.9],
        ['dog', 0.29]
      ])
      expect(await extractFile(join(dir, 'icon.png'))).toEqual({ ok: false, reason: 'empty' })
      expect(await extractFile(join(dir, 'bad.jpg'))).toEqual({ ok: false, reason: 'corrupt' })
      // An image that does not become a word (all labels are below the minimum, or labels with no word) remains with an empty body (fix Y-8: it is put in the OCR queue).
      const noise = await extractFile(join(dir, 'noise.png'))
      expect(noise.ok && noise.text).toBe('')
      expect(noise.ok && noise.image?.labels).toEqual([['water', 0.9]])
      // Images whose dimensions exceed the limit (decompression bomb, security review) are out of scope. The analyzer receives the limit and the size it decodes down to.
      expect(await extractFile(join(dir, 'bomb.png'))).toEqual({ ok: false, reason: 'too-large' })
      expect(seenOptions.at(-1)).toMatchObject({ maxSide: 16_384, maxPixels: 100_000_000, decodeSide: 2048, minSide: 128 })
      // Binary files also pass the gate (the NUL check is not applied).
      writeFileSync(join(dir, 'bin.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]))
      expect(await extractGate(join(dir, 'bin.png'))).toBeNull()
      setImageAnalyzer(null)
      expect(await extractFile(join(dir, 'dog.png'))).toEqual({ ok: false, reason: 'extension' })
    } finally {
      removeTestDir(dir)
    }
  })

  it('if the saved labels match the current file and version, the analyzer is not called; if not, it analyzes again', async () => {
    const dir = makeTestDir('image-hint')
    try {
      setImageAnalyzer(fake)
      clearDerivedTextCache()
      const path = join(dir, 'cat.png')
      writeFileSync(path, 'cat:0.8')
      const first = await extractFile(path)
      expect(first.ok).toBe(true)
      const stored = first.ok ? first.image! : null
      clearDerivedTextCache()
      calls.length = 0
      const again = await extractFile(path, { image: stored })
      expect(calls).toEqual([])
      expect(again.ok && again.text).toBe(first.ok && first.text)
      // If the analyzer version differs, or the file changed (`at` differs), analyze it again.
      await extractFile(path, { image: { ...stored!, v: 99 } })
      clearDerivedTextCache()
      await extractFile(path, { image: { ...stored!, at: '0:0' } })
      expect(calls).toHaveLength(2)
    } finally {
      removeTestDir(dir)
    }
  })

  it('a symlink image is not read, and the analyzer receives the content, not the path', async () => {
    const dir = makeTestDir('image-symlink')
    try {
      setImageAnalyzer(fake)
      clearDerivedTextCache()
      writeFileSync(join(dir, 'real.png'), 'dog:0.5')
      symlinkSync(join(dir, 'real.png'), join(dir, 'link.png'))
      calls.length = 0
      expect(await extractFile(join(dir, 'link.png'))).toEqual({ ok: false, reason: 'unreadable' })
      expect(calls).toEqual([])
      expect((await extractFile(join(dir, 'real.png'))).ok).toBe(true)
      expect(calls).toEqual(['dog:0.5'])
    } finally {
      removeTestDir(dir)
    }
  })
})

describe('TODO 998: indexing and search (real IndexService)', () => {
  let root: string
  let db: Db
  let store: IndexStore
  let fs: FsIndexer
  let index: IndexService

  beforeAll(async () => {
    setImageAnalyzer(fake)
    clearDerivedTextCache()
    root = makeTestDir('image-index')
    // A photo of a dog with "dog" in neither the file name nor the body (acceptance condition 1).
    writeFileSync(join(root, 'IMG_0001.jpg'), 'grass:0.88,dog:0.3,beagle:0.29')
    writeFileSync(join(root, 'IMG_0002.heic'), 'cat:0.7')
    writeFileSync(join(root, 'tiny.png'), 'SMALL')
    writeFileSync(join(root, 'bomb.png'), 'HUGE')
    // A text whose body says the Japanese for "photo of a dog". Since the search is narrowed to images, it does not match the full phrase, but it does match "dog".
    writeFileSync(join(root, 'memo.md'), '犬の写真を撮る予定\n')
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

  const rowOf = (name: string): { id: number; index_state: string; version: string; metadata: string | null } =>
    db
      .prepare(`SELECT id, index_state, version, metadata FROM documents WHERE source = 'fs' AND name = ?`)
      .get(name) as { id: number; index_state: string; version: string; metadata: string | null }

  it('images are indexed (version :vl), and labels go into metadata; images that are too small or too large are skipped', () => {
    setImageAnalyzer(fake)
    expect(rowOf('IMG_0001.jpg').index_state).toBe('indexed')
    expect(rowOf('IMG_0001.jpg').version).toMatch(/:vl\d+$/)
    const meta = JSON.parse(rowOf('IMG_0001.jpg').metadata ?? '{}') as { image?: { labels: unknown } }
    expect(meta.image?.labels).toEqual([
      ['grass', 0.88],
      ['dog', 0.3],
      ['beagle', 0.29]
    ])
    expect(rowOf('tiny.png').index_state).toBe('skipped')
    expect(rowOf('bomb.png').index_state).toBe('skipped')
  })

  it('「犬の写真」 returns dog images and not text files; the excerpt is the matched term, and the analyzer is not called', async () => {
    setImageAnalyzer(fake)
    clearDerivedTextCache()
    calls.length = 0
    const result = await index.search('犬の写真', 'files', {})
    expect(result.hits.map((h) => h.title)).toEqual(['IMG_0001.jpg'])
    expect(result.hits[0]?.snippet).toContain('犬')
    expect(calls).toEqual([])
    expect(isImageHit(result.hits[0]!)).toBe(true)
    // For a word that is not narrowed, both text and images appear.
    const plain = (await index.search('犬', 'files', {})).hits.map((h) => h.title).sort()
    expect(plain).toEqual(['IMG_0001.jpg', 'memo.md'])
    // Photos of a cat (HEIC) too.
    expect((await index.search('ねこの画像', 'files', {})).hits.map((h) => h.title)).toEqual(['IMG_0002.heic'])
    // A conversation search does not drop the Japanese word for "photo".
    expect((await index.search('犬の写真', 'conversation', {})).hits).toEqual([])
  })

  it('no body text other than labels (the term row) remains in the DB', () => {
    const dump = JSON.stringify(db.prepare(`SELECT * FROM chunks`).all())
    expect(dump).not.toContain('ビーグル')
  })

  it('in an environment without an analyzer, 「犬の写真」 is looked up as terms (matching text bodies)', async () => {
    setImageAnalyzer(null)
    try {
      const titles = (await index.search('犬の写真', 'files', {})).hits.map((h) => h.title)
      expect(titles).toContain('memo.md')
    } finally {
      setImageAnalyzer(fake)
    }
  })
})

describe('TODO 998: helper child process (fake helper)', () => {
  // The same interface as the real one: a one-line header ({id, size, minConfidence, minSide}), followed by size bytes of contents.
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
    if (body === 'crash') process.exit(3)
    if (body === 'huge') { console.log(JSON.stringify({ id: req.id, ok: false, error: 'large', w: 20000, h: 20000, cpuUs: 10, limits: [req.maxSide, req.maxPixels, req.decodeSide] })); continue }
    if (body === 'small') { console.log(JSON.stringify({ id: req.id, ok: false, error: 'small', w: 64, h: 64, cpuUs: 10 })); continue }
    if (body === 'bad') { console.log(JSON.stringify({ id: req.id, ok: false, error: 'decode', cpuUs: 10 })); continue }
    console.log(JSON.stringify({ id: req.id, ok: true, w: 640, h: req.minSide, labels: [['dog', 0.3], ['low', req.minConfidence], 'junk'], cpuUs: 5000 }))
  }
})
`
  const bytes = (text: string): Buffer => Buffer.from(text, 'utf8')
  const options = { minConfidence: 0.1, minSide: 128, maxSide: 16_384, maxPixels: 100_000_000, decodeSide: 2048 }
  it.skipIf(process.platform !== 'darwin')('response, too small, unreadable, and cleanup and recreation after a crashed child', async () => {
    const dir = makeTestDir('vision-helper')
    try {
      const helper = join(dir, 'fake-helper')
      writeFileSync(helper, script)
      chmodSync(helper, 0o755)
      expect(configureVisionHelper(helper)).toBe(true)
      expect(imageAvailable()).toBe(true)
      const x = imageAnalyzer()!
      expect(x.backend).toBe(APPLE_VISION_BACKEND)
      expect(await x.analyze(bytes('ok'), options)).toEqual({
        ok: true,
        width: 640,
        height: 128,
        labels: [
          ['dog', 0.3],
          ['low', 0.1]
        ]
      })
      expect(await x.analyze(bytes('small'), options)).toEqual({ ok: false, reason: 'small' })
      expect(await x.analyze(bytes('huge'), options)).toEqual({ ok: false, reason: 'large' })
      expect(await x.analyze(bytes('bad'), options)).toEqual({ ok: false, reason: 'corrupt' })
      // A child that crashed, or timed out, gives no response (not necessarily the image's fault).
      expect(await x.analyze(bytes('crash'), options)).toEqual({ ok: false, reason: 'timeout' })
      expect((await x.analyze(bytes('ok2'), options)).ok).toBe(true)
      const both = await Promise.all([x.analyze(bytes('1'), options), x.analyze(bytes('2'), options)])
      expect(both.map((r) => r.ok)).toEqual([true, true])
    } finally {
      setImageAnalyzer(null)
      removeTestDir(dir)
    }
  })
})
