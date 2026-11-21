/**
 * TODO 1009: puts the body of PDFs into the index (stage 2 of 997). It passes even without PDFKit: the extractor (`PdfExtractor`) is replaced, and the interface with the real helper
 * is checked with a "fake helper that speaks the same contract" (a node script). The model is not called.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { IndexStore, fsVersion, retagFsVersion } from '../src/index-kernel/store.js'
import { IndexService } from '../src/index-kernel/service.js'
import {
  clearDerivedTextCache,
  derivedEpoch,
  derivedTextDigest,
  extractFile,
  extractGate,
  isExtractable
} from '../src/index-kernel/extract.js'
import {
  compactCjkSpaces,
  compactPdfPages,
  configurePdfHelper,
  pdfAvailable,
  pdfPageOfByte,
  PDF_EXTRACTOR_VERSION,
  setPdfExtractor,
  type PdfExtractor
} from '../src/index-kernel/pdf.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

vi.mock('@parcel/watcher', () => ({
  default: { subscribe: async () => ({ unsubscribe: async () => {} }) }
}))

/**
 * A fake PDF: the body after `%PDF-1.4\n` is taken as the "extracted body" as it is. `mode.prefix` imitates changes in the output.
 * The extractor receives the contents, not the path (TODO 1009's review: the caller reads with O_NOFOLLOW).
 */
const mode = { prefix: '' }
const fake: PdfExtractor = {
  async extract(data, limitBytes) {
    const body = Buffer.from(data).toString('utf8').replace(/^%PDF-1\.4\n/, '')
    if (body.startsWith('CORRUPT')) return { ok: false, reason: 'corrupt' }
    // If the body contains \f, the page is split there (a newline after each page, as the real helper does).
    if (body.includes('\f')) {
      const pages = body.split('\f')
      return {
        ok: true,
        text: pages.map((p) => `${p}\n`).join(''),
        truncated: false,
        pageLengths: pages.map((p) => p.length + 1)
      }
    }
    const text = mode.prefix + body
    const buffer = Buffer.from(text, 'utf8')
    return buffer.byteLength > limitBytes
      ? { ok: true, text: buffer.subarray(0, limitBytes).toString('utf8').replace(/�+$/, ''), truncated: true }
      : { ok: true, text, truncated: false }
  },
  dispose() {}
}

const pdf = (body: string): string => `%PDF-1.4\n${body}`

afterEach(() => setPdfExtractor(null))

describe('TODO 1009: CJK の間の空白', () => {
  it('かな・漢字・CJK の記号に挟まれた空白だけ詰め、改行と英数字の間は残す', () => {
    expect(compactCjkSpaces('設 定 の 資 料')).toBe('設定の資料')
    expect(compactCjkSpaces('ひら　がな\tカ タ カ ナ')).toBe('ひらがなカタカナ')
    expect(compactCjkSpaces('日本語 abc 日本語')).toBe('日本語 abc 日本語')
    expect(compactCjkSpaces('一行目\n二行目')).toBe('一行目\n二行目')
    expect(compactCjkSpaces('「 括弧 」')).toBe('「括弧」')
  })

  it('全角の英数の語の間の空白は残し、全角の句読点・半角カナとの間は詰める (review)', () => {
    expect(compactCjkSpaces('ＡＢＣ　ＤＥＦ')).toBe('ＡＢＣ　ＤＥＦ')
    expect(compactCjkSpaces('１２３ ４５６')).toBe('１２３ ４５６')
    expect(compactCjkSpaces('ｶﾀ ｶﾅ')).toBe('ｶﾀｶﾅ')
    expect(compactCjkSpaces('本文 ！ 次')).toBe('本文！次')
    expect(compactCjkSpaces('（ 注 ）')).toBe('（注）')
    expect(compactCjkSpaces('価格 ￥')).toBe('価格￥')
  })
})

