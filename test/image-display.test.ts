/**
 * TODO 1154: the entry that converts HEIC / HEIF to JPEG for display (`src/main/image/display.ts`).
 * The function that calls `sips` can be replaced. The test that calls the real `sips` runs on macOS only. The model is not called.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  conversionResponse,
  convertForDisplay,
  MAX_CONVERTED_BYTES,
  MAX_SOURCE_BYTES,
  needsDisplayConversion,
  type DisplaySource,
  type SipsRunner
} from '../src/main/image/display.js'

const JPEG_MAGIC = [0xff, 0xd8, 0xff]

/** Stands in for `openResource` of the Broker: an fd of an opened file (the other side closes it). */
function openSource(path: string): DisplaySource {
  const fd = openSync(path, 'r')
  return { fd, size: fstatSync(fd).size, path }
}

/** A closed fd fails with EBADF on fstat. */
function isClosed(fd: number): boolean {
  try {
    fstatSync(fd)
    return false
  } catch {
    return true
  }
}

describe('needsDisplayConversion', () => {
  it('heic / heif だけ (大文字小文字は問わない)', () => {
    for (const path of ['/a/IMG_1.HEIC', '/a/b.heic', '/a/c.heif', '/a/d.HeIf']) expect(needsDisplayConversion(path)).toBe(true)
    for (const path of ['/a/x.jpg', '/a/x.png', '/a/x.heic.txt', '/a/heic', '/a/x.avif']) expect(needsDisplayConversion(path)).toBe(false)
  })
})

describe('convertForDisplay (sips は差し替え)', () => {
  function fakeRun(calls: string[][], write: (out: string) => void): SipsRunner {
    return async (args) => {
      calls.push([...args])
      write(args[args.length - 1] ?? '')
      return true
    }
  }

  it('固定の旗で sips を呼び、JPEG を返し、一時ディレクトリを消す', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aios-image-test-'))
    const photos = mkdtempSync(join(tmpdir(), 'aios-image-src-'))
    try {
      writeFileSync(join(photos, 'IMG_1.HEIC'), 'heic')
      const source = openSource(join(photos, 'IMG_1.HEIC'))
      const calls: string[][] = []
      const result = await convertForDisplay(source, {
        platform: 'darwin',
        tempDir: base,
        run: fakeRun(calls, (out) => writeFileSync(out, Buffer.from([...JPEG_MAGIC, 1, 2, 3])))
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.contentType).toBe('image/jpeg')
        expect([...result.bytes]).toEqual([...JPEG_MAGIC, 1, 2, 3])
      }
      expect(calls).toHaveLength(1)
      const args = calls[0] ?? []
      expect(args.slice(0, 3)).toEqual(['-s', 'format', 'jpeg'])
      // The input is a copy written to a temporary directory, not the original path (the extension is made lowercase).
      expect(args[3]?.startsWith(join(base, 'aios-display-'))).toBe(true)
      expect(args[3]?.endsWith('/in.heic')).toBe(true)
      expect(args[4]).toBe('--out')
      expect(args).toHaveLength(6)
      expect(isClosed(source.fd)).toBe(true)
      // No temporary file remains (nothing is cached).
      expect(readdirSync(base)).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
      rmSync(photos, { recursive: true, force: true })
    }
  })

  it('検査の後にパスを symlink に差し替えても、検査済みの fd の中身を変換する (TOCTOU、第 71 波 review X)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aios-image-test-'))
    const photos = mkdtempSync(join(tmpdir(), 'aios-image-src-'))
    try {
      const path = join(photos, 'IMG_2.heic')
      writeFileSync(path, 'checked')
      writeFileSync(join(photos, 'secret.heic'), 'secret')
      const source = openSource(path)
      // Replaced between the Broker's check and the conversion.
      renameSync(path, join(photos, 'moved.heic'))
      symlinkSync(join(photos, 'secret.heic'), path)
      const seen: string[] = []
      const result = await convertForDisplay(source, {
        platform: 'darwin',
        tempDir: base,
        run: async (args) => {
          const input = args[3] ?? ''
          seen.push(readFileSync(input, 'utf8'))
          writeFileSync(args[args.length - 1] ?? '', Buffer.from([...JPEG_MAGIC, 9]))
          return true
        }
      })
      expect(result.ok).toBe(true)
      expect(seen).toEqual(['checked'])
      expect(isClosed(source.fd)).toBe(true)
      expect(readdirSync(base)).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
      rmSync(photos, { recursive: true, force: true })
    }
  })

  it('macOS 以外では sips を呼ばず unsupported-platform (fd は閉じる)', async () => {
    const photos = mkdtempSync(join(tmpdir(), 'aios-image-src-'))
    try {
      writeFileSync(join(photos, 'a.heic'), 'heic')
      const source = openSource(join(photos, 'a.heic'))
      const calls: string[][] = []
      const result = await convertForDisplay(source, { platform: 'win32', tempDir: tmpdir(), run: fakeRun(calls, () => undefined) })
      expect(result).toEqual({ ok: false, reason: 'unsupported-platform' })
      expect(calls).toHaveLength(0)
      expect(isClosed(source.fd)).toBe(true)
    } finally {
      rmSync(photos, { recursive: true, force: true })
    }
  })

  it('sips の失敗・出力が無い・空は failed (一時ディレクトリも消える)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aios-image-test-'))
    const photos = mkdtempSync(join(tmpdir(), 'aios-image-src-'))
    try {
      writeFileSync(join(photos, 'a.heic'), 'heic')
      const src = (): DisplaySource => openSource(join(photos, 'a.heic'))
      expect(await convertForDisplay(src(), { platform: 'darwin', tempDir: base, run: async () => false })).toEqual({
        ok: false,
        reason: 'failed'
      })
      expect(await convertForDisplay(src(), { platform: 'darwin', tempDir: base, run: async () => true })).toEqual({
        ok: false,
        reason: 'failed'
      })
      const empty = fakeRun([], (out) => writeFileSync(out, ''))
      expect(await convertForDisplay(src(), { platform: 'darwin', tempDir: base, run: empty })).toEqual({ ok: false, reason: 'failed' })
      expect(readdirSync(base)).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
      rmSync(photos, { recursive: true, force: true })
    }
  })

  it('変換後が上限を越えれば読まずに too-large (大きさは stat で先に見る)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aios-image-test-'))
    const photos = mkdtempSync(join(tmpdir(), 'aios-image-src-'))
    try {
      writeFileSync(join(photos, 'a.heic'), 'heic')
      // Write a sparse file of the limit + 1 byte with no read permission. If it were read it would fail, so if it is too-large, it was not read.
      const huge: SipsRunner = async (args) => {
        const out = args[args.length - 1] ?? ''
        writeFileSync(out, '')
        truncateSync(out, MAX_CONVERTED_BYTES + 1)
        chmodSync(out, 0o000)
        return true
      }
      expect(await convertForDisplay(openSource(join(photos, 'a.heic')), { platform: 'darwin', tempDir: base, run: huge })).toEqual({
        ok: false,
        reason: 'too-large'
      })
      expect(readdirSync(base)).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
      rmSync(photos, { recursive: true, force: true })
    }
  })

  it('元が大きすぎれば写さず too-large', async () => {
    const photos = mkdtempSync(join(tmpdir(), 'aios-image-src-'))
    try {
      writeFileSync(join(photos, 'a.heic'), 'heic')
      const opened = openSource(join(photos, 'a.heic'))
      const calls: string[][] = []
      const result = await convertForDisplay(
        { ...opened, size: MAX_SOURCE_BYTES + 1 },
        { platform: 'darwin', tempDir: tmpdir(), run: fakeRun(calls, () => undefined) }
      )
      expect(result).toEqual({ ok: false, reason: 'too-large' })
      expect(calls).toHaveLength(0)
      expect(isClosed(opened.fd)).toBe(true)
    } finally {
      rmSync(photos, { recursive: true, force: true })
    }
  })
})

