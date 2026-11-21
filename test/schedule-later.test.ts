/**
 * TODO 989: re-checking the input for "send later", and re-reading the attachments when it is sent.
 */
import { describe, expect, it, vi } from 'vitest'
import { checkLaterInput } from '../src/main/schedule/input.js'
import { resolveLaterAttachments } from '../src/main/schedule/later-attachments.js'
import type { AttachmentResolution } from '../src/shared/thread.js'

const file = { uri: 'file:///tmp/a.txt', name: 'a.txt', kind: 'reference', mediaType: null, bytes: 3 }

describe('checkLaterInput', () => {
  it('本文か添付のどちらかがあればよく、形を検める', () => {
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

describe('resolveLaterAttachments', () => {
  it('file: は送る時に読み直し、落ちた 1 件だけ捨てる。貼り付けの画像は持っている base64 を使う', async () => {
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