describe('TODO 1009: ヘルパーが無い環境', () => {
  it('PDF は今までどおり対象外 (印も付かない)', () => {
    expect(pdfAvailable()).toBe(false)
    expect(isExtractable('/x/a.pdf')).toBe(false)
    expect(fsVersion({ isDirectory: false, mtimeMs: 1, size: 2, name: 'a.pdf' })).toBe('1:2')
    expect(configurePdfHelper('/no/such/helper')).toBe(false)
    expect(configurePdfHelper(null)).toBe(false)
  })

  it('取り出し器があれば対象で、版に :pk が付き、世代が変わる', () => {
    const before = derivedEpoch()
    setPdfExtractor(fake)
    expect(isExtractable('/x/a.pdf')).toBe(true)
    expect(isExtractable('/x/App.app/a.pdf')).toBe(false)
    expect(fsVersion({ isDirectory: false, mtimeMs: 1, size: 2, name: 'A.PDF' })).toBe(`1:2:pk${PDF_EXTRACTOR_VERSION}`)
    expect(retagFsVersion('1:2', 'a.pdf')).toBe(`1:2:pk${PDF_EXTRACTOR_VERSION}`)
    expect(retagFsVersion(`1:2:pk${PDF_EXTRACTOR_VERSION}:dataless`, 'a.txt')).toBe('1:2:dataless')
    expect(derivedEpoch()).not.toBe(before)
  })
})

describe('TODO 1009: extractFile / extractGate', () => {
  it('取り出し・CJK の空白・上限・0 字・壊れた PDF・%PDF- の無いファイル', async () => {
    const dir = makeTestDir('pdf-extract')
    try {
      setPdfExtractor(fake)
      writeFileSync(join(dir, 'a.pdf'), pdf('設 定 の 資 料 pdfuniqueword'))
      writeFileSync(join(dir, 'empty.pdf'), pdf('  \n '))
      writeFileSync(join(dir, 'bad.pdf'), pdf('CORRUPT'))
      writeFileSync(join(dir, 'fake.pdf'), 'plain text')
      writeFileSync(join(dir, 'big.pdf'), pdf('あ'.repeat(200_000)))
      clearDerivedTextCache()
      const ok = await extractFile(join(dir, 'a.pdf'))
      expect(ok.ok && ok.text).toBe('設定の資料 pdfuniqueword')
      expect(ok.ok && ok.derived).toBe(true)
      expect(await extractFile(join(dir, 'empty.pdf'))).toEqual({ ok: false, reason: 'empty' })
      expect(await extractFile(join(dir, 'bad.pdf'))).toEqual({ ok: false, reason: 'corrupt' })
      const big = await extractFile(join(dir, 'big.pdf'))
      expect(big.ok && big.truncated).toBe(true)
      expect(big.ok && Buffer.byteLength(big.text, 'utf8')).toBeLessThanOrEqual(256 * 1024)
      expect(await extractGate(join(dir, 'a.pdf'))).toBeNull()
      expect(await extractGate(join(dir, 'fake.pdf'))).toBe('corrupt')
      setPdfExtractor(null)
      expect(await extractFile(join(dir, 'a.pdf'))).toEqual({ ok: false, reason: 'extension' })
    } finally {
      removeTestDir(dir)
    }
  })

  it('symlink の PDF は読まず、取り出し器にはパスでなく O_NOFOLLOW で読んだ中身が渡る (review)', async () => {
    const dir = makeTestDir('pdf-symlink')
    try {
      const seen: Uint8Array[] = []
      setPdfExtractor({
        async extract(data, limitBytes) {
          seen.push(data)
          return fake.extract(data, limitBytes)
        },
        dispose() {}
      })
      writeFileSync(join(dir, 'real.pdf'), pdf('real body'))
      symlinkSync(join(dir, 'real.pdf'), join(dir, 'link.pdf'))
      clearDerivedTextCache()
      expect(await extractFile(join(dir, 'link.pdf'))).toEqual({ ok: false, reason: 'unreadable' })
      expect(seen).toHaveLength(0)
      const ok = await extractFile(join(dir, 'real.pdf'))
      expect(ok.ok && ok.text).toBe('real body')
      expect(ok.ok && ok.bytes).toBe(Buffer.byteLength(pdf('real body')))
      expect(Buffer.from(seen[0]!).toString('utf8')).toBe(pdf('real body'))
    } finally {
      removeTestDir(dir)
    }
  })
})

