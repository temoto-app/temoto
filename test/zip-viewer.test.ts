/**
 * TODO 905: `aios.zip` (the list of a zip's contents, and the transient view of a file inside it). The zip is assembled inside the test (no fixture is placed).
 * The model is not called.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32 as zlibCrc32, deflateRawSync } from 'node:zlib'
import {
  ZipError,
  baseNameOf,
  bytesRangeSource,
  crc32,
  decodeEntryName,
  extractZipEntry,
  isOpenableEntryName,
  isUnsafeEntryName,
  readZipListing,
  urlRangeSource,
  type RangeSource,
  type ZipEntry
} from '../plugins/aios.zip/viewer/zip.js'
import { formatSize, sortedEntries } from '../plugins/aios.zip/viewer/zip-view.js'
import { createBlobPayloads } from '../plugins/_shared/bridge.js'
import {
  MAX_TRANSIENT_TEXT_BYTES,
  acceptOpenEntry,
  archiveLabelOf,
  transientFileLabel,
  transientFilePayload,
  wireResource,
  type TransientFileView
} from '../src/renderer/src/transient-file.js'
import { transientFileBaseName, transientFileMime, transientFileResolveUri } from '../src/shared/transient-file.js'
import { resolveTransientFileViewer } from '../src/main/capability/transient-file.js'
import { MAX_TRANSIENT_FILE_BYTES, MAX_TRANSIENT_FILE_NAME, type ResolvedViewer } from '../src/shared/plugin.js'
import { CONTENT_TYPES, contentTypeForExtension } from '../src/shared/content-type.js'
import { resourceContentType } from '../src/main/capability/resource.js'

const repoRoot = join(import.meta.dirname, '..')

// ---- assembling a zip ----

interface TestEntry {
  readonly name: string | Uint8Array
  readonly data?: Uint8Array
  readonly method?: number
  /** Replaces the compressed bytes (a broken zip). */
  readonly rawCompressed?: Uint8Array
  readonly flags?: number
  readonly extra?: Uint8Array
  readonly madeBy?: number
  readonly external?: number
  readonly crc?: number
  readonly usize?: number
}

const enc = new TextEncoder()

class Writer {
  private readonly parts: Uint8Array[] = []
  length = 0
  u8(v: number): this {
    return this.bytes(Uint8Array.of(v))
  }
  u16(v: number): this {
    const b = new Uint8Array(2)
    new DataView(b.buffer).setUint16(0, v, true)
    return this.bytes(b)
  }
  u32(v: number): this {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, v >>> 0, true)
    return this.bytes(b)
  }
  u64(v: number): this {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true)
    return this.bytes(b)
  }
  bytes(b: Uint8Array): this {
    this.parts.push(b)
    this.length += b.length
    return this
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const p of this.parts) {
      out.set(p, at)
      at += p.length
    }
    return out
  }
}