describe('conversionResponse', () => {
  it('成功は 200 の image/jpeg、失敗は 415、大きすぎは 413', async () => {
    const ok = conversionResponse({ ok: true, bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/jpeg')
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(conversionResponse({ ok: false, reason: 'failed' }).status).toBe(415)
    expect(conversionResponse({ ok: false, reason: 'unsupported-platform' }).status).toBe(415)
    expect(conversionResponse({ ok: false, reason: 'too-large' }).status).toBe(413)
  })
})

describe.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sips'))('実物の sips (macOS)', () => {
  it('PNG から作った HEIC を JPEG に変換できる (大きさは保たれる)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aios-image-real-'))
    try {
      // A 1x1 PNG (no transparency).
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
        'base64'
      )
      writeFileSync(join(dir, 'in.png'), png)
      execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', join(dir, 'in.png'), '--out', join(dir, 'in.heic')], { stdio: 'ignore' })
      expect(existsSync(join(dir, 'in.heic'))).toBe(true)
      const result = await convertForDisplay(openSource(join(dir, 'in.heic')), { tempDir: dir })
      expect(result.ok).toBe(true)
      if (result.ok) expect([...result.bytes.subarray(0, 3)]).toEqual(JPEG_MAGIC)
      // A broken HEIC is failed.
      writeFileSync(join(dir, 'bad.heic'), 'not an image')
      expect(await convertForDisplay(openSource(join(dir, 'bad.heic')), { tempDir: dir })).toEqual({ ok: false, reason: 'failed' })
      expect(readFileSync(join(dir, 'bad.heic'), 'utf8')).toBe('not an image')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
