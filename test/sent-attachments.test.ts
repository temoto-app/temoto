/**
 * TODO 550 (wave 27 bundle F): the form that keeps sent images in the timeline.
 *
 * - An image that points at a file (a place it can be seen) is only the path. Excluded temporary folders and pastes are only a 256 px reduced copy.
 * - The reduced copy comes from the renderer, so its shape, type, magic bytes and size are re-checked in main.
 * - Both the save choke point (`ThreadStore.toPersistable`) and the `user_text` recorded by `SessionManager` are checked.
 *
 * Calls neither the model nor the CLI.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_THUMBNAIL_BYTES,
  SENT_THUMBNAIL_EDGE,
  isValidThumbnail,
  persistableSentAttachments,
  sentAttachmentsOf
} from '../src/main/session/sent-attachments.js'
import { thumbnailSize } from '../src/renderer/src/attachment-thumbnail.js'
import {
  THUMBNAIL_EDGE,
  THUMBNAIL_STEPS,
  thumbnailAttempts
} from '../src/shared/attachment-thumbnail.js'
import type { Attachment } from '../src/shared/thread.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const dataUrl = (type: string, bytes: Buffer): string => `data:image/${type};base64,${bytes.toString('base64')}`

const VALID_THUMBNAIL = dataUrl('webp', WEBP)

describe('isValidThumbnail', () => {
  it('accepts a WebP / PNG / JPEG data URL when the head of the content matches the type', () => {
    expect(isValidThumbnail(dataUrl('webp', WEBP))).toBe(true)
    expect(isValidThumbnail(dataUrl('png', PNG))).toBe(true)
    expect(isValidThumbnail(dataUrl('jpeg', JPEG))).toBe(true)
  })

  it('rejects a mismatch between type and content, other types, non-data URLs and oversized ones', () => {
    expect(isValidThumbnail(dataUrl('png', WEBP))).toBe(false)
    expect(isValidThumbnail(dataUrl('gif', Buffer.from('GIF89a')))).toBe(false)
    expect(isValidThumbnail(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`)).toBe(false)
    expect(isValidThumbnail('aios-res://local/x/y.png')).toBe(false)
    expect(isValidThumbnail(`${dataUrl('png', PNG)}"onerror="x`)).toBe(false)
    expect(isValidThumbnail(42)).toBe(false)
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_THUMBNAIL_BYTES)])
    expect(isValidThumbnail(dataUrl('png', big))).toBe(false)
  })
})

describe('sentAttachmentsOf', () => {
  const image = (uri: string, thumbnail?: string): Attachment => ({
    uri,
    name: uri.split(/[/:]/).pop() ?? uri,
    kind: 'image',
    mediaType: 'image/png',
    base64: 'AAAA',
    bytes: 3,
    ...(thumbnail === undefined ? {} : { thumbnail })
  })
  const viewable = (uri: string): boolean => !uri.includes('/TemporaryItems/')

  it('a viewable file keeps only the path (no thumbnail), while an excluded temp folder and pasted images keep only the thumbnail', () => {
    const result = sentAttachmentsOf(
      [
        image('file:///Users/tester/pics/a.png', VALID_THUMBNAIL),
        image('file:///var/folders/x/TemporaryItems/shot.png', VALID_THUMBNAIL),
        image('aios-clipboard:1', VALID_THUMBNAIL),
        { uri: 'file:///Users/tester/a.ts', name: 'a.ts', kind: 'reference', mediaType: null, bytes: 1 }
      ],
      viewable
    )
    expect(result).toEqual([
      { name: 'a.png', uri: 'file:///Users/tester/pics/a.png' },
      { name: 'shot.png', thumbnail: VALID_THUMBNAIL },
      { name: '1', thumbnail: VALID_THUMBNAIL }
    ])
  })

  it('with no thumbnail or a broken one, only the name is kept', () => {
    expect(sentAttachmentsOf([image('aios-clipboard:2'), image('aios-clipboard:3', 'data:x')], viewable)).toEqual([
      { name: '2' },
      { name: '3' }
    ])
    expect(sentAttachmentsOf(undefined, viewable)).toEqual([])
  })
})

describe('persistableSentAttachments (persistence choke point)', () => {
  it('drops extra fields, non-file: URIs and broken thumbnails, and applies redaction to the name', () => {
    const result = persistableSentAttachments(
      [
        { name: 'a.png', uri: 'file:///a.png', base64: 'ORIGINAL' },
        { name: 'b.png', uri: 'https://example.com/b.png' },
        { name: 'c.png', thumbnail: VALID_THUMBNAIL, extra: 1 },
        { name: 'd.png', thumbnail: 'data:image/png;base64,AAAA' },
        { nope: true },
        'x'
      ],
      (name) => name.toUpperCase()
    )
    expect(result).toEqual([
      { name: 'A.PNG', uri: 'file:///a.png' },
      { name: 'B.PNG' },
      { name: 'C.PNG', thumbnail: VALID_THUMBNAIL },
      { name: 'D.PNG' }
    ])
    expect(persistableSentAttachments(undefined, (n) => n)).toEqual([])
  })
})

describe('thumbnailSize (renderer)', () => {
  it('scales the long side to 1600, keeps the aspect ratio, and does not enlarge small images', () => {
    expect(thumbnailSize(3200, 1600)).toEqual({ width: 1600, height: 800 })
    expect(thumbnailSize(900, 4800)).toEqual({ width: 300, height: 1600 })
    expect(thumbnailSize(1000, 500)).toEqual({ width: 1000, height: 500 })
    expect(thumbnailSize(100, 50)).toEqual({ width: 100, height: 50 })
    expect(thumbnailSize(0, 0)).toEqual({ width: 1600, height: 1600 })
    expect(thumbnailSize(1024, 512, 256)).toEqual({ width: 256, height: 128 })
  })
})

describe('thumbnail limits (TODO 1325)', () => {
  it('renderer and main read the same values from shared', () => {
    expect(THUMBNAIL_EDGE).toBe(1600)
    expect(SENT_THUMBNAIL_EDGE).toBe(THUMBNAIL_EDGE)
    expect(MAX_THUMBNAIL_BYTES).toBe(600 * 1024)
  })

  it('accepts a copy at the byte cap and refuses one byte above it', () => {
    const header = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
    const atCap = Buffer.concat([header, Buffer.alloc(MAX_THUMBNAIL_BYTES - header.length)])
    expect(atCap.length).toBe(MAX_THUMBNAIL_BYTES)
    expect(isValidThumbnail(dataUrl('webp', atCap))).toBe(true)
    expect(isValidThumbnail(dataUrl('webp', Buffer.concat([atCap, Buffer.from([0])])))).toBe(false)
  })

  it('still accepts an old 256 px sized copy', () => {
    expect(isValidThumbnail(dataUrl('webp', Buffer.concat([WEBP, Buffer.alloc(40 * 1024)])))).toBe(true)
  })

  it('steps are ordered from best to smallest and end under the cap of work', () => {
    expect(THUMBNAIL_STEPS[0]).toEqual({ edge: 1600, quality: 0.8 })
    for (let i = 1; i < THUMBNAIL_STEPS.length; i += 1) {
      const prev = THUMBNAIL_STEPS[i - 1]!
      const cur = THUMBNAIL_STEPS[i]!
      expect(cur.edge <= prev.edge && cur.quality <= prev.quality).toBe(true)
    }
  })

  it('attempts for a large image use every step; a small image keeps only lower-quality retries', () => {
    expect(thumbnailAttempts(4000, 3000)).toEqual(THUMBNAIL_STEPS)
    const small = thumbnailAttempts(100, 50)
    expect(small.length).toBeGreaterThanOrEqual(1)
    expect(small[0]).toEqual({ edge: 1600, quality: 0.8 })
    for (let i = 1; i < small.length; i += 1) expect(small[i]!.quality).toBeLessThan(small[i - 1]!.quality)
  })
})
