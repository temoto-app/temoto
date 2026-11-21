/**
 * How the renderer holds the event sequence (item 88 / REVIEW D-1, `src/renderer/src/thread-events.ts`). Pure functions.
 *
 * What is guarded:
 * - When a confirmed version (`user_text` / `assistant_text` / `tool_use` / `result`) arrives, the deltas before it are discarded.
 * - **Even when discarded, the result of rendering (`foldTimeline`) is not changed by a single byte.** A fixture (one real turn from CLI 2.1.207) and a synthetic multi-turn sequence are fed one at a time, all together, and in mixed batches, and compared.
 * - If nothing can be discarded, the same array is returned (so the selector does not re-render).
 * - A page from before 'read more' is added to the head, and ids that overlap are not added.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AiosEvent } from '../src/shared/agent.js'
import { parseEvent } from '../src/main/session/adapter/parse.js'
import { foldTimeline } from '../src/renderer/src/thread/timeline.js'
import {
  appendEvents,
  dropSupersededDeltas,
  keepsLiveEvents,
  lastCommands,
  lastMcpServers,
  liveDeltasOnly,
  mergeLoaded,
  prependOlder
} from '../src/renderer/src/thread-events.js'

const fixture = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'stream-session.jsonl')

function fixtureEvents(): AiosEvent[] {
  let n = 0
  const ctx = { sessionId: 's', threadId: 't', now: () => 1_000 + n, newId: () => `f${(n += 1)}` }
  return readFileSync(fixture, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => [...parseEvent(line, ctx)])
}

let seq = 0
function ev(kind: AiosEvent['kind'], payload: unknown): AiosEvent {
  seq += 1
  return { id: `x${seq}`, sessionId: 's', threadId: 't', ts: 10_000 + seq, actor: 'main', kind, payload } as AiosEvent
}
const delta = (text: string): AiosEvent => ev('assistant_delta', { text })
const thinking = (text: string): AiosEvent => ev('thinking_delta', { text })

/** Three synthetic turns. The last turn ends while still receiving (its deltas should survive). */
function synthetic(): AiosEvent[] {
  return [
    ev('user_text', { text: '一つ目' }),
    thinking('考え'),
    thinking('中'),
    delta('こん'),
    delta('にちは'),
    ev('assistant_text', { text: 'こんにちは' }),
    ev('result', { ok: true, subtype: 'success', turns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, stopReason: null, denials: [], text: null }),
    ev('user_text', { text: '二つ目' }),
    delta('ツールを'),
    ev('tool_use', { toolUseId: 'tu1', name: 'Read', summary: 'a.txt', input: {} }),
    delta('読みました'),
    ev('assistant_text', { text: '読みました' }),
    ev('user_text', { text: '三つ目' }),
    thinking('まだ'),
    delta('受信'),
    delta('中')
  ]
}

function inBatches(events: readonly AiosEvent[], sizes: readonly number[]): readonly AiosEvent[] {
  let list: readonly AiosEvent[] = []
  let at = 0
  let i = 0
  while (at < events.length) {
    const size = sizes[i % sizes.length]!
    list = appendEvents(list, events.slice(at, at + size))
    at += size
    i += 1
  }
  return list
}

describe('appendEvents: drops delta without changing the rendering result', () => {
  for (const [name, source] of [
    ['fixture (実物の 1 ターン)', fixtureEvents],
    ['合成の 3 ターン (受信中で終わる)', synthetic]
  ] as const) {
    it(`${name}: fold is the same with one at a time, all at once, and in scattered batches`, () => {
      const all = source()
      const expected = foldTimeline(all)
      for (const sizes of [[1], [all.length], [3, 1, 5, 2], [2]]) {
        const kept = inBatches(all, sizes)
        expect(foldTimeline(kept)).toEqual(expected)
      }
    })
  }

  it('no confirmed delta remains, only the delta being received remains', () => {
    const kept = inBatches(synthetic(), [1])
    const deltas = kept.filter((e) => e.kind === 'assistant_delta' || e.kind === 'thinking_delta')
    expect(deltas.map((e) => (e.payload as { text: string }).text)).toEqual(['まだ', '受信', '中'])
    // All confirmed versions are kept.
    expect(kept.filter((e) => e.kind === 'assistant_text')).toHaveLength(2)
  })

  it('no delta of the fixture remains after assistant_text', () => {
    const kept = inBatches(fixtureEvents(), [1])
    expect(kept.some((e) => e.kind === 'assistant_delta')).toBe(false)
  })

  it('returns the same array when there is nothing to drop', () => {
    const list = [ev('user_text', { text: 'a' }), delta('b')]
    expect(dropSupersededDeltas(list)).toBe(list)
    expect(appendEvents(list, [])).toBe(list)
  })
})

describe('mergeLoaded / prependOlder', () => {
  it('on open: mixes the in-flight part not in the DB into the DB rows in time order, and drops confirmed delta', () => {
    const user = ev('user_text', { text: 'q' })
    const d = delta('a')
    const text = ev('assistant_text', { text: 'a' })
    const merged = mergeLoaded([user, text], [user, d, text])
    expect(merged.map((e) => e.id)).toEqual([user.id, text.id])
  })

  it('prepends the previous page, does not add overlapping ids, and returns the same array when empty', () => {
    const a = ev('user_text', { text: 'a' })
    const b = ev('user_text', { text: 'b' })
    const c = ev('user_text', { text: 'c' })
    const current = [b, c]
    expect(prependOlder(current, [a, b]).map((e) => e.id)).toEqual([a.id, b.id, c.id])
    expect(prependOlder(current, [])).toBe(current)
    expect(prependOlder(current, [b])).toBe(current)
  })
})