describe('TODO 1009: ページの境目 (compactPdfPages / pdfPageOfByte)', () => {
  it('ページごとの長さから、空白を詰めた後のバイト位置の始まりを出す', () => {
    const text = '設 定\nab\n第 三\n'
    expect(compactPdfPages(text, [4, 3, 4], 1000).starts).toEqual([0, 7, 10])
    expect(compactCjkSpaces(text)).toBe('設定\nab\n第三\n')
  })

  it('合計が合わない・負の値・上限以降のページ', () => {
    expect(compactPdfPages('abc\n', [2], 1000).starts).toEqual([])
    expect(compactPdfPages('abc\n', [], 1000).starts).toEqual([])
    expect(compactPdfPages('aa\nbb\ncc\n', [3, 3, 3], 4).starts).toEqual([0, 3])
  })

  it('テキストは全文を一度に詰めたものと同じ (1 周で、ページの合わない・上限で止めた場合も)', () => {
    const text = '設 定\nab  c\n第\u3000三 章\n'
    for (const [lengths, limit] of [
      [[4, 6, 6], 1000],
      [[4, 6, 6], 4],
      [[4, 6], 1000],
      [[], 1000],
      [[99], 1000]
    ] as const) {
      expect(compactPdfPages(text, lengths, limit).text).toBe(compactCjkSpaces(text))
    }
  })

  it('バイト位置からページ (1 始まり) を引く。境目ちょうどは次のページ', () => {
    const starts = [0, 16, 43]
    expect(pdfPageOfByte(starts, 0)).toBe(1)
    expect(pdfPageOfByte(starts, 15)).toBe(1)
    expect(pdfPageOfByte(starts, 16)).toBe(2)
    expect(pdfPageOfByte(starts, 9999)).toBe(3)
    expect(pdfPageOfByte([], 5)).toBeNull()
  })
})

describe('TODO 1009: 取り出したテキストの digest (review)', () => {
  it('置き場の項目と同じテキストなら覚えた digest、違うテキストはその場で計算する', async () => {
    const dir = makeTestDir('pdf-digest')
    try {
      setPdfExtractor(fake)
      clearDerivedTextCache()
      const path = join(dir, 'd.pdf')
      writeFileSync(path, pdf('digest body'))
      const result = await extractFile(path)
      expect(result.ok).toBe(true)
      const text = result.ok ? result.text : ''
      const sha = (t: string): string => createHash('sha256').update(t).digest('hex')
      expect(derivedTextDigest(path, text)).toBe(sha(text))
      expect(derivedTextDigest(path, text)).toBe(sha(text))
      expect(derivedTextDigest(path, 'other')).toBe(sha('other'))
      expect(derivedTextDigest(join(dir, 'none.pdf'), text)).toBe(sha(text))
    } finally {
      removeTestDir(dir)
    }
  })
})

