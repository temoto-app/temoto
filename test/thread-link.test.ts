/**
 * The `thread://<threadId>/<eventId>` link (TODO 1155, ARCHITECTURE.md 5.1.1).
 *
 * - `parseThreadLink` / `threadLinkOf`: reading and writing the shape (the renderer's routing and main's re-check both use the same `isThreadLinkId`)
 * - `threadLinkStep`: what the renderer does with the location main returned (jump / just open / a banner for a deleted item / not found)
 * - `ThreadStore.locateThreadLink`: deciding the location (the real SQLite, in memory)
 * - `SessionManager.locateThreadLink`: main re-checks the shape of an id that came from the renderer (`isThreadLinkId`, item 86)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AiosEvent } from '../src/shared/agent.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { SessionManager } from '../src/main/session/manager.js'
import {
  isThreadLinkId,
  parseThreadLink,
  threadLinkOf,
  threadLinkStep
} from '../src/shared/thread-link.js'
import { REASON_CODES } from '../src/shared/reason.js'

const THREAD = '0b6f9a52-3c1e-4d7a-9f00-1a2b3c4d5e6f'
const EVENT = '7d1e2f30-4a5b-4c6d-8e9f-a0b1c2d3e4f5'

describe('parseThreadLink / threadLinkOf (TODO 1155)', () => {
  it('parses thread://<threadId>/<eventId>', () => {
    expect(parseThreadLink(`thread://${THREAD}/${EVENT}`)).toEqual({ threadId: THREAD, eventId: EVENT })
  })

  it('a link without a message points at the thread only', () => {
    expect(parseThreadLink(`thread://${THREAD}`)).toEqual({ threadId: THREAD, eventId: null })
    expect(parseThreadLink(`thread://${THREAD}/`)).toEqual({ threadId: THREAD, eventId: null })
  })

  it('allows surrounding whitespace, an uppercase scheme, % encoding, and a trailing ? / #', () => {
    expect(parseThreadLink(`  THREAD://${THREAD}/${EVENT}  `)).toEqual({ threadId: THREAD, eventId: EVENT })
    expect(parseThreadLink(`thread://${THREAD}/a%3Ab`)).toEqual({ threadId: THREAD, eventId: 'a:b' })
    expect(parseThreadLink(`thread://${THREAD}/${EVENT}?x=1#y`)).toEqual({ threadId: THREAD, eventId: EVENT })
  })

  it('returns null for a wrong shape (wrong scheme, empty, too many segments, not an id shape, broken %)', () => {
    for (const href of [
      null,
      undefined,
      '',
      'thread://',
      'thread:///x',
      `file://${THREAD}`,
      `https://example.com/${THREAD}`,
      `thread://${THREAD}/${EVENT}/extra`,
      'thread://../etc',
      'thread://a b/c',
      'thread://%E0%A4%A/x',
      `thread://${'a'.repeat(201)}`
    ]) {
      expect(parseThreadLink(href)).toBeNull()
    }
  })

  it('threadLinkOf is the inverse of parseThreadLink', () => {
    expect(parseThreadLink(threadLinkOf(THREAD, EVENT))).toEqual({ threadId: THREAD, eventId: EVENT })
    expect(threadLinkOf(THREAD)).toBe(`thread://${THREAD}`)
  })

  it('isThreadLinkId is a string of only alphanumerics and ._:-, up to 200 characters', () => {
    expect(isThreadLinkId(THREAD)).toBe(true)
    expect(isThreadLinkId('a.b_c:d-e')).toBe(true)
    expect(isThreadLinkId(42)).toBe(false)
    expect(isThreadLinkId('')).toBe(false)
    expect(isThreadLinkId('-x')).toBe(false)
    expect(isThreadLinkId('a/b')).toBe(false)
    expect(isThreadLinkId('a'.repeat(200))).toBe(true)
    expect(isThreadLinkId('a'.repeat(201))).toBe(false)
  })

  // That a `thread://` href remains in an answer's Markdown is checked by 'file: and thread: are kept' in test/markdown.test.ts.
})

describe('threadLinkStep (TODO 1155)', () => {
  const target = { threadId: THREAD, eventId: EVENT }

  it('jumps when the message exists (same jumpToEvent as conversation search ⌘K)', () => {
    expect(threadLinkStep(target, 'live')).toEqual({ kind: 'jump', threadId: THREAD, eventId: EVENT })
  })

  it('a link that does not point at a message only opens the thread', () => {
    expect(threadLinkStep({ threadId: THREAD, eventId: null }, 'live')).toEqual({
      kind: 'open',
      threadId: THREAD,
      reason: null
    })
  })

  it('opens only the conversation and shows the reason when there is no message', () => {
    expect(threadLinkStep(target, 'live-no-event')).toEqual({
      kind: 'open',
      threadId: THREAD,
      reason: 'thread-link-event-not-found'
    })
  })

  it('a deleted one shows the 「元に戻して開く」 band, and not found otherwise', () => {
    expect(threadLinkStep(target, 'deleted')).toEqual({ kind: 'deleted', target })
    expect(threadLinkStep(target, 'missing')).toEqual({ kind: 'missing' })
  })

  it('every reason in the band is a reason code (the renderer dictionary has the text, which i18n.test checks)', () => {
    for (const code of ['thread-link-deleted', 'thread-link-not-found', 'thread-link-event-not-found']) {
      expect(REASON_CODES as readonly string[]).toContain(code)
    }
  })
})

describe('ThreadStore.locateThreadLink (TODO 1155)', () => {
  let db: Db
  let store: ThreadStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    store = new ThreadStore(db, '/Users/tester')
  })

  afterEach(() => {
    db.close()
  })

  function thread(id: string): ReturnType<ThreadStore['createThread']> {
    return store.createThread({
      id,
      title: 't',
      cwd: '/Users/tester/work',
      allowedDirs: [],
      retention: 'forever',
      backend: 'fake',
      modelId: null,
      thinking: null
    })
  }

  function say(threadId: string, eventId: string): void {
    const record = store.getThread(threadId)
    if (record === null) throw new Error('no thread')
    const event = {
      id: eventId,
      sessionId: 's',
      threadId,
      ts: Date.now(),
      actor: 'main',
      kind: 'user_text',
      payload: { text: 'こんにちは' }
    } as AiosEvent
    store.appendEvents(record, null, [event])
  }

  it('an existing message of an existing thread is live, and a thread-only link is live too', () => {
    thread(THREAD)
    say(THREAD, EVENT)
    expect(store.locateThreadLink(THREAD, EVENT)).toBe('live')
    expect(store.locateThreadLink(THREAD, null)).toBe('live')
  })

  it('live-no-event when there is no message or the message belongs to another thread', () => {
    thread(THREAD)
    thread('other')
    say('other', EVENT)
    expect(store.locateThreadLink(THREAD, EVENT)).toBe('live-no-event')
    expect(store.locateThreadLink(THREAD, 'nope')).toBe('live-no-event')
  })

  it('a soft-deleted thread is deleted, and live again once restored', () => {
    thread(THREAD)
    say(THREAD, EVENT)
    expect(store.removeThread(THREAD)).toBe(true)
    expect(store.locateThreadLink(THREAD, EVENT)).toBe('deleted')
    expect(store.restoreThread(THREAD)).toBe(true)
    expect(store.locateThreadLink(THREAD, EVENT)).toBe('live')
  })

  it('a nonexistent thread is missing', () => {
    expect(store.locateThreadLink('missing', EVENT)).toBe('missing')
  })
})

describe('re-validation at the entrance of SessionManager.locateThreadLink (TODO 1155, item 86)', () => {
  // The judgment itself is in ThreadStore (above). Here only the main side's re-check of the shape of a value from the renderer is checked (SessionManager is not built; it is called with a `this` that holds only `store`).
  const seen: [string, string | null][] = []
  const self = {
    store: {
      locateThreadLink: (threadId: string, eventId: string | null) => {
        seen.push([threadId, eventId])
        return 'live'
      }
    }
  }
  const locate = (threadId: unknown, eventId: unknown): unknown =>
    SessionManager.prototype.locateThreadLink.call(self as unknown as SessionManager, threadId, eventId)

  it('passes a well-formed id to the store (null for a link without a message)', () => {
    seen.length = 0
    expect(locate(THREAD, EVENT)).toBe('live')
    expect(locate(THREAD, null)).toBe('live')
    expect(seen).toEqual([
      [THREAD, EVENT],
      [THREAD, null]
    ])
  })

  it('rejects a malformed value with invalid-value and does not pass it to the store', () => {
    seen.length = 0
    expect(() => locate('../x', EVENT)).toThrow(/invalid-value/)
    expect(() => locate(42, EVENT)).toThrow(/invalid-value/)
    expect(() => locate(THREAD, 'a/b')).toThrow(/invalid-value/)
    expect(() => locate(THREAD, undefined)).toThrow(/invalid-value/)
    expect(seen).toEqual([])
  })
})
