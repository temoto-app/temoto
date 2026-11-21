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
  it('HEIC family brands pass, while AVIF and other forms do not', () => {
    expect(sniffHeif(ftyp('heic'))).toBe(true)
    expect(sniffHeif(ftyp('mif1', ['heic']))).toBe(true)
    expect(sniffHeif(ftyp('avif'))).toBe(false)
    expect(sniffHeif(ftyp('mif1', ['avif']))).toBe(false)
    expect(sniffHeif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false)
    expect(sniffHeif(new Uint8Array(4))).toBe(false)
  })
  it('compatible brands are read only within the size of the ftyp box (a heic outside the range is rejected, and one after 64 bytes passes)', () => {
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
  it('the name looks only at the extension of the last element', () => {
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

  it('writes the bytes to a temporary file, converts with fixed flags, and removes the temporary directory', async () => {
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

  it('does not call sips if the extension, content type and OS do not match', async () => {
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

  it('a sips failure is failed', async () => {
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

  it('both success and refusal are left in the audit under the name aios.image, and the target is only the last element of the name', async () => {
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

  it("the renderer's value is not trusted: a wrong type is failed, and without the setting nothing is converted", async () => {
    const { broker } = make({ platform: 'darwin', tempDir: tmpdir(), run: async () => true })
    expect(await broker.convertImageForDisplay(42, ftyp('heic'))).toEqual({ ok: false, reason: 'failed' })
    expect(await broker.convertImageForDisplay('a.heic', 'text')).toEqual({ ok: false, reason: 'failed' })
    expect(await make(undefined).broker.convertImageForDisplay('a.heic', ftyp('heic'))).toEqual({ ok: false, reason: 'failed' })
  })
})