describe('TODO 1009: 索引と取り出し直しの安全網 (実物の IndexService)', () => {
  let root: string
  let db: Db
  let store: IndexStore
  let fs: FsIndexer
  let index: IndexService

  beforeEach(() => setPdfExtractor(fake))

  beforeAll(async () => {
    setPdfExtractor(fake)
    clearDerivedTextCache()
    root = makeTestDir('pdf-index')
    writeFileSync(join(root, 'paper.pdf'), pdf('設 定 の 資 料\n' + 'x'.repeat(10) + ' pdfuniqueword here'))
    writeFileSync(join(root, 'scan.pdf'), pdf('   '))
    // Three pages. The first page has its CJK spaces squeezed out, so the page boundaries are kept as byte positions after squeezing.
    writeFileSync(join(root, 'pages.pdf'), pdf('設 定 の 資 料\fsecond pageuniqueword here\f第 三 頁 thirdpageuniqueword'))
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
    setPdfExtractor(null)
  })

  const rowOf = (name: string): { id: number; index_state: string; version: string } =>
    db.prepare(`SELECT id, index_state, version FROM documents WHERE source = 'fs' AND name = ?`).get(name) as {
      id: number
      index_state: string
      version: string
    }

  it('索引され (版に :pk)、0 字の PDF は skipped', () => {
    expect(rowOf('paper.pdf').index_state).toBe('indexed')
    expect(rowOf('paper.pdf').version.endsWith(`:pk${PDF_EXTRACTOR_VERSION}`)).toBe(true)
    expect(rowOf('scan.pdf').index_state).toBe('skipped')
  })

  it('本文の語で当たり、詰めた CJK の語でも当たる。DB に本文は残らない', async () => {
    const hit = (await index.search('pdfuniqueword', 'files', {})).hits.find((h) => h.title === 'paper.pdf')
    expect(hit?.snippet).toContain('pdfuniqueword')
    const compact = (await index.search('設定', 'files', {})).hits.find((h) => h.title === 'paper.pdf')
    expect(compact).toBeDefined()
    const dump = JSON.stringify([db.prepare(`SELECT * FROM documents`).all(), db.prepare(`SELECT * FROM chunks`).all()])
    expect(dump).not.toContain('pdfuniqueword')
  })

  it('ページの境目が documents.metadata に入り (本文は無い)、ヒットがそのページを持つ', async () => {
    const row = db.prepare(`SELECT metadata FROM documents WHERE source = 'fs' AND name = 'pages.pdf'`).get() as {
      metadata: string
    }
    const starts = (JSON.parse(row.metadata) as { pdfPages: number[] }).pdfPages
    // A 5-character Japanese line plus a newline is 16 bytes (5 × 3 + 1); the next one, "second pageuniqueword here\n", is 27 bytes.
    expect(starts).toEqual([0, 16, 43])
    expect(row.metadata).not.toContain('pageuniqueword')
    const hitOf = async (q: string): Promise<number | undefined> =>
      (await index.search(q, 'files', {})).hits.find((h) => h.title === 'pages.pdf')?.page
    expect(await hitOf('設定')).toBe(1)
    expect(await hitOf('secondpageuniqueword'.replace('secondpage', 'second page'))).toBe(2)
    expect(await hitOf('thirdpageuniqueword')).toBe(3)
    // A hit in a PDF with no boundaries (no page marks) has no page.
    const plain = (await index.search('pdfuniqueword', 'files', {})).hits.find((h) => h.title === 'paper.pdf')
    expect(plain?.page).toBeUndefined()
  })

  it('取り出しの出力が変わると (hash が合わない) 抜粋を出さず、索引し直しに積む', async () => {
    const id = rowOf('paper.pdf').id
    try {
      mode.prefix = '先頭に増えた行\n'
      clearDerivedTextCache()
      const result = await index.search('pdfuniqueword', 'files', {})
      expect(result.hits.find((h) => h.title === 'paper.pdf')).toBeUndefined()
      expect(await index.getDocumentText(String(id), 0, 100, false)).toBeNull()
      await vi.waitFor(() => expect(rowOf('paper.pdf').index_state).toBe('pending'))
      // The build re-extracts and re-indexes → it matches again.
      await index.build()
      expect(rowOf('paper.pdf').index_state).toBe('indexed')
      const again = (await index.search('pdfuniqueword', 'files', {})).hits.find((h) => h.title === 'paper.pdf')
      expect(again?.snippet).toContain('pdfuniqueword')
    } finally {
      mode.prefix = ''
      clearDerivedTextCache()
    }
  })
})

