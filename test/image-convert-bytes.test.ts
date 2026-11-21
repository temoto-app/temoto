/**
 * TODO 1162: the entry that turns the bytes of an image in the temporary display (HEIC inside a zip) into a JPEG for display. `sips` is replaced (the model is not called).
 * Checks the type and the OS, and the audit of `ViewerBroker.convertImageForDisplay` (the size limit is the same constant as the fd path).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertBytesForDisplay, sniffHeif, type SipsRunner } from '../src/main/image/display.js'
import { ViewerBroker } from '../src/main/capability/viewer.js'
import { isHeifName } from '../src/shared/transient-file.js'
import type { AuditEntry } from '../src/shared/plugin.js'

function ftyp(brand: string, compatible: string[] = []): Uint8Array {
  const body = Buffer.concat([Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(4), ...compatible.map((c) => Buffer.from(c))])
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length + 4)
  return new Uint8Array(Buffer.concat([head, body, Buffer.alloc(32)]))
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3])

describe('sniffHeif / isHeifName', () => {
  it('HEIC 系の brand は通し、AVIF・他の形は通さない', () => {
    expect(sniffHeif(ftyp('heic'))).toBe(true)
    expect(sniffHeif(ftyp('mif1', ['heic']))).toBe(true)
    expect(sniffHeif(ftyp('avif'))).toBe(false)
    expect(sniffHeif(ftyp('mif1', ['avif']))).toBe(false)
    expect(sniffHeif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false)
    expect(sniffHeif(new Uint8Array(4))).toBe(false)
  })
  it('compatible brands は ftyp の箱の大きさの中だけ読む (範囲の外の heic は弾き、64 バイトより後の heic は通す)', () => {
    // An AVIF whose box ends at 16 bytes and has heic right after it (outside the box) is rejected.
    const short = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(4), Buffer.from('heic'), Buffer.alloc(32)])
    short.writeUInt32BE(16, 0)
    expect(sniffHeif(new Uint8Array(short))).toBe(false)
    // A HEIF that has heic in a compatible brand after 64 bytes is passed.
    const fillers = Array.from({ length: 20 }, () => 'mif1')
    expect(sniffHeif(ftyp('mif1', [...fillers, 'heic']))).toBe(true)
    // If the box size is less than 16 (broken), the brand is not read.
    const broken = Buffer.from(ftyp('mif1', ['heic']))
    broken.writeUInt32BE(8, 0)
    expect(sniffHeif(new Uint8Array(broken))).toBe(false)
  })
  it('名前は最後の要素の拡張子だけを見る', () => {
    expect(isHeifName('DCIM/IMG_1.HEIC')).toBe(true)
    expect(isHeifName('a\\b.heif')).toBe(true)
    expect(isHeifName('a.heic/b.jpg')).toBe(false)
    expect(isHeifName('a.png')).toBe(false)
    expect(isHeifName('.heic')).toBe(false)
  })
})

describe('convertBytesForDisplay', () => {
  const run =
    (calls: string[][]): SipsRunner =>
    async (args) => {
      calls.push([...args])
      writeFileSync(args[args.length - 1] ?? '', JPEG)
      return true
    }

  it('バイト列を一時ファイルに書いて固定の旗で変換し、一時ディレクトリを消す', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aios-conv-'))
    try {
      const calls: string[][] = []
      const data = ftyp('heic')
      let seen: Buffer | null = null
      const result = await convertBytesForDisplay(data, 'photos/IMG_1.HEIC', {
        platform: 'darwin',
        tempDir: base,
        run: async (args) => {
          seen = readFileSync(args[3] ?? '')
          return run(calls)(args)
        }
      })
      expect(result.ok).toBe(true)
      expect(calls[0]?.slice(0, 3)).toEqual(['-s', 'format', 'jpeg'])
      expect(Buffer.from(seen ?? []).equals(Buffer.from(data))).toBe(true)
      expect(readdirSync(base)).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('拡張子・中身の型・OS が合わなければ sips を呼ばない', async () => {
    const calls: string[][] = []
    const deps = { platform: 'darwin' as const, tempDir: tmpdir(), run: run(calls) }
    expect(await convertBytesForDisplay(ftyp('heic'), 'a.jpg', deps)).toEqual({ ok: false, reason: 'failed' })
    expect(await convertBytesForDisplay(new Uint8Array(100), 'a.heic', deps)).toEqual({ ok: false, reason: 'failed' })
    expect(await convertBytesForDisplay(ftyp('heic'), 'a.heic', { ...deps, platform: 'win32' })).toEqual({
      ok: false,
      reason: 'unsupported-platform'
    })
    expect(calls).toEqual([])
  })

  it('sips の失敗は failed', async () => {
    expect(await convertBytesForDisplay(ftyp('heic'), 'a.heic', { platform: 'darwin', tempDir: tmpdir(), run: async () => false })).toEqual({
      ok: false,
      reason: 'failed'
    })
  })
})

describe('ViewerBroker.convertImageForDisplay', () => {
  function make(imageConvert: ConstructorParameters<typeof ViewerBroker>[0]['imageConvert']): { broker: ViewerBroker; audit: AuditEntry[] } {
    const audit: AuditEntry[] = []
    const broker = new ViewerBroker({
      broker: {} as never,
      audit: { record: (entry: AuditEntry) => audit.push(entry) } as never,
      scope: {} as never,
      resolveViewer: () => null,
      imageConvert
    })
    return { broker, audit }
  }

  it('成功も拒否も aios.image の名義で監査に残り、対象は名前の最後の要素だけ', async () => {
    const { broker, audit } = make({
      platform: 'darwin',
      tempDir: tmpdir(),
      run: async (args) => {
        writeFileSync(args[args.length - 1] ?? '', JPEG)
        return true
      }
    })
    expect((await broker.convertImageForDisplay('secret/dir/IMG.heic', ftyp('heic'))).ok).toBe(true)
    expect(await broker.convertImageForDisplay('x.heic', new Uint8Array(50))).toEqual({ ok: false, reason: 'failed' })
    expect(audit.map((e) => [e.pluginId, e.capability, e.op, e.target, e.decision, e.reason])).toEqual([
      ['aios.image', 'image', 'convertForDisplay', 'IMG.heic', 'allow', null],
      ['aios.image', 'image', 'convertForDisplay', 'x.heic', 'deny', 'failed']
    ])
  })

  it('renderer の値は信用しない: 型が違えば failed、設定が無ければ変換しない', async () => {
    const { broker } = make({ platform: 'darwin', tempDir: tmpdir(), run: async () => true })
    expect(await broker.convertImageForDisplay(42, ftyp('heic'))).toEqual({ ok: false, reason: 'failed' })
    expect(await broker.convertImageForDisplay('a.heic', 'text')).toEqual({ ok: false, reason: 'failed' })
    expect(await make(undefined).broker.convertImageForDisplay('a.heic', ftyp('heic'))).toEqual({ ok: false, reason: 'failed' })
  })
})
