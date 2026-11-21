/**
 * Keeps the body of a plan in the timeline (item 167, ARCHITECTURE.md 4.2.3).
 *
 * A plan that the AI itself put out by entering plan mode while Plan was OFF passes by default, without going through the approval box
 * (on the Broker side: `test/approval-plan.test.ts` / `test/session-plan.test.ts`). The timeline is the only place the user can read the plan,
 * so apart from the arguments of `tool_use` (which are clipped to 1,000 characters at save time), the full text of the plan is kept in a neutral field `tool_use.payload.plan`.
 * What is pinned down here:
 * - the Adapter (`parseEvent`) puts the full text only on the calls of plan tools (the real request is in spike 22)
 * - the full text remains after passing through the save gate (`toPersistable`), and redaction is applied
 * - the renderer's fold maps the plan onto the tool item
 *
 * **Neither the CLI nor a model is called.**
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AiosEvent, ApprovalOutcome, JsonValue } from '../src/shared/agent.js'
import { parseEvent } from '../src/main/session/adapter/parse.js'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { foldTimeline, planVerdictOfOutcome, type TimelineItem } from '../src/renderer/src/thread/timeline.js'

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/exit-plan-mode.json'), 'utf8')
) as { toolName: string; input: { plan: string; planFilePath: string } }

const exitTool = loadCompatTable().planMode?.exitTool ?? '?'

let counter = 0
const ctx = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  now: () => 1_700_000_000_000 + counter,
  newId: () => `e${(counter += 1)}`
}

function toolUses(name: string, input: unknown): Extract<AiosEvent, { kind: 'tool_use' }>[] {
  counter = 0
  const line = JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_1', model: 'm', content: [{ type: 'tool_use', id: 'tu1', name, input }] }
  })
  return [...parseEvent(line, ctx)].flatMap((e) => (e.kind === 'tool_use' ? [e] : []))
}

/** A plan longer than the 1,000-character clipping. */
const LONG_PLAN = `${fixture.input.plan}\n${'## 手順\n1. 何かをする\n'.repeat(200)}`

describe('Adapter — 計画の全文を tool_use に載せる (項目 167)', () => {
  it('実物の計画の要求 (spike 22) から全文を載せる', () => {
    expect(fixture.toolName).toBe(exitTool)
    const [use] = toolUses(fixture.toolName, fixture.input)
    expect(use?.payload.plan).toBe(fixture.input.plan)
  })

  it('引数は切り詰められても、計画の欄は全文のまま', () => {
    expect(LONG_PLAN.length).toBeGreaterThan(1000)
    const [use] = toolUses(exitTool, { ...fixture.input, plan: LONG_PLAN })
    expect(use?.payload.truncated).toBe(true)
    expect(use?.payload.plan).toBe(LONG_PLAN)
  })

  it('ほかのツール・空の計画・読めない引数には付けない', () => {
    expect(toolUses('Write', { plan: 'x', file_path: '/a' })[0]?.payload.plan).toBeUndefined()
    expect(toolUses(exitTool, { plan: '   ' })[0]?.payload.plan).toBeUndefined()
    expect(toolUses(exitTool, {})[0]?.payload.plan).toBeUndefined()
  })
})

describe('ThreadStore — 計画の全文を保存し redaction を通す (項目 167)', () => {
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

  const thread = () => {
    const found = store.getThread('thread-1')
    if (found === null) throw new Error('no thread')
    return found
  }

  it('保存して読み直しても全文が残る。秘密の文字列は落ちる', () => {
    const secret = 'Bearer sk-abc123DEF456ghi789'
    const plan = `${LONG_PLAN}\n\ncurl -H "Authorization: ${secret}"`
    const [use] = toolUses(exitTool, { ...fixture.input, plan })
    if (use === undefined) throw new Error('no tool_use')
    store.appendEvents(thread(), 'session-1', [use])
    const saved = store.readTimeline('thread-1').find((e) => e.kind === 'tool_use')
    if (saved?.kind !== 'tool_use') throw new Error('not saved')
    expect(saved.payload.plan?.startsWith(LONG_PLAN)).toBe(true)
    expect(saved.payload.plan).not.toContain('sk-abc123DEF456ghi789')
    // The arguments side is clipped (the reason the plan field is needed).
    expect(JSON.stringify(saved.payload.input).length).toBeLessThan(plan.length)
  })

  it('計画でないツール呼び出しには欄を足さない', () => {
    const [use] = toolUses('Write', { file_path: '/a', content: 'x' })
    if (use === undefined) throw new Error('no tool_use')
    store.appendEvents(thread(), 'session-1', [use])
    const saved = store.readTimeline('thread-1').find((e) => e.kind === 'tool_use')
    expect(saved?.kind === 'tool_use' && 'plan' in saved.payload).toBe(false)
  })
})