function buildZip(
  entries: readonly TestEntry[],
  options: { zip64?: boolean; prefix?: Uint8Array; comment?: string } = {}
): Uint8Array {
  const w = new Writer()
  if (options.prefix !== undefined) w.bytes(options.prefix)
  const base = options.prefix?.length ?? 0
  const central = new Writer()
  for (const entry of entries) {
    const name = typeof entry.name === 'string' ? enc.encode(entry.name) : entry.name
    const data = entry.data ?? new Uint8Array(0)
    const method = entry.method ?? 0
    const compressed = entry.rawCompressed ?? (method === 8 ? new Uint8Array(deflateRawSync(data)) : data)
    const crc = entry.crc ?? crc32(data)
    const usize = entry.usize ?? data.length
    const flags = entry.flags ?? (typeof entry.name === 'string' ? 0x0800 : 0)
    const offset = w.length - base
    const extra = entry.extra ?? new Uint8Array(0)
    w.u32(0x04034b50).u16(20).u16(flags).u16(method).u16(0x6000).u16(0x5a21).u32(crc)
    w.u32(compressed.length).u32(usize).u16(name.length).u16(0).bytes(name).bytes(compressed)
    let centralExtra = extra
    if (options.zip64 === true) {
      const z = new Writer().u16(0x0001).u16(24).u64(usize).u64(compressed.length).u64(offset)
      centralExtra = new Writer().bytes(z.done()).bytes(extra).done()
    }
    central.u32(0x02014b50).u16(entry.madeBy ?? 0x0314).u16(20).u16(flags).u16(method).u16(0x6000).u16(0x5a21).u32(crc)
    central.u32(options.zip64 === true ? 0xffffffff : compressed.length)
    central.u32(options.zip64 === true ? 0xffffffff : usize)
    central.u16(name.length).u16(centralExtra.length).u16(0).u16(0).u16(0).u32(entry.external ?? 0)
    central.u32(options.zip64 === true ? 0xffffffff : offset)
    central.bytes(name).bytes(centralExtra)
  }
  const cdOffset = w.length - base
  const cd = central.done()
  w.bytes(cd)
  const comment = enc.encode(options.comment ?? '')
  if (options.zip64 === true) {
    const eocd64At = w.length - base
    w.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0)
    w.u64(entries.length).u64(entries.length).u64(cd.length).u64(cdOffset)
    w.u32(0x07064b50).u32(0).u64(eocd64At).u32(1)
    w.u32(0x06054b50).u16(0).u16(0).u16(0xffff).u16(0xffff).u32(0xffffffff).u32(0xffffffff)
  } else {
    w.u32(0x06054b50).u16(0).u16(0).u16(entries.length).u16(entries.length).u32(cd.length).u32(cdOffset)
  }
  w.u16(comment.length).bytes(comment)
  return w.done()
}

async function list(bytes: Uint8Array, limits?: Parameters<typeof readZipListing>[1]): Promise<readonly ZipEntry[]> {
  return (await readZipListing(bytesRangeSource(bytes), limits)).entries
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    if (err instanceof ZipError) return err.reason
    throw err
  }
  return 'resolved'
}

function entryNamed(entries: readonly ZipEntry[], name: string): ZipEntry {
  const found = entries.find((e) => e.name === name)
  if (found === undefined) throw new Error(`no entry ${name}`)
  return found
}

// ---- listing ----

