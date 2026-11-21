/**
 * TODO 489 (wave 25 bundle A): attach the image in an excluded temp folder by its contents -- `src/main/paste/temp-image.ts`.
 *
 * A drag of the ⌘⇧4 thumbnail points to `/var/folders/…/T/TemporaryItems/NSIRD_screencaptureui_<id>/…png`, and the exclusion rules refuse it. Without loosening the rules, only images in the temp folder are read at the moment of the drop.
 * - Judgment of the temp folder (inside the root / an element of `TemporaryItems`), and re-judgment after realpath (so a symlink inside cannot make it read outside)
 * - Whether it is an image is decided by magic bytes (the extension is not looked at); the limit; missing / directory
 * In place of the real temp folder, a test temp folder is passed as the "temp folder root". The model is not called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  defaultTemporaryRoots,
  isTemporaryPath,
  readTemporaryImage,
  sniffImageType
} from '../src/main/paste/temp-image.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
const GIF = Buffer.from('GIF89a......', 'latin1')
const WEBP = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1')
const TIFF = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])

describe('sniffImageType', () => {
  it('tells PNG / JPEG / GIF / WebP apart by the start of the content, and anything else (TIFF, text, empty) is null', () => {
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(JPEG)).toBe('image/jpeg')
    expect(sniffImageType(GIF)).toBe('image/gif')
    expect(sniffImageType(WEBP)).toBe('image/webp')
    expect(sniffImageType(TIFF)).toBeNull()
    expect(sniffImageType(Buffer.from('hello world'))).toBeNull()
    expect(sniffImageType(Buffer.alloc(0))).toBeNull()
  })
})

describe('isTemporaryPath', () => {
  const roots = ['/var/folders', '/private/var/folders', '/tmp', '/private/tmp']
  it('only inside the temp folder root and where TemporaryItems / .TemporaryItems appears along the way', () => {
    expect(isTemporaryPath('/var/folders/24/qr/T/TemporaryItems/NSIRD_screencaptureui_4B/a.png', roots)).toBe(true)
    expect(isTemporaryPath('/private/var/folders/24/qr/T/a.png', roots)).toBe(true)
    expect(isTemporaryPath('/tmp/a.png', roots)).toBe(true)
    expect(isTemporaryPath('/Volumes/USB/.TemporaryItems/folders.501/a.png', roots)).toBe(true)
    expect(isTemporaryPath('/Users/me/.ssh/id_rsa', roots)).toBe(false)
    expect(isTemporaryPath('/var/db/a.png', roots)).toBe(false)
    // Only a similar name / the last element is TemporaryItems
    expect(isTemporaryPath('/tmpfoo/a.png', roots)).toBe(false)
    expect(isTemporaryPath('/Users/me/TemporaryItems', roots)).toBe(false)
  })

  it('the default roots have both the /var and /tmp spellings and the trailing / is dropped', () => {
    const defaults = defaultTemporaryRoots()
    expect(defaults).toEqual(expect.arrayContaining(['/var/folders', '/private/var/folders', '/tmp', '/private/tmp']))
    expect(defaults.every((root) => root === '/' || !root.endsWith('/'))).toBe(true)
  })
})

describe('readTemporaryImage', () => {
  let base: string
  let temp: string
  let outside: string

  beforeEach(() => {
    base = makeTestDir('attach-temp-image')
    temp = join(base, 'T')
    outside = join(base, 'home')
    mkdirSync(join(temp, 'NSIRD_screencaptureui_x'), { recursive: true })
    mkdirSync(outside, { recursive: true })
  })
  afterEach(() => removeTestDir(base))

  const read = (path: string, max = 1024): ReturnType<typeof readTemporaryImage> =>
    readTemporaryImage(path, `file://${path}`, max, [temp])

  it('a PNG in the temp folder is kind: image (type from the content, name is the file name of the logical path)', async () => {
    const path = join(temp, 'NSIRD_screencaptureui_x', 'shot.jpg')
    writeFileSync(path, PNG) // If the extension and the contents differ, the contents win
    expect(await read(path)).toEqual({
      kind: 'resolved',
      resolution: {
        ok: true,
        attachment: {
          uri: `file://${path}`,
          name: 'shot.jpg',
          kind: 'image',
          mediaType: 'image/png',
          base64: PNG.toString('base64'),
          bytes: PNG.length
        },
        outsideAllowed: false,
        keepsThumbnail: true
      }
    })
  })

  it('outside the temp folder is not-temporary (the caller returns the original denial); not read', async () => {
    const path = join(outside, 'a.png')
    writeFileSync(path, PNG)
    expect(await read(path)).toEqual({ kind: 'not-temporary' })
    expect(await read(join(outside, 'missing.png'))).toEqual({ kind: 'not-temporary' })
  })

  it('a symlink inside the temp folder pointing outside is not-temporary (looked at again after realpath)', async () => {
    const secret = join(outside, 'secret.png')
    writeFileSync(secret, PNG)
    const link = join(temp, 'NSIRD_screencaptureui_x', 'link.png')
    symlinkSync(secret, link)
    expect(await read(link)).toEqual({ kind: 'not-temporary' })
  })

  it('a non-image, too large, vanished, or directory gives a reason code', async () => {
    const dir = join(temp, 'NSIRD_screencaptureui_x')
    writeFileSync(join(dir, 'a.png'), 'plain text')
    writeFileSync(join(dir, 'b.tiff'), TIFF)
    writeFileSync(join(dir, 'big.png'), Buffer.concat([PNG, Buffer.alloc(2048)]))
    const reason = async (path: string): Promise<unknown> => {
      const result = await read(path)
      return result.kind === 'resolved' && !result.resolution.ok ? result.resolution.reason : result
    }
    expect(await reason(join(dir, 'a.png'))).toBe('attach-temp-not-image')
    expect(await reason(join(dir, 'b.tiff'))).toBe('attach-temp-not-image')
    expect(await reason(join(dir, 'big.png'))).toBe('attach-too-large')
    expect(await reason(join(dir, 'gone.png'))).toBe('attach-gone')
    expect(await reason(dir)).toBe('attach-directory')
  })

  it('exactly at the limit passes', async () => {
    const path = join(temp, 'exact.png')
    writeFileSync(path, PNG)
    const result = await read(path, PNG.length)
    expect(result.kind === 'resolved' && result.resolution.ok).toBe(true)
  })
})
