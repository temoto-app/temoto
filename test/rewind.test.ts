/**
 * The ThreadStore side of "rewind to here" (item 113, ARCHITECTURE.md 4.5.6).
 * Uses the real encrypted DB code (in memory). Calls neither the model nor the CLI.
 *
 * - migration 16: `threads.fork_origin` is added, and the origin at creation round-trips as JSON.
 *   `Thread.forkedFrom` shown to the renderer does not include the session id or identifiers.
 * - `setEventMessageId`: copies the identifier into the payload of a saved `user_text` (other kinds are not touched).
 * - `rewindPoint`: only a user's message is the starting point. It distinguishes the identifier of the immediately preceding response (text or tool call),
 *   and the case where there is no immediately preceding response at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AiosEvent } from '../src/shared/agent.js'
import type { Thread } from '../src/shared/thread.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { RewindService } from '../src/main/session/rewind.js'

const HOME = '/Users/tester'

let db: Db
let store: ThreadStore
let thread: Thread

beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  store = new ThreadStore(db, HOME)
  thread = store.createThread({
    id: 'thread-1',
    title: '相談',
    cwd: '/Users/tester/work',
    allowedDirs: ['/Users/tester/work'],
    retention: 'forever',
    backend: 'agent-cli',
    modelId: null,
    thinking: null
  })
})

afterEach(() => {
  db.close()
})

let n = 0
function event(kind: AiosEvent['kind'], payload: unknown, id?: string): AiosEvent {
  n += 1
  return {
    id: id ?? `e${n}`,
    sessionId: 'session-1',
    threadId: 'thread-1',
    ts: 1_000 + n,
    actor: 'main',
    kind,
    payload
  } as AiosEvent
}

describe('migration 16 and the origin of a fork', () => {
  it('there is a fork_origin column; a normal thread has forkedFrom null', () => {
    const columns = (db.prepare(`PRAGMA table_info(threads)`).all() as { name: string }[]).map((c) => c.name)
    expect(columns).toContain('fork_origin')
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(16)
    expect(thread.forkedFrom).toBeNull()
    expect(store.forkOriginOf(thread.id)).toBeNull()
  })

  it('the origin at creation round-trips as JSON, and the part shown to the renderer does not include the session id or identifiers', () => {
    const fork = store.createThread({
      id: 'thread-2',
      title: '相談',
      cwd: '/Users/tester/work',
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null,
      forkOrigin: {
        threadId: 'thread-1',
        eventId: 'u-event',
        files: true,
        backendSessionId: 'b-1',
        atMessageId: 'a-9'
      }
    })
    expect(fork.forkedFrom).toEqual({ threadId: 'thread-1', eventId: 'u-event', files: true })
    expect(store.forkOriginOf('thread-2')).toEqual({
      threadId: 'thread-1',
      eventId: 'u-event',
      files: true,
      backendSessionId: 'b-1',
      atMessageId: 'a-9'
    })
    expect(store.getThread('thread-2')?.forkedFrom?.files).toBe(true)
    // A broken JSON falls back to "no origin" (the row can still be read).
    db.prepare(`UPDATE threads SET fork_origin = '{bad' WHERE id = 'thread-2'`).run()
    expect(store.getThread('thread-2')?.forkedFrom).toBeNull()
    expect(store.forkOriginOf('thread-2')).toBeNull()
  })
})

describe('message identifiers and fork points', () => {
  it('setEventMessageId copies only to a saved user_text', () => {
    store.appendEvents(thread, 'session-1', [
      event('user_text', { text: 'q1' }, 'u1'),
      event('assistant_text', { text: 'a1', messageId: 'a-1' }, 'a1')
    ])
    expect(store.setEventMessageId(thread.id, 'u1', 'msg-u1')).toBe(true)
    expect(store.setEventMessageId(thread.id, 'a1', 'nope')).toBe(false)
    expect(store.setEventMessageId(thread.id, 'missing', 'nope')).toBe(false)
    const [u1] = store.readTimeline(thread.id)
    expect(u1?.payload).toEqual({ text: 'q1', messageId: 'msg-u1' })
  })

  it('rewindPoint: returns the identifier of the previous response and also picks up a turn that ends with a tool call', () => {
    store.appendEvents(thread, 'session-1', [
      event('user_text', { text: 'q1', messageId: 'u-1' }, 'u1'),
      event('assistant_text', { text: 'a1', messageId: 'a-1' }, 'a1'),
      event('tool_use', { toolUseId: 't1', name: 'Write', summary: 'x', input: {}, truncated: false, messageId: 'a-2' }, 't1'),
      event('tool_result', { toolUseId: 't1', ok: true, bytes: 1 }, 'r1'),
      event('result', { ok: true, subtype: 'success', turns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, stopReason: null, denials: [], text: null }, 'res1'),
      event('user_text', { text: 'q2', messageId: 'u-2' }, 'u2'),
      event('assistant_text', { text: 'a2' }, 'a3'),
      event('user_text', { text: 'q3' }, 'u3')
    ])
    // The first message: there is no prior response.
    expect(store.rewindPoint(thread.id, 'u1')).toMatchObject({ userMessageId: 'u-1', priorMessageId: null, hasPrior: false, resetAfter: false, priorTs: null })
    // The second: the immediately preceding response ends with a tool call (a-2).
    expect(store.rewindPoint(thread.id, 'u2')).toMatchObject({ userMessageId: 'u-2', priorMessageId: 'a-2', hasPrior: true, resetAfter: false })
    // The third: the preceding response has no identifier (a row from before the support). Its own identifier is also absent.
    expect(store.rewindPoint(thread.id, 'u3')).toMatchObject({ userMessageId: null, priorMessageId: null, hasPrior: true })
    // A row that is not a user's message, and a row of another thread, give null.
    expect(store.rewindPoint(thread.id, 'a1')).toBeNull()
    expect(store.rewindPoint('other', 'u2')).toBeNull()
  })

  it('a subagent response is not a fork point (actor = subagent)', () => {
    store.appendEvents(thread, 'session-1', [
      event('user_text', { text: 'q1', messageId: 'u-1' }, 'u1'),
      event('assistant_text', { text: 'a1', messageId: 'a-1' }, 'a1'),
      { ...event('assistant_text', { text: 'child', messageId: 'c-1' }, 'c1'), actor: 'subagent', parentToolUseId: 'tp' } as AiosEvent,
      event('user_text', { text: 'q2', messageId: 'u-2' }, 'u2')
    ])
    expect(store.rewindPoint(thread.id, 'u2')?.priorMessageId).toBe('a-1')
  })
})

describe('TODO 1121: fork points across a conversation reset (/clear)', () => {
  /**
   * Session A: q1 → a1 → q2 → a2 → /clear → (session B) q3 → a3 → q4.
   * B's `session_started` comes after q3 (the CLI does not emit init until a user's line arrives), so B's start time is between q3 and a3.
   */
  function seed(): { tsOf: (id: string) => number } {
    const events = [
      event('user_text', { text: 'q1', messageId: 'u-1' }, 'u1'),
      event('assistant_text', { text: 'a1', messageId: 'a-1' }, 'a1'),
      event('user_text', { text: 'q2', messageId: 'u-2' }, 'u2'),
      event('assistant_text', { text: 'a2', messageId: 'a-2' }, 'a2'),
      event('conversation_reset', {}, 'reset'),
      event('user_text', { text: 'q3', messageId: 'u-3' }, 'u3'),
      event('assistant_text', { text: 'a3', messageId: 'a-3' }, 'a3'),
      event('user_text', { text: 'q4', messageId: 'u-4' }, 'u4')
    ]
    store.appendEvents(thread, 'session-1', events)
    const tsOf = (id: string): number => events.find((e) => e.id === id)!.ts
    store.recordSession({ id: 's-a', threadId: thread.id, backendSessionId: 'b-A', forkedFrom: null, backendVersion: null })
    store.recordSession({ id: 's-b', threadId: thread.id, backendSessionId: 'b-B', forkedFrom: null, backendVersion: null })
    const setStarted = db.prepare(`UPDATE sessions SET started_at = ? WHERE backend_session_id = ?`)
    setStarted.run(tsOf('u1') - 1, 'b-A')
    setStarted.run(tsOf('u3') + 0.5, 'b-B')
    return { tsOf }
  }

  function service(): { rewind: RewindService; rewindFiles: ReturnType<typeof vi.fn> } {
    const rewindFiles = vi.fn(async () => ({ canRewind: true, filesChanged: [], insertions: 0, deletions: 0 }))
    const rewind = new RewindService({
      store,
      isRewindable: () => true,
      adapterSupportsRewind: () => true,
      rewindFiles,
      emitThreads: () => undefined
    })
    return { rewind, rewindFiles }
  }

  it('rewindPoint: a message before the reset is resetAfter, and a message right after the reset is "no previous response"', () => {
    const { tsOf } = seed()
    expect(store.rewindPoint(thread.id, 'u2')).toEqual({
      userMessageId: 'u-2',
      priorMessageId: 'a-1',
      hasPrior: true,
      resetAfter: true,
      priorTs: tsOf('a1'),
      priorSeq: 2
    })
    expect(store.rewindPoint(thread.id, 'u3')).toEqual({
      userMessageId: 'u-3',
      priorMessageId: null,
      hasPrior: false,
      resetAfter: false,
      priorTs: null,
      priorSeq: null
    })
    expect(store.rewindPoint(thread.id, 'u4')).toMatchObject({ priorMessageId: 'a-3', hasPrior: true, resetAfter: false })
    expect(store.backendSessionAt(thread.id, tsOf('a1'))).toBe('b-A')
    expect(store.backendSessionAt(thread.id, tsOf('a3'))).toBe('b-B')
    expect(store.backendSessionAt(thread.id, 0)).toBeNull()
  })

  it('a fork from a message before the reset starts from the pair of the session at that time and the old response (not mixed with the latest session)', async () => {
    seed()
    const { rewind } = service()
    await rewind.rewind(thread.id, 'u2', { files: false })
    const forks = store.listThreads().filter((t) => t.id !== thread.id)
    expect(forks).toHaveLength(1)
    expect(store.forkOriginOf(forks[0]!.id)).toMatchObject({ backendSessionId: 'b-A', atMessageId: 'a-1' })
  })

  it('a fork from the first message right after the reset starts from empty; a message after the reset is the latest session as before', async () => {
    seed()
    const { rewind } = service()
    const empty = await rewind.rewind(thread.id, 'u3', { files: false })
    expect(store.forkOriginOf(empty.id)).toMatchObject({ backendSessionId: null, atMessageId: null })
    const latest = await rewind.rewind(thread.id, 'u4', { files: false })
    expect(store.forkOriginOf(latest.id)).toMatchObject({ backendSessionId: 'b-B', atMessageId: 'a-3' })
  })

  it('does not restore files of a message before the reset (the preview gives a reason code, the commit is refused); if the session cannot be found, the fork is also refused', async () => {
    seed()
    const { rewind, rewindFiles } = service()
    expect((await rewind.rewindPreview(thread.id, 'u2')).reason).toBe('aios-reason:rewind-no-checkpoint')
    await expect(rewind.rewind(thread.id, 'u2', { files: true })).rejects.toThrow('aios-reason:rewind-no-checkpoint')
    expect(rewindFiles).not.toHaveBeenCalled()
    // The files of a message after a reset can be rewound in the current session.
    expect((await rewind.rewindPreview(thread.id, 'u4')).canRewind).toBe(true)
    expect(rewindFiles).toHaveBeenCalledWith(expect.anything(), 'u-4', true)
    // If there is no row for the session at that time (it is gone), refuse without passing an old identifier to the latest session.
    db.prepare(`DELETE FROM sessions WHERE backend_session_id = 'b-A'`).run()
    await expect(rewind.rewind(thread.id, 'u2', { files: false })).rejects.toThrow('aios-reason:rewind-no-branch-point')
  })
})

