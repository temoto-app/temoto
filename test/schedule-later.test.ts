/**
 * TODO 989: re-checking the input for "send later", and re-reading the attachments when it is sent.
 */
import { describe, expect, it, vi } from 'vitest'
import { MAX_THUMBNAIL_BYTES } from '../src/shared/attachment-thumbnail.js'
import { checkLaterInput } from '../src/main/schedule/input.js'
import { resolveLaterAttachments } from '../src/main/schedule/later-attachments.js'
import type { AttachmentResolution } from '../src/shared/thread.js'

const file = { uri: 'file:///tmp/a.txt', name: 'a.txt', kind: 'reference', mediaType: null, bytes: 3 }

describe('checkLaterInput', () => {
  it('either body or attachments is enough, and the shape is validated', () => {
    expect(checkLaterInput('t1', { text: 'x', attachments: [], at: 1 }).input.text).toBe('x')
    expect(checkLaterInput('t1', { text: '', attachments: [file], at: 1 }).input.attachments).toHaveLength(1)
    expect(() => checkLaterInput('t1', { text: '  ', attachments: [], at: 1 })).toThrow()
    expect(() => checkLaterInput('', { text: 'x', attachments: [], at: 1 })).toThrow()
    expect(() => checkLaterInput('t1', { text: 'x', attachments: [], at: Number.NaN })).toThrow()
    expect(() => checkLaterInput('t1', { text: 'x', attachments: [{ ...file, kind: 'other' }], at: 1 })).toThrow()
    expect(() => checkLaterInput('t1', { text: 'x', attachments: [{ uri: 1 }], at: 1 })).toThrow()
    const kept = checkLaterInput('t1', {
      text: 'x',
      attachments: [{ ...file, thumbnail: 'data:image/webp;base64,AA' }],
      at: 1,
      modelId: null,
      thinking: 'high',
      settingsScope: 'thread',
      junk: 1
    }).input
    expect(kept).toMatchObject({ modelId: null, thinking: 'high', settingsScope: 'thread' })
    expect(kept.attachments[0]?.thumbnail).toBe('data:image/webp;base64,AA')
    expect(() => checkLaterInput('t1', { text: 'x', attachments: [{ ...file, thumbnail: 5 }], at: 1 })).toThrow()
    expect(() => checkLaterInput('t1', { text: 'x'.repeat(20_001), attachments: [], at: 1 })).toThrow()
  })
})

describe('checkLaterInput: the reduced copy (TODO 1325)', () => {
  /** A WebP data URL of exactly `bytes` bytes (the shape check at send time is not run here). */
  const dataUrl = (bytes: number): string => `data:image/webp;base64,${Buffer.alloc(bytes, 1).toString('base64')}`
  const withThumb = (thumbnail: string): unknown => ({
    text: 'x',
    attachments: [{ uri: 'aios-clipboard:1', name: 'p.png', kind: 'image', mediaType: 'image/png', bytes: 3, thumbnail }],
    at: 1
  })

  it('accepts a reduced copy of exactly the byte cap, and refuses one over it', () => {
    expect(checkLaterInput('t1', withThumb(dataUrl(MAX_THUMBNAIL_BYTES))).input.attachments[0]?.thumbnail).toBeDefined()
    expect(() => checkLaterInput('t1', withThumb(dataUrl(MAX_THUMBNAIL_BYTES + 3 * 1024)))).toThrow()
  })
})

describe('resolveLaterAttachments', () => {
  it('file: is re-read at send time, and only the one that failed is dropped; a pasted image uses the base64 it holds', async () => {
    const resolveAttachment = vi.fn(async (_threadId: string, uri: string): Promise<AttachmentResolution> =>
      uri.endsWith('gone.txt')
        ? { ok: false, reason: 'attach-unreadable' }
        : { ok: true, attachment: { uri, name: 'fresh', kind: 'reference', mediaType: null, bytes: 99 }, outsideAllowed: false, keepsThumbnail: false }
    )
    const result = await resolveLaterAttachments({ resolveAttachment }, 't1', [
      { uri: 'file:///tmp/a.txt', name: 'a.txt', kind: 'reference', mediaType: null, bytes: 3 },
      { uri: 'file:///tmp/gone.txt', name: 'gone.txt', kind: 'reference', mediaType: null, bytes: 3 },
      { uri: 'aios-clipboard:1', name: 'p.png', kind: 'image', mediaType: 'image/png', bytes: 4, base64: 'AAAA' }
    ])
    expect(result.map((a) => [a.uri, a.name, a.base64])).toEqual([
      ['file:///tmp/a.txt', 'fresh', undefined],
      ['aios-clipboard:1', 'p.png', 'AAAA']
    ])
    expect(resolveAttachment).toHaveBeenCalledTimes(2)
  })
})
