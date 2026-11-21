/**
 * Item 277 (wave 16 bundle G): `system/api_retry` and `system/vcs_state_changed`.
 * The real ones (CLI 2.1.280, the shape kept in the copy DB's `unknown`) were copied into `test/fixtures/api-retry.jsonl` /
 * `vcs-state-changed.jsonl` (only id and cwd replaced). Neither the model nor the CLI is called.
 *
 * Owner decision (2026-10-01): `api_retry` is shown on the one in-progress line and **is not saved**. `vcs_state_changed` is not shown, and is only the trigger
 * to fetch the BottomBar's git summary again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AiosEvent } from '../src/shared/agent.js'
import { EPHEMERAL_EVENT_KINDS } from '../src/shared/agent.js'
import { parseEvent } from '../src/main/session/adapter/parse.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { nextApiRetry } from '../src/main/session/api-retry.js'
import { apiRetryText } from '../src/renderer/src/thread/progress.js'
import { foldTimeline } from '../src/renderer/src/thread/timeline.js'
import { POKE_DEBOUNCE_MS, useGitStatus } from '../src/renderer/src/gitStatusStore.js'
import { translate } from '../src/renderer/src/i18n/index.js'

let counter = 0
const ctx = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  now: () => 1_700_000_000_000 + counter * 1000,
  newId: () => `e${(counter += 1)}`
}

function fixture(name: string): AiosEvent[] {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => [...parseEvent(line, ctx)])
}

function event(kind: AiosEvent['kind'], payload: unknown): AiosEvent {
  counter += 1
  return {
    id: `x${counter}`,
    sessionId: 'session-1',
    threadId: 'thread-1',
    ts: 1_700_000_000_000 + counter * 1000,
    actor: 'main',
    kind,
    payload
  } as unknown as AiosEvent
}

beforeEach(() => {
  counter = 0
})

describe('parseEvent — api_retry / vcs_state_changed (項目 277)', () => {
  it('実物の api_retry 2 行は「未知のイベント」にならず、error の本文は載らない', () => {
    const events = fixture('api-retry.jsonl')
    expect(events.map((e) => e.kind)).toEqual(['api_retry', 'api_retry'])
    expect(events.map((e) => e.payload)).toEqual([
      { attempt: 4, maxRetries: 10, retryDelayMs: 4812, errorStatus: 529 },
      { attempt: 5, maxRetries: 10, retryDelayMs: 9612, errorStatus: 529 }
    ])
    expect(JSON.stringify(events)).not.toContain('overloaded')
  })

  it('error_status が無い (接続の失敗) は null。欄が崩れた行は生のまま unknown', () => {
    const [ok] = parseEvent(
      JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: 'x' }),
      ctx
    )
    expect(ok?.kind === 'api_retry' && ok.payload.errorStatus).toBeNull()
    const [broken] = parseEvent(JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 'x' }), ctx)
    expect(broken?.kind).toBe('unknown')
  })

  it('実物の vcs_state_changed 2 行 (push / merge)。cwd は載せず、branch は無くてもよい', () => {
    const events = fixture('vcs-state-changed.jsonl')
    expect(events.map((e) => e.kind)).toEqual(['vcs_state_changed', 'vcs_state_changed'])
    expect(events.map((e) => e.payload)).toEqual([{ change: 'push', branch: 'main' }, { change: 'merge' }])
  })

  it('kind の無い vcs_state_changed は unknown (捨てずに残す)', () => {
    const [first] = parseEvent(JSON.stringify({ type: 'system', subtype: 'vcs_state_changed', cwd: '/x' }), ctx)
    expect(first?.kind).toBe('unknown')
  })
})

describe('ThreadStore — 保存しない (項目 277)', () => {
  let db: Db
  let store: ThreadStore
  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    store = new ThreadStore(db, '/Users/tester')
    store.createThread({
      id: 'thread-1',
      title: 't',
      cwd: '/Users/tester/work',
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
  })
  afterEach(() => db.close())

  it('永続化しない種別に入っていて、DB に 1 行も残らない', () => {
    expect(EPHEMERAL_EVENT_KINDS.has('api_retry')).toBe(true)
    expect(EPHEMERAL_EVENT_KINDS.has('vcs_state_changed')).toBe(true)
    const thread = store.getThread('thread-1')!
    store.appendEvents(thread, 'session-1', [...fixture('api-retry.jsonl'), ...fixture('vcs-state-changed.jsonl')])
    const rows = db.prepare('SELECT kind FROM thread_events').all()
    expect(rows).toEqual([])
  })

  it('タイムラインに行を作らない', () => {
    const folded = foldTimeline([...fixture('api-retry.jsonl'), ...fixture('vcs-state-changed.jsonl')])
    expect(folded.items).toEqual([])
  })
})

describe('nextApiRetry — 進行中の控え (項目 277)', () => {
  it('知らせで置き換わり、本文・ツール・結果・エラーで外れる。無関係な種別は触らない', () => {
    const [first, second] = fixture('api-retry.jsonl')
    const a = nextApiRetry(null, first!)
    expect(a).toMatchObject({ attempt: 4, maxRetries: 10, retryDelayMs: 4812, errorStatus: 529 })
    expect(nextApiRetry(a, second!)).toMatchObject({ attempt: 5 })
    expect(nextApiRetry(a, event('hook_run', {}))).toBe(a)
    expect(nextApiRetry(a, event('vcs_state_changed', { change: 'push' }))).toBe(a)
    for (const kind of ['assistant_text', 'assistant_delta', 'thinking_delta', 'tool_use', 'turn_usage', 'result', 'error'] as const) {
      expect(nextApiRetry(a, event(kind, {}))).toBeNull()
    }
    expect(nextApiRetry(null, event('assistant_text', {}))).toBeNull()
  })
})

describe('apiRetryText (項目 277)', () => {
  const base = { attempt: 5, maxRetries: 10, retryDelayMs: 9612, errorStatus: 529 as number | null, at: 0 }
  it('JA: 再試行 5/10 — 9 秒後 (HTTP 529)', () => {
    expect(apiRetryText((k, p) => translate('ja', k, p), base)).toBe('再試行 5/10 — 9 秒後 (HTTP 529)')
  })
  it('EN と、状態コードが無いときは括弧を付けない', () => {
    expect(apiRetryText((k, p) => translate('en', k, p), base)).toBe('Retrying 5/10 — in 9s (HTTP 529)')
    expect(apiRetryText((k, p) => translate('en', k, p), { ...base, errorStatus: null })).toBe('Retrying 5/10 — in 9s')
  })
})

describe('BottomBar の取り直し — vcs_state_changed の合図 (項目 277)', () => {
  const status = vi.fn(async () => null)
  beforeEach(() => {
    vi.useFakeTimers()
    status.mockClear()
    ;(globalThis as unknown as { window: unknown }).window = { aios: { git: { status } } }
    useGitStatus.getState().stop()
    useGitStatus.setState({ cwdUri: null, status: null })
  })
  afterEach(() => {
    useGitStatus.getState().stop()
    vi.useRealTimers()
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('cwd が無ければ何もしない。あれば畳んで 1 回だけ読む', async () => {
    useGitStatus.getState().poke()
    await vi.advanceTimersByTimeAsync(POKE_DEBOUNCE_MS * 2)
    expect(status).not.toHaveBeenCalled()

    useGitStatus.getState().setCwd('file:///Users/tester/work')
    await vi.advanceTimersByTimeAsync(0)
    expect(status).toHaveBeenCalledTimes(1)
    useGitStatus.getState().poke()
    useGitStatus.getState().poke()
    useGitStatus.getState().poke()
    await vi.advanceTimersByTimeAsync(POKE_DEBOUNCE_MS + 10)
    expect(status).toHaveBeenCalledTimes(2)
  })
})
