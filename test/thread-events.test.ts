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

describe('appendEvents — 描画の結果を変えずに delta を捨てる', () => {
  for (const [name, source] of [
    ['fixture (実物の 1 ターン)', fixtureEvents],
    ['合成の 3 ターン (受信中で終わる)', synthetic]
  ] as const) {
    it(`${name}: 1 件ずつ・まとめて・ばらばらのバッチで fold が同じ`, () => {
      const all = source()
      const expected = foldTimeline(all)
      for (const sizes of [[1], [all.length], [3, 1, 5, 2], [2]]) {
        const kept = inBatches(all, sizes)
        expect(foldTimeline(kept)).toEqual(expected)
      }
    })
  }

  it('確定済みの delta は残らず、受信中の delta だけが残る', () => {
    const kept = inBatches(synthetic(), [1])
    const deltas = kept.filter((e) => e.kind === 'assistant_delta' || e.kind === 'thinking_delta')
    expect(deltas.map((e) => (e.payload as { text: string }).text)).toEqual(['まだ', '受信', '中'])
    // All confirmed versions are kept.
    expect(kept.filter((e) => e.kind === 'assistant_text')).toHaveLength(2)
  })

  it('fixture の delta は assistant_text の後に 1 件も残らない', () => {
    const kept = inBatches(fixtureEvents(), [1])
    expect(kept.some((e) => e.kind === 'assistant_delta')).toBe(false)
  })

  it('捨てる物が無ければ同じ配列を返す', () => {
    const list = [ev('user_text', { text: 'a' }), delta('b')]
    expect(dropSupersededDeltas(list)).toBe(list)
    expect(appendEvents(list, [])).toBe(list)
  })
})

describe('mergeLoaded / prependOlder', () => {
  it('開いたとき: DB の列に、DB に無い受信中の分を時刻順で混ぜ、確定済みの delta は捨てる', () => {
    const user = ev('user_text', { text: 'q' })
    const d = delta('a')
    const text = ev('assistant_text', { text: 'a' })
    const merged = mergeLoaded([user, text], [user, d, text])
    expect(merged.map((e) => e.id)).toEqual([user.id, text.id])
  })

  it('前のページを頭に足す。重なった id は足さない。空なら同じ配列', () => {
    const a = ev('user_text', { text: 'a' })
    const b = ev('user_text', { text: 'b' })
    const c = ev('user_text', { text: 'c' })
    const current = [b, c]
    expect(prependOlder(current, [a, b]).map((e) => e.id)).toEqual([a.id, b.id, c.id])
    expect(prependOlder(current, [])).toBe(current)
    expect(prependOlder(current, [b])).toBe(current)
  })
})

describe('lastCommands (項目 68)', () => {
  it('最後の session_started の一覧を返す。無ければ undefined', () => {
    const events = fixtureEvents()
    expect(lastCommands(events)).toContain('compact')
    expect(lastCommands(synthetic())).toBeUndefined()
    // Skip old rows (with no field) and look at the list before them.
    const old = ev('session_started', { backendSessionId: 'b', tools: [], toolServers: [], resumed: true })
    expect(lastCommands([...events, old])).toContain('compact')
  })
})

describe('lastMcpServers (項目 110)', () => {
  it('最後の session_started の一覧を返す。欄の無い古い行は飛ばす。無ければ undefined', () => {
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

describe('keepsLiveEvents (TODO 570、案 A)', () => {
  const none = new Set<string>()
  const ctx = (over: Partial<Parameters<typeof keepsLiveEvents>[1]>) => ({
    loaded: none,
    notPersisted: none,
    opening: none,
    retentionOf: (): string | undefined => 'forever',
    ...over
  })

  it('開いていない保存されるスレッドの行は積まない', () => {
    expect(keepsLiveEvents('t', ctx({}))).toBe(false)
    expect(keepsLiveEvents('t', ctx({ retentionOf: () => 'days' }))).toBe(false)
  })

  it('読み込み済み・読み込みの途中は積む', () => {
    expect(keepsLiveEvents('t', ctx({ loaded: new Set(['t']) }))).toBe(true)
    expect(keepsLiveEvents('t', ctx({ opening: new Set(['t']) }))).toBe(true)
  })

  it('DB に無いスレッド (retention = none / notPersisted) は開いていなくても積む', () => {
    expect(keepsLiveEvents('t', ctx({ retentionOf: () => 'none' }))).toBe(true)
    expect(keepsLiveEvents('t', ctx({ notPersisted: new Set(['t']) }))).toBe(true)
  })

  it('一覧の行がまだ無いスレッドは積む側に倒す', () => {
    expect(keepsLiveEvents('t', ctx({ retentionOf: () => undefined }))).toBe(true)
  })
})

describe('終了の error と session_started で受信中を空に戻す (TODO 941)', () => {
  const exitError = (): AiosEvent => ev('error', { message: 'died', origin: 'exit' })
  it('delta -> exit の error でタイムラインの streaming / thinking が空になる', () => {
    const base = [ev('user_text', { text: 'q' }), thinking('考え'), delta('書きかけ')]
    expect(foldTimeline(base).streaming).toBe('書きかけ')
    const folded = foldTimeline([...base, exitError()])
    expect(folded.streaming).toBe('')
    expect(folded.thinking).toBe('')
  })
  it('delta -> session_started でも空になる', () => {
    const started = ev('session_started', { sessionId: 's', model: 'm', cwd: '/', tools: [] })
    expect(foldTimeline([ev('user_text', { text: 'q' }), delta('書きかけ'), started]).streaming).toBe('')
  })
  it('store 側も同じ規則で、exit の error より前の delta を捨てる', () => {
    const events = [ev('user_text', { text: 'q' }), delta('a'), exitError(), delta('b')]
    expect(dropSupersededDeltas(events).filter((e) => e.kind === 'assistant_delta')).toHaveLength(1)
    const nonExit = [delta('a'), ev('error', { message: 'x', origin: 'stream' }), delta('b')]
    expect(dropSupersededDeltas(nonExit)).toBe(nonExit)
  })
})

describe('liveDeltasOnly (TODO 1139、開いていないスレッドの受信中の delta)', () => {
  it('delta だけを持ち、確定の行は持たない', () => {
    const d1 = delta('文の')
    const out = liveDeltasOnly([], [ev('user_text', { text: 'q' }), d1, ev('tool_use', {})])
    expect(out).toEqual([])
    const out2 = liveDeltasOnly([], [ev('user_text', { text: 'q' }), d1, thinking('考え')])
    expect(out2).toHaveLength(2)
    expect(out2.every((e) => e.kind === 'assistant_delta' || e.kind === 'thinking_delta')).toBe(true)
  })

  it('続きの delta は足し、確定 (assistant_text / result) が来たら捨てる', () => {
    const a = delta('途')
    const b = delta('中')
    const first = liveDeltasOnly([], [a])
    const second = liveDeltasOnly(first, [b])
    expect(second.map((e) => e.id)).toEqual([a.id, b.id])
    expect(liveDeltasOnly(second, [ev('assistant_text', { text: '途中' })])).toEqual([])
  })

  it('変わらなければ同じ配列を返し、開いたときは DB の列の後ろに混ざって受信中に出る', () => {
    const cur: AiosEvent[] = []
    expect(liveDeltasOnly(cur, [ev('result', {})])).toBe(cur)
    const q = ev('user_text', { text: 'q' })
    const live = liveDeltasOnly([], [delta('文の途中から')])
    const merged = mergeLoaded([q], live)
    expect(foldTimeline(merged).streaming).toBe('文の途中から')
  })
})
