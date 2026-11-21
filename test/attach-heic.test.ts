/**
 * TODO 1173: a HEIC / HEIF attached to the Prompt is converted to JPEG with `sips` and put into the body (`mediaType: image/jpeg`).
 * `sips` is replaced with a fake (the real one is not called). The model is not called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentService, MAX_ATTACHMENT_BYTES, type AttachmentImageConverter } from '../src/main/session/attachments.js'
import { ATTACHMENT_MAX_PIXELS, convertFileForAttachment, type SipsRunner } from '../src/main/image/display.js'
import type { Thread } from '../src/shared/thread.js'
import { REASON_CODES } from '../src/shared/reason.js'
import { en } from '../src/renderer/src/i18n/en.js'
import { ja } from '../src/renderer/src/i18n/ja.js'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aios-attach-heic-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function service(convert: AttachmentImageConverter): AttachmentService {
  const thread = { id: 't1', cwdUri: `file://${dir}`, allowedDirUris: [] } as unknown as Thread
  const host = {
    store: { getThread: (id: string) => (id === 't1' ? thread : null) },
    fs: { assertAllowed: (uri: string) => decodeURIComponent(new URL(uri).pathname) },
    workingCwdOf: () => dir
  } as unknown as ConstructorParameters<typeof AttachmentService>[0]
  return new AttachmentService(host, convert)
}

describe('resolveAttachment for HEIC (TODO 1173)', () => {
  it('.heic returns the converted JPEG as kind: image / image/jpeg; the name is the original file name', async () => {
    const path = join(dir, 'IMG_0001.HEIC')
    writeFileSync(path, 'heic-bytes')
    const calls: string[] = []
    const result = await service(async (p) => {
      calls.push(p)
      return { ok: true, bytes: new Uint8Array(JPEG), contentType: 'image/jpeg' }
    }).resolveAttachment('t1', `file://${path}`)
    expect(calls).toEqual([path])
    expect(result).toEqual({
      ok: true,
      attachment: {
        uri: `file://${path}`,
        name: 'IMG_0001.HEIC',
        kind: 'image',
        mediaType: 'image/jpeg',
        base64: JPEG.toString('base64'),
        bytes: JPEG.length
      },
      outsideAllowed: false,
      keepsThumbnail: false
    })
  })

  it('.heif is converted too; PNG / JPEG are not converted', async () => {
    writeFileSync(join(dir, 'a.heif'), 'x')
    writeFileSync(join(dir, 'b.png'), 'png')
    const calls: string[] = []
    const svc = service(async (p) => {
      calls.push(p)
      return { ok: true, bytes: new Uint8Array(JPEG), contentType: 'image/jpeg' }
    })
    const heif = await svc.resolveAttachment('t1', `file://${join(dir, 'a.heif')}`)
    expect(heif.ok && heif.attachment.mediaType).toBe('image/jpeg')
    const png = await svc.resolveAttachment('t1', `file://${join(dir, 'b.png')}`)
    expect(png.ok && png.attachment.mediaType).toBe('image/png')
    expect(calls).toEqual([join(dir, 'a.heif')])
  })

  it('an environment without sips is attach-heic-unsupported, a conversion failure is attach-heic-failed, and too large is attach-too-large', async () => {
    const path = join(dir, 'p.heic')
    writeFileSync(path, 'x')
    const uri = `file://${path}`
    expect(await service(async () => ({ ok: false, reason: 'unsupported-platform' })).resolveAttachment('t1', uri)).toEqual({
      ok: false,
      reason: 'attach-heic-unsupported'
    })
    expect(await service(async () => ({ ok: false, reason: 'failed' })).resolveAttachment('t1', uri)).toEqual({
      ok: false,
      reason: 'attach-heic-failed'
    })
    expect(await service(async () => ({ ok: false, reason: 'too-large' })).resolveAttachment('t1', uri)).toEqual({
      ok: false,
      reason: 'attach-too-large'
    })
    // The converted size exceeds the attachment limit (8 MB): a path reference to HEIC is refused, since the model cannot read it.
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1)
    expect(
      await service(async () => ({ ok: true, bytes: big, contentType: 'image/jpeg' })).resolveAttachment('t1', uri)
    ).toEqual({ ok: false, reason: 'attach-too-large' })
  })

  it('the reason codes are in the table and have EN / JA sentences', () => {
    for (const code of ['attach-heic-unsupported', 'attach-heic-failed']) {
      expect(REASON_CODES).toContain(code)
      expect(en[`reason.${code}` as keyof typeof en]).toBeTruthy()
      expect(ja[`reason.${code}` as keyof typeof ja]).toBeTruthy()
    }
  })
})

describe('convertFileForAttachment (sips replaced)', () => {
  const fakeSips =
    (calls: string[][]): SipsRunner =>
    async (args) => {
      calls.push([...args])
      writeFileSync(args[args.length - 1] ?? '', JPEG)
      return true
    }

  it('converts with the same fixed flags as display and leaves no temporary directory', async () => {
    const temp = join(dir, 'temp')
    mkdirSync(temp)
    const path = join(dir, 'IMG.heic')
    writeFileSync(path, 'heic')
    const calls: string[][] = []
    const result = await convertFileForAttachment(path, { platform: 'darwin', tempDir: temp, run: fakeSips(calls) })
    expect(result.ok && [...result.bytes]).toEqual([...JPEG])
    expect(calls[0]?.slice(0, 3)).toEqual(['-s', 'format', 'jpeg'])
    expect(readdirSync(temp)).toEqual([])
    // The original file is not changed.
    expect(readFileSync(path, 'utf8')).toBe('heic')
  })

  it('wave 75 review: if the plain conversion exceeds the limit, shrinks once with -Z (a fixed pixel count) and converts again; without a limit it does not shrink', async () => {
    const temp = join(dir, 'temp')
    mkdirSync(temp)
    const path = join(dir, 'IMG_48MP.heic')
    writeFileSync(path, 'heic')
    const small = Buffer.concat([JPEG, Buffer.from('small')])
    // A fake sips: a plain conversion gives a size over the limit, and one with -Z writes a small JPEG.
    const calls: string[][] = []
    const sips: SipsRunner = async (args) => {
      calls.push([...args])
      writeFileSync(args[args.length - 1] ?? '', args.includes('-Z') ? small : Buffer.alloc(2_000, 1))
      return true
    }
    const shrunk = await convertFileForAttachment(path, { platform: 'darwin', tempDir: temp, run: sips, shrinkAboveBytes: 1_000 })
    expect(shrunk.ok && [...shrunk.bytes]).toEqual([...small])
    expect(calls).toHaveLength(2)
    expect(calls[0]).not.toContain('-Z')
    expect(calls[1]?.slice(0, 5)).toEqual(['-s', 'format', 'jpeg', '-Z', String(ATTACHMENT_MAX_PIXELS)])
    // Even when shrunk, the input is the same temp file (the original file is not reopened).
    expect(calls[1]?.[5]).toBe(calls[0]?.[3])
    expect(readdirSync(temp)).toEqual([])

    // If at or under the limit, only once. If the limit is not passed (the same as the display conversion), a large file is not shrunk.
    calls.length = 0
    const plain = await convertFileForAttachment(path, { platform: 'darwin', tempDir: temp, run: sips, shrinkAboveBytes: 10_000 })
    expect(plain.ok && plain.bytes.byteLength).toBe(2_000)
    expect(calls).toHaveLength(1)
    calls.length = 0
    const display = await convertFileForAttachment(path, { platform: 'darwin', tempDir: temp, run: sips })
    expect(display.ok && display.bytes.byteLength).toBe(2_000)
    expect(calls).toHaveLength(1)
  })

  it('wave 75 review: failed if the shrinking conversion fails', async () => {
    const temp = join(dir, 'temp')
    mkdirSync(temp)
    const path = join(dir, 'IMG.heic')
    writeFileSync(path, 'heic')
    const sips: SipsRunner = async (args) => {
      if (args.includes('-Z')) return false
      writeFileSync(args[args.length - 1] ?? '', Buffer.alloc(2_000, 1))
      return true
    }
    expect(await convertFileForAttachment(path, { platform: 'darwin', tempDir: temp, run: sips, shrinkAboveBytes: 1_000 })).toEqual({
      ok: false,
      reason: 'failed'
    })
    expect(readdirSync(temp)).toEqual([])
  })

  it('unsupported-platform without opening on anything other than darwin', async () => {
    const calls: string[][] = []
    const result = await convertFileForAttachment(join(dir, 'missing.heic'), {
      platform: 'win32',
      tempDir: dir,
      run: fakeSips(calls)
    })
    expect(result).toEqual({ ok: false, reason: 'unsupported-platform' })
    expect(calls).toEqual([])
  })

  it('a missing file or a directory is failed; a symlink converts the real file', async () => {
    const temp = join(dir, 'temp')
    mkdirSync(temp)
    const calls: string[][] = []
    const deps = { platform: 'darwin' as const, tempDir: temp, run: fakeSips(calls) }
    expect(await convertFileForAttachment(join(dir, 'missing.heic'), deps)).toEqual({ ok: false, reason: 'failed' })
    mkdirSync(join(dir, 'folder.heic'))
    expect(await convertFileForAttachment(join(dir, 'folder.heic'), deps)).toEqual({ ok: false, reason: 'failed' })
    expect(calls).toEqual([])
    writeFileSync(join(dir, 'real.heic'), 'heic')
    symlinkSync(join(dir, 'real.heic'), join(dir, 'link.heic'))
    const linked = await convertFileForAttachment(join(dir, 'link.heic'), deps)
    expect(linked.ok).toBe(true)
  })
})