describe('lastCommands (item 68)', () => {
  it('returns the list of the last session_started, and undefined when there is none', () => {
    const events = fixtureEvents()
    expect(lastCommands(events)).toContain('compact')
    expect(lastCommands(synthetic())).toBeUndefined()
    // Skip old rows (with no field) and look at the list before them.
    const old = ev('session_started', { backendSessionId: 'b', tools: [], toolServers: [], resumed: true })
    expect(lastCommands([...events, old])).toContain('compact')
  })
})

describe('lastMcpServers (item 110)', () => {
  it('returns the list of the last session_started, skips old rows without the field, and undefined when there is none', () => {
    const servers = [{ name: 'probe', state: 'connected', source: 'project', gateway: false }]
    const first = ev('session_started', { backendSessionId: 'a', tools: [], toolServers: [], resumed: false, mcpServers: [] })
    const second = ev('session_started', {
      backendSessionId: 'b', tools: [], toolServers: [], resumed: true, mcpServers: servers, gatewayConflict: true
    })
    const old = ev('session_started', { backendSessionId: 'c', tools: [], toolServers: [], resumed: true })
    expect(lastMcpServers([first, second, old])).toEqual({ servers, gatewayConflict: true })
    expect(lastMcpServers([first])).toEqual({ servers: [], gatewayConflict: false })
    expect(lastMcpServers([old])).toBeUndefined()
    expect(lastMcpServers(synthetic())).toBeUndefined()
  })
})

describe('keepsLiveEvents (TODO 570, option A)', () => {
  const none = new Set<string>()
  const ctx = (over: Partial<Parameters<typeof keepsLiveEvents>[1]>) => ({
    loaded: none,
    notPersisted: none,
    opening: none,
    retentionOf: (): string | undefined => 'forever',
    ...over
  })

  it('does not accumulate rows of a persisted thread that is not open', () => {
    expect(keepsLiveEvents('t', ctx({}))).toBe(false)
    expect(keepsLiveEvents('t', ctx({ retentionOf: () => 'days' }))).toBe(false)
  })

  it('accumulates while loaded or loading', () => {
    expect(keepsLiveEvents('t', ctx({ loaded: new Set(['t']) }))).toBe(true)
    expect(keepsLiveEvents('t', ctx({ opening: new Set(['t']) }))).toBe(true)
  })

  it('accumulates even when not open for a thread not in the DB (retention = none / notPersisted)', () => {
    expect(keepsLiveEvents('t', ctx({ retentionOf: () => 'none' }))).toBe(true)
    expect(keepsLiveEvents('t', ctx({ notPersisted: new Set(['t']) }))).toBe(true)
  })

  it('leans toward accumulating for a thread whose list row does not exist yet', () => {
    expect(keepsLiveEvents('t', ctx({ retentionOf: () => undefined }))).toBe(true)
  })
})

describe('an ending error and session_started reset the in-flight state to empty (TODO 941)', () => {
  const exitError = (): AiosEvent => ev('error', { message: 'died', origin: 'exit' })
  it('delta -> an exit error empties the timeline streaming / thinking', () => {
    const base = [ev('user_text', { text: 'q' }), thinking('考え'), delta('書きかけ')]
    expect(foldTimeline(base).streaming).toBe('書きかけ')
    const folded = foldTimeline([...base, exitError()])
    expect(folded.streaming).toBe('')
    expect(folded.thinking).toBe('')
  })
  it('delta -> session_started also empties it', () => {
    const started = ev('session_started', { sessionId: 's', model: 'm', cwd: '/', tools: [] })
    expect(foldTimeline([ev('user_text', { text: 'q' }), delta('書きかけ'), started]).streaming).toBe('')
  })
  it('the store side follows the same rule and drops delta before the exit error', () => {
    const events = [ev('user_text', { text: 'q' }), delta('a'), exitError(), delta('b')]
    expect(dropSupersededDeltas(events).filter((e) => e.kind === 'assistant_delta')).toHaveLength(1)
    const nonExit = [delta('a'), ev('error', { message: 'x', origin: 'stream' }), delta('b')]
    expect(dropSupersededDeltas(nonExit)).toBe(nonExit)
  })
})

describe('liveDeltasOnly (TODO 1139, in-flight delta of a thread that is not open)', () => {
  it('holds only delta and not confirmed rows', () => {
    const d1 = delta('文の')
    const out = liveDeltasOnly([], [ev('user_text', { text: 'q' }), d1, ev('tool_use', {})])
    expect(out).toEqual([])
    const out2 = liveDeltasOnly([], [ev('user_text', { text: 'q' }), d1, thinking('考え')])
    expect(out2).toHaveLength(2)
    expect(out2.every((e) => e.kind === 'assistant_delta' || e.kind === 'thinking_delta')).toBe(true)
  })

  it('adds subsequent delta, and drops them when confirmed (assistant_text / result) arrives', () => {
    const a = delta('途')
    const b = delta('中')
    const first = liveDeltasOnly([], [a])
    const second = liveDeltasOnly(first, [b])
    expect(second.map((e) => e.id)).toEqual([a.id, b.id])
    expect(liveDeltasOnly(second, [ev('assistant_text', { text: '途中' })])).toEqual([])
  })

  it('returns the same array when unchanged, and on open it is mixed after the DB rows and shown as in-flight', () => {
    const cur: AiosEvent[] = []
    expect(liveDeltasOnly(cur, [ev('result', {})])).toBe(cur)
    const q = ev('user_text', { text: 'q' })
    const live = liveDeltasOnly([], [delta('文の途中から')])
    const merged = mergeLoaded([q], live)
    expect(foldTimeline(merged).streaming).toBe('文の途中から')
  })
})
