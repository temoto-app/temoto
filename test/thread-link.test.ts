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
  it('thread://<threadId>/<eventId> を読む', () => {
    expect(parseThreadLink(`thread://${THREAD}/${EVENT}`)).toEqual({ threadId: THREAD, eventId: EVENT })
  })

  it('発言の無いリンクはスレッドだけ', () => {
    expect(parseThreadLink(`thread://${THREAD}`)).toEqual({ threadId: THREAD, eventId: null })
    expect(parseThreadLink(`thread://${THREAD}/`)).toEqual({ threadId: THREAD, eventId: null })
  })

  it('前後の空白・大文字のスキーム・% の符号化・末尾の ? / # を許す', () => {
    expect(parseThreadLink(`  THREAD://${THREAD}/${EVENT}  `)).toEqual({ threadId: THREAD, eventId: EVENT })
    expect(parseThreadLink(`thread://${THREAD}/a%3Ab`)).toEqual({ threadId: THREAD, eventId: 'a:b' })
    expect(parseThreadLink(`thread://${THREAD}/${EVENT}?x=1#y`)).toEqual({ threadId: THREAD, eventId: EVENT })
  })

  it('形が違えば null (スキーム違い・空・段が多い・id の形でない・壊れた %)', () => {
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

  it('threadLinkOf は parseThreadLink の逆', () => {
    expect(parseThreadLink(threadLinkOf(THREAD, EVENT))).toEqual({ threadId: THREAD, eventId: EVENT })
    expect(threadLinkOf(THREAD)).toBe(`thread://${THREAD}`)
  })

  it('isThreadLinkId は文字列で、英数字と ._:- だけ、200 字まで', () => {
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

  it('在る発言なら飛ぶ (会話の検索 ⌘K と同じ jumpToEvent)', () => {
    expect(threadLinkStep(target, 'live')).toEqual({ kind: 'jump', threadId: THREAD, eventId: EVENT })
  })

  it('発言を指さないリンクはスレッドを開くだけ', () => {
    expect(threadLinkStep({ threadId: THREAD, eventId: null }, 'live')).toEqual({
      kind: 'open',
      threadId: THREAD,
      reason: null
    })
  })

  it('発言が無ければ会話だけを開いて理由を出す', () => {
    expect(threadLinkStep(target, 'live-no-event')).toEqual({
      kind: 'open',
      threadId: THREAD,
      reason: 'thread-link-event-not-found'
    })
  })

  it('削除済みは「元に戻して開く」の帯、無ければ見つからない', () => {
    expect(threadLinkStep(target, 'deleted')).toEqual({ kind: 'deleted', target })
    expect(threadLinkStep(target, 'missing')).toEqual({ kind: 'missing' })
  })

  it('帯の理由はどれも理由コード (renderer の辞書に文言がある — i18n.test が検査)', () => {
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

  it('在るスレッドの在る発言は live、スレッドだけのリンクも live', () => {
    thread(THREAD)
    say(THREAD, EVENT)
    expect(store.locateThreadLink(THREAD, EVENT)).toBe('live')
    expect(store.locateThreadLink(THREAD, null)).toBe('live')
  })

  it('発言が無い・別のスレッドの発言なら live-no-event', () => {
    thread(THREAD)
    thread('other')
    say('other', EVENT)
    expect(store.locateThreadLink(THREAD, EVENT)).toBe('live-no-event')
    expect(store.locateThreadLink(THREAD, 'nope')).toBe('live-no-event')
  })

  it('論理削除したスレッドは deleted、元に戻せば live', () => {
    thread(THREAD)
    say(THREAD, EVENT)
    expect(store.removeThread(THREAD)).toBe(true)
    expect(store.locateThreadLink(THREAD, EVENT)).toBe('deleted')
    expect(store.restoreThread(THREAD)).toBe(true)
    expect(store.locateThreadLink(THREAD, EVENT)).toBe('live')
  })

  it('無いスレッドは missing', () => {
    expect(store.locateThreadLink('missing', EVENT)).toBe('missing')
  })
})

describe('SessionManager.locateThreadLink の入口の再検証 (TODO 1155、項目 86)', () => {
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

  it('形の正しい id は store に渡す (発言の無いリンクは null)', () => {
    seen.length = 0
    expect(locate(THREAD, EVENT)).toBe('live')
    expect(locate(THREAD, null)).toBe('live')
    expect(seen).toEqual([
      [THREAD, EVENT],
      [THREAD, null]
    ])
  })

  it('形の違う値は invalid-value で断り、store に渡さない', () => {
    seen.length = 0
    expect(() => locate('../x', EVENT)).toThrow(/invalid-value/)
    expect(() => locate(42, EVENT)).toThrow(/invalid-value/)
    expect(() => locate(THREAD, 'a/b')).toThrow(/invalid-value/)
    expect(() => locate(THREAD, undefined)).toThrow(/invalid-value/)
    expect(seen).toEqual([])
  })
})