describe('TODO 1009: ヘルパーの子プロセス (偽のヘルパー)', () => {
  // The same interface as the real one: a one-line header ({id, size, ...}) followed by size bytes of contents.
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
    if (body === 'hang') continue
    if (body === 'bad') { console.log(JSON.stringify({ id: req.id, ok: false, error: 'open', cpuUs: 1000000 })); continue }
    console.log(JSON.stringify({ id: req.id, ok: true, text: 'ほん ぶん ' + body, pages: 1, pageLengths: [('ほん ぶん ' + body).length + 1], truncated: false, cpuUs: body === 'heavy' ? 2000000 : 0 }))
  }
})
`
  const bytes = (text: string): Buffer => Buffer.from(text, 'utf8')
  it.skipIf(process.platform !== 'darwin')('応答・エラー・落ちた子の後始末と作り直し', async () => {
    const dir = makeTestDir('pdf-helper')
    try {
      const helper = join(dir, 'fake-helper')
      writeFileSync(helper, script)
      chmodSync(helper, 0o755)
      expect(configurePdfHelper(helper)).toBe(true)
      expect(pdfAvailable()).toBe(true)
      const { pdfExtractor } = await import('../src/index-kernel/pdf.js')
      const x = pdfExtractor()
      expect(x).not.toBeNull()
      const ok = await x!.extract(bytes('ok\nに改行'), 1000)
      expect(ok).toEqual({ ok: true, text: 'ほん ぶん ok\nに改行', truncated: false, pageLengths: [13] })
      expect(await x!.extract(bytes('bad'), 1000)).toEqual({ ok: false, reason: 'corrupt' })
      expect(await x!.extract(bytes('crash'), 1000)).toEqual({ ok: false, reason: 'corrupt' })
      // Even after a child that died, the next request makes a new child and answers.
      expect((await x!.extract(bytes('ok2'), 1000)).ok).toBe(true)
      // Even when stacked at the same time, they are answered one by one.
      const both = await Promise.all([x!.extract(bytes('1'), 1000), x!.extract(bytes('2'), 1000)])
      expect(both.map((r) => r.ok)).toEqual([true, true])
    } finally {
      setPdfExtractor(null)
      removeTestDir(dir)
    }
  })
  it.skipIf(process.platform !== 'darwin')('子の CPU 時間 (cpuUs) が低速の段の休みに数えられる (TODO 1226)', async () => {
    const { SlowPacer } = await import('../src/index-kernel/pace.js')
    const dir = makeTestDir('pdf-helper-cpu')
    try {
      const helper = join(dir, 'fake-helper')
      writeFileSync(helper, script)
      chmodSync(helper, 0o755)
      expect(configurePdfHelper(helper)).toBe(true)
      const { pdfExtractor } = await import('../src/index-kernel/pdf.js')
      const x = pdfExtractor()!
      const pacer = new SlowPacer()
      // Preface: for a response where the child's CPU time is 0, the rest is only that of the indexing process (it does not reach the child's 2 seconds).
      const idle = pacer.clock()
      await x.extract(bytes('ok'), 1000)
      expect(idle.restMs()).toBeLessThan(500)
      // A response where the child used 2 seconds: the rest that keeps it within N% of one core is at least 2000 ms × (100/N − 1).
      const heavy = pacer.clock()
      await x.extract(bytes('heavy'), 1000)
      expect(heavy.restMs()).toBeGreaterThanOrEqual(2000 * (100 / pacer.dutyPercent - 1))
      // The CPU time of a failed response (a PDF that cannot be opened) is also counted.
      const failed = pacer.clock()
      expect(await x.extract(bytes('bad'), 1000)).toEqual({ ok: false, reason: 'corrupt' })
      expect(failed.restMs()).toBeGreaterThanOrEqual(1000 * (100 / pacer.dutyPercent - 1))
    } finally {
      setPdfExtractor(null)
      removeTestDir(dir)
    }
  })
})
