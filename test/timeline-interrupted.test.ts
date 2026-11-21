/**
 * Item 280-5 (wave 15 bundle I): a tool call whose turn ended without its result arriving is 'interrupted', not 'running'. Since `foldTimeline` (a pure function) decides only from the saved rows, it is the same after a restart. The event shape is not changed.
 */
import { describe, expect, it } from 'vitest'
import type { AiosEvent } from '../src/shared/agent.js'
import { foldTimeline, type ToolItem } from '../src/renderer/src/thread/timeline.js'
import { translate } from '../src/renderer/src/i18n/index.js'

let seq = 0
function ev(partial: Partial<AiosEvent> & Pick<AiosEvent, 'kind' | 'payload'>): AiosEvent {
  seq += 1
  return {
    id: partial.id ?? `e${seq}`,
    sessionId: 's1',
    threadId: 't1',
    ts: 5000 + seq,
    actor: 'main',
    ...partial
  } as AiosEvent
}

const toolUse = (toolUseId: string, parentToolUseId?: string): AiosEvent =>
  ev({
    kind: 'tool_use',
    ...(parentToolUseId === undefined ? {} : { parentToolUseId, actor: 'subagent' as const }),
    payload: { toolUseId, name: 'Bash', summary: 'sleep 70', input: {}, truncated: false }
  })
const toolResult = (toolUseId: string): AiosEvent =>
  ev({ kind: 'tool_result', payload: { toolUseId, ok: true, bytes: 12 } })
const turnResult = (interrupted = false): AiosEvent =>
  ev({
    kind: 'result',
    payload: {
      ok: !interrupted,
      subtype: interrupted ? 'error_during_execution' : 'success',
      turns: 1,
      durationMs: 100,
      costUsd: 0,
      usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: null,
      denials: [],
      text: '',
      ...(interrupted ? { interrupted: true } : {})
    }
  })
const sessionStarted = (): AiosEvent =>
  ev({
    kind: 'session_started',
    payload: {
      backendSessionId: 'b1',
      backendVersion: '2.1.280',
      model: 'm',
      cwd: '/w',
      reportedPermissionMode: 'default',
      tools: [],
      toolServers: [],
      resumed: true
    }
  })

const tools = (events: readonly AiosEvent[], options?: { live?: boolean }): ToolItem[] =>
  foldTimeline(events, options).items.filter((i): i is ToolItem => i.kind === 'tool')

describe('項目 280-5: 結果の来ないツール呼び出し', () => {
  it('走っている最中 (後ろに何も無く、プロセスが生きている) は「中断」にしない', () => {
    const [item] = tools([toolUse('a')])
    expect(item?.result).toBeNull()
    expect(item?.interrupted).toBeUndefined()
  })

  it('後ろに result (中断・停止したターンの終わり) が来たら interrupted', () => {
    const [item] = tools([toolUse('a'), turnResult(true)])
    expect(item?.result).toBeNull()
    expect(item?.interrupted).toBe(true)
    // The same for a call without a result, even on a normal end with a `result`.
    expect(tools([toolUse('a'), turnResult(false)])[0]?.interrupted).toBe(true)
  })

  it('結果が来た呼び出しは、後ろに result が来ても interrupted にならない', () => {
    const [item] = tools([toolUse('a'), toolResult('a'), turnResult()])
    expect(item?.result).toEqual({ ok: true, bytes: 12 })
    expect(item?.interrupted).toBeUndefined()
  })

  it('後ろに session_started (再開・再起動) が来ても、終了の error (origin: exit) でも interrupted', () => {
    expect(tools([toolUse('a'), sessionStarted()])[0]?.interrupted).toBe(true)
    const exit = ev({ kind: 'error', payload: { message: '落ちた', code: null, origin: 'exit' } })
    expect(tools([toolUse('a'), exit])[0]?.interrupted).toBe(true)
    const stream = ev({ kind: 'error', payload: { message: 'x', code: null, origin: 'stream' } })
    expect(tools([toolUse('a'), stream])[0]?.interrupted).toBeUndefined()
  })

  it('live: false (プロセスが無い。再起動後の idle) なら、末尾でも interrupted', () => {
    expect(tools([toolUse('a')], { live: false })[0]?.interrupted).toBe(true)
    expect(tools([toolUse('a')], { live: true })[0]?.interrupted).toBeUndefined()
    // A row whose result has arrived does not change even with live: false.
    expect(tools([toolUse('a'), toolResult('a')], { live: false })[0]?.interrupted).toBeUndefined()
  })

  it('遅れて結果が届いたら「中断」の印を外す (結果が勝つ)', () => {
    const [item] = tools([toolUse('a'), turnResult(true), toolResult('a')])
    expect(item?.result).toEqual({ ok: true, bytes: 12 })
    expect(item?.interrupted).toBeUndefined()
  })

  it('子 (parentToolUseId あり) のツール呼び出しは、親の result では中断にしない (裏で動く子が続く)', () => {
    const [parent] = tools([toolUse('p'), toolUse('c', 'p'), turnResult()])
    expect(parent?.interrupted).toBe(true)
    const child = parent?.children[0]
    expect(child?.kind).toBe('tool')
    expect((child as ToolItem).interrupted).toBeUndefined()
  })

  it('同じ列を畳み直しても同じ (保存された行だけで決まる = 再起動後も同じ)', () => {
    const events = [toolUse('a'), toolResult('a'), toolUse('b'), turnResult(true), sessionStarted()]
    expect(foldTimeline(events)).toEqual(foldTimeline(events))
    expect(tools(events).map((i) => i.interrupted)).toEqual([undefined, true])
  })

  it('辞書に「中断」の鍵がある (EN / JA)', () => {
    expect(translate('ja', 'tool.interrupted')).toBe('中断')
    expect(translate('en', 'tool.interrupted')).toBe('Interrupted')
  })
})
