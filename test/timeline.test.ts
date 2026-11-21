/**
 * The folding used by ThreadPane (ARCHITECTURE.md 5.1 / 4.6). These are pure functions separated from rendering, so they run without a DOM.
 */
import { describe, expect, it } from 'vitest'
import type { AiosEvent } from '../src/shared/agent.js'
import {
  foldTimeline,
  formatBytes,
  formatHeld,
  formatWhen
} from '../src/renderer/src/thread/timeline.js'
import { translate } from '../src/renderer/src/i18n/index.js'

const t = (key: string, params?: Record<string, string | number>): string =>
  translate('ja', key, params)

let seq = 0
function ev(partial: Partial<AiosEvent> & Pick<AiosEvent, 'kind' | 'payload'>): AiosEvent {
  seq += 1
  return {
    id: partial.id ?? `e${seq}`,
    sessionId: 's1',
    threadId: 't1',
    ts: 1000 + seq,
    actor: 'main',
    ...partial
  } as AiosEvent
}

describe('foldTimeline — ストリーミング (5.1)', () => {
  it('delta を積み、確定したら捨てる', () => {
    const mid = foldTimeline([
      ev({ kind: 'user_text', payload: { text: 'やって' } }),
      ev({ kind: 'assistant_delta', payload: { text: 'こん' } }),
      ev({ kind: 'assistant_delta', payload: { text: 'にちは' } })
    ])
    expect(mid.streaming).toBe('こんにちは')
    expect(mid.items.map((i) => i.kind)).toEqual(['user'])

    const done = foldTimeline([
      ev({ kind: 'user_text', payload: { text: 'やって' } }),
      ev({ kind: 'assistant_delta', payload: { text: 'こん' } }),
      ev({ kind: 'assistant_delta', payload: { text: 'にちは' } }),
      ev({ kind: 'assistant_text', payload: { text: 'こんにちは' } })
    ])
    expect(done.streaming).toBe('')
    expect(done.items.map((i) => i.kind)).toEqual(['user', 'assistant'])
  })

  it('思考は本文と別に持ち、確定で消える', () => {
    const mid = foldTimeline([ev({ kind: 'thinking_delta', payload: { text: 'ふむ' } })])
    expect(mid.thinking).toBe('ふむ')
    expect(mid.items).toHaveLength(0)

    const after = foldTimeline([
      ev({ kind: 'thinking_delta', payload: { text: 'ふむ' } }),
      ev({ kind: 'assistant_text', payload: { text: '答え' } })
    ])
    expect(after.thinking).toBe('')
  })
})

describe('foldTimeline — ツール呼び出し', () => {
  const toolUse = () =>
    ev({
      id: 'tu',
      kind: 'tool_use',
      payload: {
        toolUseId: 't1',
        name: 'Read',
        summary: '/a.txt',
        input: { file_path: '/a.txt' },
        truncated: false
      }
    })

  it('結果を同じ toolUseId で束ねる', () => {
    const folded = foldTimeline([
      toolUse(),
      ev({ kind: 'tool_result', payload: { toolUseId: 't1', ok: true, bytes: 120, text: 'hi' } })
    ])
    expect(folded.items).toHaveLength(1)
    const [item] = folded.items
    if (item?.kind !== 'tool') throw new Error('wrong kind')
    expect(item.result).toEqual({ ok: true, bytes: 120, text: 'hi' })
  })

  it('復元後 (text 無し) でも長さで描ける', () => {
    const folded = foldTimeline([
      toolUse(),
      ev({ kind: 'tool_result', payload: { toolUseId: 't1', ok: true, bytes: 4096 } })
    ])
    const [item] = folded.items
    if (item?.kind !== 'tool') throw new Error('wrong kind')
    expect(item.result?.text).toBeUndefined()
    expect(formatBytes(item.result?.bytes ?? 0)).toBe('4.0 KB')
  })

  it('承認をツールブロックに束ねる', () => {
    const folded = foldTimeline([
      toolUse(),
      ev({
        kind: 'permission_request',
        payload: {
          requestId: 'r1',
          toolUseId: 't1',
          toolName: 'Read',
          summary: '/a.txt',
          input: {},
          requestedAt: 100,
          decidedAt: 200,
          outcome: { kind: 'allowed', by: 'user' }
        }
      })
    ])
    expect(folded.items).toHaveLength(1)
    const [item] = folded.items
    if (item?.kind !== 'tool') throw new Error('wrong kind')
    expect(item.approval?.outcome).toEqual({ kind: 'allowed', by: 'user' })
  })

  it('承認がツールより先に来た場合は独立した項目にし、決着で上書きする', () => {
    // An approval arrives **before** execution, so this is the normal order.
    const pending = {
      requestId: 'r1',
      toolUseId: null,
      toolName: 'Bash',
      summary: 'rm -rf x',
      input: {},
      requestedAt: 100
    }
    const folded = foldTimeline([
      ev({ id: 'p1', kind: 'permission_request', payload: { ...pending, decidedAt: null, outcome: { kind: 'pending' } } }),
      ev({ id: 'p2', kind: 'permission_request', payload: { ...pending, decidedAt: 300, outcome: { kind: 'denied', by: 'user', message: 'やめて' } } })
    ])
    expect(folded.items).toHaveLength(1)
    const [item] = folded.items
    if (item?.kind !== 'approval') throw new Error('wrong kind')
    expect(item.outcome).toEqual({ kind: 'denied', by: 'user', message: 'やめて' })
  })
})