describe('aios.zip の一覧 (TODO 905)', () => {
  it('CRC-32 は zlib と同じ', () => {
    const data = enc.encode('hello, zip')
    expect(crc32(data)).toBe(zlibCrc32(data))
  })

  it('UTF-8 の名前・フォルダ・大きさ・圧縮方式を読み、stored と deflate を取り出せる', async () => {
    const text = enc.encode('あいうえお\n'.repeat(200))
    const zip = buildZip([
      { name: 'docs/' },
      { name: 'docs/読んで.txt', data: text, method: 8 },
      { name: 'raw.bin', data: Uint8Array.of(1, 2, 3, 0, 5) }
    ])
    const listing = await readZipListing(bytesRangeSource(zip))
    expect(listing.totalEntries).toBe(3)
    expect(listing.truncated).toBe(false)
    expect(listing.zip64).toBe(false)
    const [folder, doc, raw] = listing.entries
    expect(folder?.directory).toBe(true)
    expect(doc?.name).toBe('docs/読んで.txt')
    expect(doc?.encoding).toBe('utf8')
    expect(doc?.baseName).toBe('読んで.txt')
    expect(doc?.method).toBe(8)
    expect(doc?.uncompressedSize).toBe(text.length)
    expect(doc?.compressedSize).toBeLessThan(text.length)
    expect(doc?.modifiedMs).not.toBeNull()
    expect(raw?.directory).toBe(false)
    const source = bytesRangeSource(zip)
    expect(await extractZipEntry(source, doc as ZipEntry)).toEqual(text)
    expect(await extractZipEntry(source, raw as ZipEntry)).toEqual(Uint8Array.of(1, 2, 3, 0, 5))
    expect(await reason(extractZipEntry(source, folder as ZipEntry))).toBe('directory')
  })

  it('旗の無い Shift_JIS の名前 (Windows の日本語) を推す', async () => {
    // Shift_JIS bytes for a Japanese file name (a name meaning 'Japanese', then '.txt').
    const sjis = Uint8Array.of(0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x2e, 0x74, 0x78, 0x74)
    const [entry] = await list(buildZip([{ name: sjis, data: enc.encode('x') }]))
    expect(entry?.name).toBe('日本語.txt')
    expect(entry?.encoding).toBe('shift_jis')
  })

  it('旗の無い UTF-8 の名前 (macOS のアーカイブユーティリティ) は UTF-8 のまま', async () => {
    const [entry] = await list(buildZip([{ name: enc.encode('写真/海.jpg'), data: enc.encode('x') }]))
    expect(entry?.name).toBe('写真/海.jpg')
    expect(entry?.encoding).toBe('utf8')
  })

  it('UTF-8 でも Shift_JIS でもなければ CP437', () => {
    expect(decodeEntryName(Uint8Array.of(0x41, 0xfd, 0x2e, 0x74, 0x78, 0x74), false)).toEqual({
      name: 'A².txt',
      encoding: 'cp437'
    })
    // If the flag is set, it is read as UTF-8 (broken bytes become U+FFFD).
    expect(decodeEntryName(Uint8Array.of(0x41, 0xff), true).encoding).toBe('utf8')
  })

  it('Info-ZIP の Unicode Path (0x7075) は元の名前の CRC が合うときだけ使う', async () => {
    const raw = Uint8Array.of(0x41, 0xfd, 0x2e, 0x74, 0x78, 0x74)
    const unicode = enc.encode('正しい名前.txt')
    const extraFor = (crc: number): Uint8Array =>
      new Writer().u16(0x7075).u16(5 + unicode.length).u8(1).u32(crc).bytes(unicode).done()
    const [good] = await list(buildZip([{ name: raw, data: enc.encode('x'), extra: extraFor(crc32(raw)) }]))
    expect(good?.name).toBe('正しい名前.txt')
    expect(good?.encoding).toBe('unicode-extra')
    const [stale] = await list(buildZip([{ name: raw, data: enc.encode('x'), extra: extraFor(1) }]))
    expect(stale?.encoding).toBe('cp437')
  })

  it('拡張タイムスタンプ (0x5455) があれば更新日時はそれ', async () => {
    const extra = new Writer().u16(0x5455).u16(5).u8(1).u32(1_700_000_000).done()
    const [entry] = await list(buildZip([{ name: 'a.txt', data: enc.encode('x'), extra }]))
    expect(entry?.modifiedMs).toBe(1_700_000_000_000)
  })

  it('Unix の mode・DOS の属性でフォルダと分かる (末尾の / が無くても)', async () => {
    const entries = await list(
      buildZip([
        { name: 'unixdir', madeBy: 0x0314, external: (0o040755 << 16) >>> 0 },
        { name: 'dosdir', madeBy: 0x0014, external: 0x10 },
        { name: 'empty.txt', madeBy: 0x0314, external: (0o100644 << 16) >>> 0 }
      ])
    )
    expect(entries.map((e) => e.directory)).toEqual([true, true, false])
  })

  it('暗号化された項目は一覧に出るが、開こうとすると encrypted', async () => {
    const zip = buildZip([
      { name: 'secret.txt', data: enc.encode('xxxx'), flags: 0x0801 },
      { name: 'aes.txt', data: enc.encode('xxxx'), method: 99 }
    ])
    const entries = await list(zip)
    expect(entries.map((e) => e.encrypted)).toEqual([true, true])
    for (const entry of entries) expect(await reason(extractZipEntry(bytesRangeSource(zip), entry))).toBe('encrypted')
  })

  it('stored / deflate 以外の圧縮方式は unsupported-method', async () => {
    const zip = buildZip([{ name: 'a.bz2.txt', data: enc.encode('x'), method: 12 }])
    const [entry] = await list(zip)
    expect(await reason(extractZipEntry(bytesRangeSource(zip), entry as ZipEntry))).toBe('unsupported-method')
  })

  it('zip64 (EOCD64 と 0x0001 の拡張) を読む', async () => {
    const data = enc.encode('zip64 body')
    const zip = buildZip([{ name: 'big/one.txt', data, method: 8 }, { name: 'two.txt', data }], { zip64: true })
    const listing = await readZipListing(bytesRangeSource(zip))
    expect(listing.zip64).toBe(true)
    expect(listing.entries.map((e) => [e.name, e.uncompressedSize])).toEqual([
      ['big/one.txt', data.length],
      ['two.txt', data.length]
    ])
    expect(await extractZipEntry(bytesRangeSource(zip), listing.entries[1] as ZipEntry)).toEqual(data)
  })

  it('先頭に別のデータが付いた zip (自己展開形式) と、末尾の注釈', async () => {
    const data = enc.encode('inside')
    const zip = buildZip([{ name: 'a.txt', data, method: 8 }], { prefix: new Uint8Array(1000).fill(7), comment: 'note' })
    const [entry] = await list(zip)
    expect(await extractZipEntry(bytesRangeSource(zip), entry as ZipEntry)).toEqual(data)
  })

  it('先頭に別のデータが付いた zip64 (EOCD64 の位置にも前置きのずれを効かせる、code-review)', async () => {
    const data = enc.encode('sfx zip64 body')
    const zip = buildZip([{ name: 'a.txt', data, method: 8 }, { name: 'b.txt', data }], {
      zip64: true,
      prefix: new Uint8Array(4096).fill(9)
    })
    const listing = await readZipListing(bytesRangeSource(zip))
    expect(listing.zip64).toBe(true)
    expect(listing.entries.map((e) => e.name)).toEqual(['a.txt', 'b.txt'])
    expect(await extractZipEntry(bytesRangeSource(zip), listing.entries[0] as ZipEntry)).toEqual(data)
    expect(await extractZipEntry(bytesRangeSource(zip), listing.entries[1] as ZipEntry)).toEqual(data)
    // If the EOCD64 signature is neither at the position it claims nor just before the locator, the zip is broken.
    const broken = zip.slice()
    const eocd64At = broken.length - 22 - 20 - 56
    broken[eocd64At] = 0
    expect(await reason(readZipListing(bytesRangeSource(broken)))).toBe('corrupt')
  })

  it('zip でない・壊れた zip', async () => {
    expect(await reason(readZipListing(bytesRangeSource(enc.encode('not a zip at all, just text'))))).toBe('not-zip')
    expect(await reason(readZipListing(bytesRangeSource(new Uint8Array(4))))).toBe('not-zip')
    const zip = buildZip([{ name: 'a.txt', data: enc.encode('x') }])
    // Breaks the signature of the central directory.
    const broken = zip.slice()
    const cdAt = broken.length - 22 - 46 - 'a.txt'.length
    broken[cdAt] = 0
    expect(await reason(readZipListing(bytesRangeSource(broken)))).toBe('corrupt')
  })

  it('CRC・大きさが合わない・宣言より多く伸びる中身は corrupt', async () => {
    const data = enc.encode('a'.repeat(5000))
    const badCrc = buildZip([{ name: 'a.txt', data, method: 8, crc: 1234 }])
    const [a] = await list(badCrc)
    expect(await reason(extractZipEntry(bytesRangeSource(badCrc), a as ZipEntry))).toBe('corrupt')
    // The declared size is 10 bytes, but it grows to 5000 bytes (a lying central directory).
    const lying = buildZip([{ name: 'b.txt', data, method: 8, usize: 10 }])
    const [b] = await list(lying)
    expect(await reason(extractZipEntry(bytesRangeSource(lying), b as ZipEntry))).toBe('corrupt')
    // A byte sequence that cannot be read as deflate.
    const garbage = buildZip([{ name: 'c.txt', data, method: 8, rawCompressed: Uint8Array.of(0xff, 0xff, 0xff, 0xff) }])
    const [c] = await list(garbage)
    expect(await reason(extractZipEntry(bytesRangeSource(garbage), c as ZipEntry))).toBe('corrupt')
  })

  it('上限: 一覧の件数・開く大きさ・圧縮比 (zip bomb)', async () => {
    const many = buildZip(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.txt`, data: enc.encode(String(i)) })))
    const listing = await readZipListing(bytesRangeSource(many), { maxEntries: 10 })
    expect(listing.entries).toHaveLength(10)
    expect(listing.totalEntries).toBe(30)
    expect(listing.truncated).toBe(true)
    // Even if the central directory is cut at the cap, what could be read is shown.
    const cut = await readZipListing(bytesRangeSource(many), { maxDirectoryBytes: 200 })
    expect(cut.truncated).toBe(true)
    expect(cut.entries.length).toBeGreaterThan(0)
    expect(cut.entries.length).toBeLessThan(30)

    const zeros = new Uint8Array(2 * 1024 * 1024)
    const bomb = buildZip([{ name: 'zeros.bin', data: zeros, method: 8 }])
    const [entry] = await list(bomb)
    expect((entry as ZipEntry).uncompressedSize / (entry as ZipEntry).compressedSize).toBeGreaterThan(100)
    expect(await reason(extractZipEntry(bytesRangeSource(bomb), entry as ZipEntry, { maxRatio: 100 }))).toBe('suspicious-ratio')
    expect(await reason(extractZipEntry(bytesRangeSource(bomb), entry as ZipEntry, { maxBytes: 1024 * 1024 }))).toBe('too-large')
    // Within the default cap it can be opened.
    expect((await extractZipEntry(bytesRangeSource(bomb), entry as ZipEntry, { maxRatio: 100_000 })).byteLength).toBe(zeros.length)
  })

  it('zip slip の名前はそのまま見せ、印を付け、拡張子は最後の要素から', async () => {
    const entries = await list(
      buildZip([
        { name: '../../etc/passwd.txt', data: enc.encode('x') },
        { name: '/abs/x.png', data: enc.encode('x') },
        { name: 'C:\\win\\y.md', data: enc.encode('x') },
        { name: 'ok/fine.txt', data: enc.encode('x') }
      ])
    )
    expect(entries.map((e) => e.name)).toEqual(['../../etc/passwd.txt', '/abs/x.png', 'C:\\win\\y.md', 'ok/fine.txt'])
    expect(entries.map((e) => e.unsafeName)).toEqual([true, true, true, false])
    expect(entries.map((e) => e.baseName)).toEqual(['passwd.txt', 'x.png', 'y.md', 'fine.txt'])
    expect(isUnsafeEntryName('a\u0000b.txt')).toBe(true)
    expect(isUnsafeEntryName('a..b/c.txt')).toBe(false)
    expect(baseNameOf('dir/')).toBe('dir')
  })

  it('最後の要素は host と同じ規則 (. と .. を飛ばす)、開けない名前は押せない (code-review)', () => {
    for (const name of ['evil/..', '..', 'a/./', 'x/../y.txt', 'C:\\w\\.', 'ok.txt']) {
      expect(baseNameOf(name)).toBe(transientFileBaseName(name))
    }
    expect(baseNameOf('evil/..')).toBe('evil')
    expect(isOpenableEntryName('ok/a.txt')).toBe(true)
    expect(isOpenableEntryName('evil/..')).toBe(true)
    expect(isOpenableEntryName('..')).toBe(false)
    expect(isOpenableEntryName('./..')).toBe(false)
    expect(isOpenableEntryName('x'.repeat(MAX_TRANSIENT_FILE_NAME + 1))).toBe(false)
    // Does not differ from the host's receiving side: a name judged openable is also accepted by the host, and a name judged not openable is also dropped by the host.
    const data = Uint8Array.of(1)
    for (const name of ['ok/a.txt', 'evil/..', '..', './..', 'x'.repeat(MAX_TRANSIENT_FILE_NAME + 1)]) {
      expect(acceptOpenEntry({ uri: '', name, data }, '') !== null).toBe(isOpenableEntryName(name))
    }
  })

  it('範囲読みの口: 206 なら範囲、200 なら全体を覚えて切る', async () => {
    const body = Uint8Array.from({ length: 100 }, (_, i) => i)
    const calls: string[] = []
    const ranged = urlRangeSource('aios-res://x', 100, (async (_url: string, init?: RequestInit) => {
      const header = (init?.headers as Record<string, string>).Range ?? ''
      calls.push(header)
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(header) ?? []
      return new Response(body.slice(Number(from), Number(to) + 1), { status: 206 })
    }) as typeof fetch)
    expect(await ranged.read(10, 5)).toEqual(Uint8Array.of(10, 11, 12, 13, 14))
    expect(calls).toEqual(['bytes=10-14'])
    let wholeCalls = 0
    const whole = urlRangeSource('blob:x', 100, (async () => {
      wholeCalls++
      return new Response(body, { status: 200 })
    }) as typeof fetch)
    expect(await whole.read(90, 3)).toEqual(Uint8Array.of(90, 91, 92))
    expect(await whole.read(0, 2)).toEqual(Uint8Array.of(0, 1))
    expect(wholeCalls).toBe(1)
  })

  it('読み手は全体を読まない (末尾と中央ディレクトリ、開く項目だけ)', async () => {
    const big = new Uint8Array(300_000).map((_, i) => (i * 7919) & 0xff)
    const zip = buildZip([
      { name: 'big.bin', data: big },
      { name: 'small.txt', data: enc.encode('small') }
    ])
    let readBytes = 0
    const inner = bytesRangeSource(zip)
    const counting: RangeSource = {
      size: inner.size,
      read: async (offset, length) => {
        readBytes += length
        return inner.read(offset, length)
      }
    }
    const listing = await readZipListing(counting)
    expect(readBytes).toBeLessThan(70_000)
    readBytes = 0
    await extractZipEntry(counting, entryNamed(listing.entries, 'small.txt'))
    expect(readBytes).toBeLessThan(100)
  })

  it('一覧は名前の順 (数字は数として)、大きさの表記', () => {
    const e = (name: string): ZipEntry => ({ name }) as ZipEntry
    expect(sortedEntries([e('b/10.txt'), e('b/'), e('a.txt'), e('b/9.txt')]).map((x) => x.name)).toEqual([
      'a.txt',
      'b/',
      'b/9.txt',
      'b/10.txt'
    ])
    expect(formatSize(10)).toBe('10 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

// ---- passing the files inside ----

describe('zip の中のファイルの一時表示 (TODO 905)', () => {
  const view = (name: string, data: Uint8Array): TransientFileView => ({ kind: 'file', name, source: 'a.zip', data, nonce: 1 })

  it('host は open-entry を検め直す (表示中の書庫・名前・型・大きさ)', () => {
    const data = Uint8Array.of(1, 2, 3)
    expect(acceptOpenEntry({ uri: 'file:///x/a.zip', name: 'd/b.txt', data }, 'file:///x/a.zip')).toEqual({ name: 'd/b.txt', data })
    expect(acceptOpenEntry({ uri: 'file:///x/other.zip', name: 'b.txt', data }, 'file:///x/a.zip')).toBeNull()
    expect(acceptOpenEntry({ uri: 'file:///x/a.zip', name: 'b.txt', data }, null)).toBeNull()
    expect(acceptOpenEntry({ uri: 'file:///x/a.zip', name: '', data }, 'file:///x/a.zip')).toBeNull()
    expect(acceptOpenEntry({ uri: 'file:///x/a.zip', name: '../', data }, 'file:///x/a.zip')).toBeNull()
    expect(acceptOpenEntry({ uri: 'file:///x/a.zip', name: 'x'.repeat(5000), data }, 'file:///x/a.zip')).toBeNull()
    expect(acceptOpenEntry({ uri: 'file:///x/a.zip', name: 'b.txt', data: [1, 2] }, 'file:///x/a.zip')).toBeNull()
    const huge = { byteLength: MAX_TRANSIENT_FILE_BYTES + 1 }
    Object.setPrototypeOf(huge, Uint8Array.prototype)
    expect(acceptOpenEntry({ uri: 'file:///x/a.zip', name: 'b.txt', data: huge }, 'file:///x/a.zip')).toBeNull()
    // Inside a transient view (an archive within an archive), the URI is the empty string.
    expect(acceptOpenEntry({ uri: '', name: 'b.txt', data }, '')).toEqual({ name: 'b.txt', data })
  })

  it('URL で受ける viewer にはバイト列 (型付き)、テキストの viewer には文字列か「バイナリ」', () => {
    const svg = enc.encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
    expect(transientFilePayload(view('img/logo.svg', svg), { delivery: 'url' })).toEqual({
      kind: 'bytes',
      data: svg,
      size: svg.length,
      mime: 'image/svg+xml'
    })
    expect(transientFilePayload(view('a.txt', enc.encode('こんにちは')), { delivery: 'text' })).toEqual({
      kind: 'text',
      text: 'こんにちは',
      truncated: false,
      size: 15
    })
    expect(transientFilePayload(view('a.bin', Uint8Array.of(65, 0, 66)), { delivery: 'text' })).toEqual({
      kind: 'error',
      message: 'binary'
    })
  })

  it('テキストは 2 MB で切り、UTF-8 の文字の途中では切らない', () => {
    const data = new Uint8Array(MAX_TRANSIENT_TEXT_BYTES + 10).fill(0x61)
    // Places a 3-byte character across the limit's boundary.
    data.set(enc.encode('あ'), MAX_TRANSIENT_TEXT_BYTES - 1)
    const payload = transientFilePayload(view('a.txt', data), { delivery: 'text' })
    expect(payload.kind).toBe('text')
    if (payload.kind !== 'text') return
    expect(payload.truncated).toBe(true)
    expect(payload.text.length).toBe(MAX_TRANSIENT_TEXT_BYTES - 1)
    expect(payload.text.endsWith('\ufffd')).toBe(false)
    expect(payload.size).toBe(data.length)
  })

  it('名前の最後の要素で viewer を引く (書庫の中のパスは効かない)', () => {
    expect(transientFileBaseName('../../a/b.PNG')).toBe('b.PNG')
    expect(transientFileBaseName('a\\b\\c.md')).toBe('c.md')
    expect(transientFileBaseName('..')).toBe('')
    expect(transientFileResolveUri('../x/日本 語.md')).toBe(`file:///${encodeURIComponent('日本 語.md')}`)
    expect(transientFileMime('x/Y.SVG')).toBe('image/svg+xml')
    expect(transientFileMime('noext')).toBeNull()
    expect(archiveLabelOf('file:///Users/me/%E8%B3%87%E6%96%99.zip')).toBe('資料.zip')
    expect(transientFileLabel(view('d/e.txt', new Uint8Array(0)))).toBe('a.zip › d/e.txt')
  })

  it('main は仮の URI で解決するだけで、許可に結びつく欄を渡さない', () => {
    const asked: string[] = []
    const resolver = (uri: string): ResolvedViewer => {
      asked.push(uri)
      return { pluginId: 'aios.image', name: 'Image', url: 'aios-plugin://aios.image/viewer/index.html', editable: true, delivery: 'url', linkTargetUri: 'file:///secret' }
    }
    expect(resolveTransientFileViewer(resolver, '../../a.png')).toEqual({
      pluginId: 'aios.image',
      name: 'Image',
      url: 'aios-plugin://aios.image/viewer/index.html',
      editable: false,
      delivery: 'url'
    })
    expect(asked).toEqual(['file:///a.png'])
    expect(resolveTransientFileViewer(resolver, 42)).toBeNull()
    expect(resolveTransientFileViewer(resolver, '../')).toBeNull()
    expect(resolveTransientFileViewer(resolver, 'x'.repeat(5000))).toBeNull()
    expect(asked).toHaveLength(1)
  })

  it('bridge はバイト列を blob: の URL にし、同じ中身の送り直しでは作り直さない', () => {
    const created: Blob[] = []
    const revoked: string[] = []
    const convert = createBlobPayloads({
      create: (blob) => {
        created.push(blob)
        return `blob:null/${created.length}`
      },
      revoke: (url) => revoked.push(url)
    })
    const bytes = { kind: 'bytes' as const, data: Uint8Array.of(1, 2), size: 2, mime: 'image/png' }
    expect(convert(bytes, 'k1')).toEqual({ kind: 'binary', resourceUrl: 'blob:null/1', size: 2 })
    expect(convert(bytes, 'k1')).toEqual({ kind: 'binary', resourceUrl: 'blob:null/1', size: 2 })
    expect(created[0]?.type).toBe('image/png')
    expect(convert(bytes, 'k2')).toEqual({ kind: 'binary', resourceUrl: 'blob:null/2', size: 2 })
    expect(revoked).toEqual(['blob:null/1'])
    // A resend mark (bytes-ref) uses the previous URL as it is, and does not recreate it.
    expect(convert({ kind: 'bytes-ref', size: 2 }, 'k2')).toEqual({ kind: 'binary', resourceUrl: 'blob:null/2', size: 2 })
    expect(created).toHaveLength(2)
    // If the previous bytes are different contents, it cannot be drawn.
    expect(convert({ kind: 'bytes-ref', size: 2 }, 'k9')).toEqual({ kind: 'error', message: 'missing bytes' })
    const text = { kind: 'text' as const, text: 'x', truncated: false, size: 1 }
    expect(convert(text, 'k3')).toBe(text)
    expect(revoked).toEqual(['blob:null/1', 'blob:null/2'])
  })

  it('host はバイト列を同じ port に 1 回だけ送り、以後は大きさだけ (code-review)', () => {
    const bytes = { kind: 'bytes' as const, data: new Uint8Array(10), size: 10, mime: null }
    expect(wireResource(bytes, false)).toBe(bytes)
    expect(wireResource(bytes, true)).toEqual({ kind: 'bytes-ref', size: 10 })
    const text = { kind: 'text' as const, text: 'x', truncated: false, size: 1 }
    expect(wireResource(text, true)).toBe(text)
  })

  it('拡張子 → 型の表は aios-res:// の配信と一時表示で 1 つ (code-review)', () => {
    for (const [ext, type] of Object.entries(CONTENT_TYPES)) {
      expect(resourceContentType(`/a/b.${ext.toUpperCase()}`)).toBe(type)
      expect(transientFileMime(`d/b.${ext}`)).toBe(type)
    }
    expect(contentTypeForExtension('.AVI')).toBe('video/x-msvideo')
    expect(contentTypeForExtension('toString')).toBeNull()
    expect(resourceContentType('/a/b.exe')).toBe('application/octet-stream')
  })
})

describe('aios.zip の同梱物 (TODO 905)', () => {
  it('CSP は aios-res: と blob: の fetch だけ、zip.css に色の直書きが無い', () => {
    const html = readFileSync(join(repoRoot, 'plugins/aios.zip/viewer/index.html'), 'utf8')
    const csp = /content="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain('connect-src aios-res: blob:')
    expect(csp).not.toMatch(/unsafe-eval|https?:/)
    const css = readFileSync(join(repoRoot, 'plugins/aios.zip/viewer/zip.css'), 'utf8')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
  })

  it('一時表示のバイト列を受ける viewer は CSP で blob: を開けている', () => {
    const csp = (id: string): string =>
      /content="([^"]+)"/.exec(readFileSync(join(repoRoot, 'plugins', id, 'viewer/index.html'), 'utf8'))?.[1] ?? ''
    expect(csp('aios.image')).toMatch(/img-src aios-res: blob:/)
    expect(csp('aios.video')).toMatch(/media-src aios-res: blob:/)
    expect(csp('aios.pdf')).toMatch(/connect-src aios-res: aios-plugin: blob:/)
    expect(csp('aios.office')).toMatch(/connect-src aios-res: blob:/)
  })
})