describe('review of TODO 1121: the source session of a fork is looked up in record order (a conversation continued from a transcript)', () => {
  /**
   * Shape of a conversation continued from a transcript (`transcript_origin`): a row's `ts` is older than the `started_at` of its session row (the import's ts).
   * Looking up by time found nothing, so it refused with `rewind-no-branch-point`.
   * Order: (response a0) → q1 → [session X starts] → a1 → q2 → a2 → /clear → q3 → [session Y starts] → a3 → q4.
   */
  function sessionStarted(id: string, backendSessionId: string): AiosEvent {
    return event(
      'session_started',
      { backendSessionId, backendVersion: null, model: null, cwd: null, reportedPermissionMode: null, tools: [] },
      id
    )
  }

  function seed(): void {
    thread = store.createThread({
      id: 'thread-t',
      title: '続き',
      cwd: '/Users/tester/work',
      allowedDirs: ['/Users/tester/work'],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null,
      transcriptOrigin: { sessionId: 'b-X', fileId: 'f-1', limit: 10, fork: false }
    })
    store.appendEvents(thread, 'session-1', [
      event('assistant_text', { text: 'a0', messageId: 'a-0' }, 't-a0'),
      event('user_text', { text: 'q1', messageId: 'u-1' }, 't-u1'),
      sessionStarted('t-sx', 'b-X'),
      event('assistant_text', { text: 'a1', messageId: 'a-1' }, 't-a1'),
      event('user_text', { text: 'q2', messageId: 'u-2' }, 't-u2'),
      event('assistant_text', { text: 'a2', messageId: 'a-2' }, 't-a2'),
      event('conversation_reset', {}, 't-reset'),
      event('user_text', { text: 'q3', messageId: 'u-3' }, 't-u3'),
      sessionStarted('t-sy', 'b-Y'),
      event('assistant_text', { text: 'a3', messageId: 'a-3' }, 't-a3'),
      event('user_text', { text: 'q4', messageId: 'u-4' }, 't-u4')
    ])
    store.recordSession({ id: 's-x', threadId: thread.id, backendSessionId: 'b-X', forkedFrom: null, backendVersion: null })
    store.recordSession({ id: 's-y', threadId: thread.id, backendSessionId: 'b-Y', forkedFrom: null, backendVersion: null })
    // Both rows are made to have started after the ts of the imported rows (they cannot be looked up by time).
    db.prepare(`UPDATE sessions SET started_at = ? WHERE thread_id = ?`).run(10_000_000, thread.id)
  }

  function service(): RewindService {
    return new RewindService({
      store,
      isRewindable: () => true,
      adapterSupportsRewind: () => true,
      rewindFiles: vi.fn(async () => ({ canRewind: true, filesChanged: [], insertions: 0, deletions: 0 })),
      emitThreads: () => undefined
    })
  }

  it('a fork from a message before the reset pairs with the last session start before the response (X)', async () => {
    seed()
    const point = store.rewindPoint(thread.id, 't-u2')
    expect(point).toMatchObject({ priorMessageId: 'a-1', resetAfter: true })
    // Looking up by the earlier time finds nothing.
    expect(store.backendSessionAt(thread.id, point!.priorTs!)).toBeNull()
    const fork = await service().rewind(thread.id, 't-u2', { files: false })
    expect(store.forkOriginOf(fork.id)).toMatchObject({ backendSessionId: 'b-X', atMessageId: 'a-1' })
  })

  it('a response before any session start pairs with the next session (X) that has no reset in between', async () => {
    seed()
    expect(store.rewindPoint(thread.id, 't-u1')).toMatchObject({ priorMessageId: 'a-0', resetAfter: true })
    const fork = await service().rewind(thread.id, 't-u1', { files: false })
    expect(store.forkOriginOf(fork.id)).toMatchObject({ backendSessionId: 'b-X', atMessageId: 'a-0' })
  })

  it('if the session row looked up in record order is missing (deleted), it refuses without shifting to another session', async () => {
    seed()
    db.prepare(`DELETE FROM sessions WHERE backend_session_id = 'b-X'`).run()
    await expect(service().rewind(thread.id, 't-u2', { files: false })).rejects.toThrow('aios-reason:rewind-no-branch-point')
    await expect(service().rewind(thread.id, 't-u1', { files: false })).rejects.toThrow('aios-reason:rewind-no-branch-point')
  })

  it('if there is a reset between it and the next session start, that response is not in the next session, so it refuses', () => {
    seed()
    // If X's start row is missing, the first session start after a2 (before the reset) is Y. There is a reset in between, so they are not paired.
    db.prepare(`DELETE FROM thread_events WHERE id = 't-sx'`).run()
    const a2Seq = (db.prepare(`SELECT seq FROM thread_events WHERE id = 't-a2'`).get() as { seq: number }).seq
    expect(store.backendSessionOfResponse(thread.id, a2Seq, 0)).toBeNull()
    // The response after the reset (a3) pairs with the earlier Y.
    const a3Seq = (db.prepare(`SELECT seq FROM thread_events WHERE id = 't-a3'`).get() as { seq: number }).seq
    expect(store.backendSessionOfResponse(thread.id, a3Seq, 0)).toBe('b-Y')
  })
})