describe('foldTimeline — サブエージェント階層 (4.6)', () => {
  it('親のツール呼び出しの下に畳む', () => {
    const folded = foldTimeline([
      ev({
        kind: 'tool_use',
        payload: {
          toolUseId: 'parent',
          name: 'Task',
          summary: '調査',
          input: {},
          truncated: false
        }
      }),
      ev({
        kind: 'assistant_text',
        actor: 'subagent',
        parentToolUseId: 'parent',
        payload: { text: 'サブの発言' }
      }),
      ev({
        kind: 'tool_use',
        actor: 'subagent',
        parentToolUseId: 'parent',
        payload: {
          toolUseId: 'child',
          name: 'Grep',
          summary: 'foo',
          input: {},
          truncated: false
        }
      }),
      ev({ kind: 'tool_result', payload: { toolUseId: 'child', ok: true, bytes: 10 } }),
      ev({ kind: 'assistant_text', payload: { text: '親の結論' } })
    ])

    expect(folded.items.map((i) => i.kind)).toEqual(['tool', 'assistant'])
    const [parent] = folded.items
    if (parent?.kind !== 'tool') throw new Error('wrong kind')
    expect(parent.children.map((c) => c.kind)).toEqual(['assistant', 'tool'])

    // A child's tool result also goes back to the child by toolUseId (looked up in one table whether parent or child).
    const child = parent.children[1]
    if (child?.kind !== 'tool') throw new Error('wrong kind')
    expect(child.result?.bytes).toBe(10)
  })
})

describe('foldTimeline — その他', () => {
  it('result / error / session / unknown を項目にする', () => {
    const folded = foldTimeline([
      ev({
        kind: 'session_started',
        payload: {
          backendSessionId: 'b1',
          backendVersion: '2.1.207',
          model: 'm',
          cwd: '/w',
          reportedPermissionMode: 'default',
          tools: [],
          toolServers: [],
          resumed: true
        }
      }),
      ev({ kind: 'error', payload: { message: '落ちた', code: null, origin: 'exit' } }),
      ev({ kind: 'unknown', payload: { raw: '{}', hint: 'future' } }),
      ev({
        kind: 'result',
        payload: {
          ok: true,
          subtype: 'success',
          turns: 1,
          durationMs: 1234,
          costUsd: 0.01,
          usage: { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 },
          stopReason: 'end_turn',
          denials: [],
          text: 'OK'
        }
      })
    ])
    expect(folded.items.map((i) => i.kind)).toEqual(['session', 'error', 'unknown', 'result'])
  })

  it('同じ列を渡せば同じ結果になる (再生可能)', () => {
    const events = [
      ev({ kind: 'user_text', payload: { text: 'a' } }),
      ev({ kind: 'assistant_text', payload: { text: 'b' } })
    ]
    expect(foldTimeline(events)).toEqual(foldTimeline(events))
  })
})

describe('表示の補助', () => {
  it('滞留時間 (4.2: 古い要求を目立たせる)', () => {
    expect(formatHeld(5_000, t)).toBe('5 秒')
    expect(formatHeld(125_000, t)).toBe('2 分')
    expect(formatHeld(7_300_000, t)).toBe('2 時間')
  })

  it('承認規則を作った日時: 今日は時刻、それ以外は月日 (T22 / 4.2.1)', () => {
    const now = new Date(2026, 8, 22, 13, 5).getTime()
    expect(formatWhen(new Date(2026, 8, 22, 9, 7).getTime(), t, now)).toBe('今日 09:07')
    expect(formatWhen(new Date(2026, 8, 22, 0, 0).getTime(), t, now)).toBe('今日 00:00')
    expect(formatWhen(new Date(2026, 8, 21, 23, 59).getTime(), t, now)).toBe('9/21')
    expect(formatWhen(new Date(2025, 11, 1, 10, 0).getTime(), t, now)).toBe('12/1')
  })

  it('バイト数', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