describe('plan モードの出入りの行 (項目 275)', () => {
  const enterTool = loadCompatTable().planMode?.enterTool ?? '?'
  const rows = (
    name: string,
    input: unknown,
    outcome?: ApprovalOutcome,
    result?: { ok: boolean }
  ): TimelineItem[] => {
    const events: AiosEvent[] = [...toolUses(name, input)]
    if (outcome !== undefined) {
      events.push({
        id: 'p1',
        sessionId: 's',
        threadId: 't',
        ts: 5,
        actor: 'main',
        kind: 'permission_request',
        payload: { requestId: 'r1', toolUseId: 'tu1', toolName: name, summary: '', input: {}, requestedAt: 1, decidedAt: outcome.kind === 'pending' ? null : 2, outcome }
      } as AiosEvent)
    }
    if (result !== undefined) {
      events.push({ id: 'r', sessionId: 's', threadId: 't', ts: 6, actor: 'main', kind: 'tool_result', payload: { toolUseId: 'tu1', ok: result.ok, bytes: 3 } } as AiosEvent)
    }
    return [...foldTimeline(events).items]
  }
  it('Adapter が向きと計画ファイルのパスを載せる。ほかのツールには載せない', () => {
    const [enter] = toolUses(enterTool, {})
    expect(enter?.payload.planTransition).toBe('enter')
    expect(enter?.payload.planFile).toBeUndefined()
    const [exit] = toolUses(exitTool, fixture.input)
    expect(exit?.payload.planTransition).toBe('exit')
    expect(exit?.payload.planFile).toBe(fixture.input.planFilePath)
    expect(toolUses('Write', { file_path: '/a' })[0]?.payload.planTransition).toBeUndefined()
    // This tool appears even with an empty plan, so it has a direction (the Exited plan mode row).
    expect(toolUses(exitTool, {})[0]?.payload.planTransition).toBe('exit')
  })

  it('EnterPlanMode → Entered plan mode の行 (ふつうのツールの行ではない)', () => {
    expect(rows(enterTool, {}, { kind: 'allowed', by: 'default' }, { ok: true })).toMatchObject([
      { kind: 'plan', verdict: 'entered' }
    ])
    expect(rows(enterTool, {})).toMatchObject([{ kind: 'plan', verdict: 'entered' }])
  })

  it('入る呼び出しが断られた・失敗したときはふつうのツールの行のまま', () => {
    const denied: ApprovalOutcome = { kind: 'denied', by: 'user', message: 'no' }
    expect(rows(enterTool, {}, denied)[0]?.kind).toBe('tool')
    expect(rows(enterTool, {}, undefined, { ok: false })[0]?.kind).toBe('tool')
  })

  it('ExitPlanMode の承認の決着 → User approved the plan / Stayed in plan mode / Exited plan mode', () => {
    const allowed: ApprovalOutcome = { kind: 'allowed', by: 'user' }
    const denied: ApprovalOutcome = { kind: 'denied', by: 'user', message: 'redo', reply: 'feedback' }
    const [approved] = rows(exitTool, fixture.input, allowed)
    expect(approved).toMatchObject({ kind: 'plan', verdict: 'approved', plan: fixture.input.plan, planFile: fixture.input.planFilePath })
    const [stayed] = rows(exitTool, fixture.input, denied)
    expect(stayed).toMatchObject({ kind: 'plan', verdict: 'stayed', plan: fixture.input.plan })
    expect(stayed && 'planFile' in stayed).toBe(false)
    expect(rows(exitTool, fixture.input, { kind: 'pending' })[0]).toMatchObject({ verdict: 'pending' })
    // A plan with no approval record (passed automatically) is also an approved row. If the plan is empty, it is Exited plan mode.
    expect(rows(exitTool, fixture.input)[0]).toMatchObject({ verdict: 'approved' })
    expect(rows(exitTool, {}, allowed)[0]).toMatchObject({ verdict: 'exited' })
    expect(rows(exitTool, {}, allowed)[0] && 'plan' in (rows(exitTool, {}, allowed)[0] as object)).toBe(false)
  })

  it('planVerdictOfOutcome: 承認の行 (tool_use を伴わない) も同じ判定', () => {
    expect(planVerdictOfOutcome({ kind: 'allowed', by: 'user' }, true)).toBe('approved')
    expect(planVerdictOfOutcome({ kind: 'denied', by: 'user', message: '' }, true)).toBe('stayed')
    expect(planVerdictOfOutcome({ kind: 'pending' }, true)).toBe('pending')
  })

  it('保存の門を通り、読み直した行から畳んでも同じ行になる (再起動後の復元)', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const store = new ThreadStore(db, '/Users/tester')
    store.createThread({ id: 'thread-1', title: 't', cwd: '/Users/tester/work', allowedDirs: [], retention: 'forever', backend: 'agent-cli', modelId: null, thinking: null })
    const thread = store.getThread('thread-1')
    if (thread === null) throw new Error('no thread')
    const uses = [...toolUses(enterTool, {}), ...toolUses(exitTool, fixture.input).map((e) => ({ ...e, id: 'x2' }))]
    store.appendEvents(thread, 'session-1', uses)
    const rebuilt = foldTimeline(store.readTimeline('thread-1')).items
    expect(rebuilt.map((i) => (i.kind === 'plan' ? i.verdict : i.kind))).toEqual(['entered', 'approved'])
    expect(rebuilt[1]).toMatchObject({ planFile: fixture.input.planFilePath })
    db.close()
  })
})

describe('foldTimeline — 計画をツールの項目に写す (項目 167)', () => {
  it('計画の提示の項目にだけ plan が付く', () => {
    const events = [
      ...toolUses(exitTool, fixture.input as unknown as JsonValue),
      ...toolUses('Write', { file_path: '/a', content: 'x' }).map((e) => ({ ...e, id: 'w1' }))
    ]
    // Presenting a plan became a `plan` row in item 275, and the body is held by that row (PlanBlock).
    const items = foldTimeline(events).items
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ kind: 'plan', plan: fixture.input.plan })
    expect(items[1]?.kind === 'tool' && items[1].plan).toBeUndefined()
  })
})
