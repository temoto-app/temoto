/**
 * Item 257 (wave 15 bundle A): the subagent block.
 *
 * - Runs `test/fixtures/subagents.jsonl` (spike 19, real CLI 2.1.280: two background children's messages and tool calls flow with `parent_tool_use_id` attached) through parseEvent, and checks the contents when split into the parent's list and the blocks (order, counts, '+N') (pure functions in `thread/subagent-blocks.ts`).
 * - Save -> reload -> the block is restored; `toPersistable` drops the child's `tool_result` body and the child's tool arguments (the real DB code, `ThreadStore`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AiosEvent } from '../src/shared/agent.js'
import { parseEvent } from '../src/main/session/adapter/parse.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { foldTimeline } from '../src/renderer/src/thread/timeline.js'
import {
  appendChildEvents,
  blockHasEvent,
  foldSubagentBlock,
  mergeChildEvents,
  NO_BUCKETS,
  prependChildEvents,
  RECENT_STEPS,
  splitChildEvents,
  subagentBlockView
} from '../src/renderer/src/thread/subagent-blocks.js'

const AGENT_1 = 'toolu_01Gfe7iMozkfgreA8c88HX5E'
const AGENT_2 = 'toolu_01RUK3sK2Ynya1aHz6v1ezJQ'

function fixtureEvents(threadId = 'thread-1'): AiosEvent[] {
  const lines = readFileSync(new URL('./fixtures/subagents.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.includes('"control_response"'))
  let n = 0
  let ts = 1_000
  const ctx = {
    sessionId: 'session-1',
    threadId,
    // Advance the time per row so that the order does not break across save and reload (in practice, ms values can coincide).
    now: () => (ts += 1),
    newId: () => `fx${(n += 1)}`
  }
  return lines.flatMap((line) => [...parseEvent(line, ctx)])
}

type Item = ReturnType<typeof foldSubagentBlock>[number]

/** Makes the block's contents easy to compare. Tools are 'name summary result', messages are their text. */
function shape(items: readonly Item[]): string[] {
  return items.map((item) => {
    if (item.kind === 'tool') {
      return `tool:${item.name}:${item.summary}:${item.result === null ? 'running' : item.result.ok ? 'ok' : 'bad'}`
    }
    if (item.kind === 'assistant') return `${item.actor}:${item.text}`
    return item.kind
  })
}

function child(parent: string, kind: 'tool_use' | 'tool_result' | 'assistant_text', n: number, ts: number): AiosEvent {
  const base = { id: `${parent}-${kind}-${n}`, sessionId: 's', threadId: 't', ts, actor: 'subagent' as const, parentToolUseId: parent }
  if (kind === 'tool_use') {
    return { ...base, kind, payload: { toolUseId: `${parent}-c${n}`, name: 'Read', summary: `f${n}.ts`, input: {}, truncated: false } }
  }
  if (kind === 'tool_result') {
    return { ...base, kind, payload: { toolUseId: `${parent}-c${n}`, ok: n !== 2, bytes: 10, text: 'body' } }
  }
  return { ...base, kind, payload: { text: `発言 ${n}` } }
}

describe('child agent blocks - sorting the real thing (spike 19)', () => {
  it("child rows do not enter the parent's column and enter the block per parent Agent call id in arrival order", () => {
    const events = fixtureEvents()
    const split = splitChildEvents(events)
    expect(split.main.some((event) => event.actor === 'subagent')).toBe(false)
    expect(Object.keys(split.children).sort()).toEqual([AGENT_1, AGENT_2].sort())
    // Move all child rows into the blocks, and drop none of the parent's rows.
    const moved = Object.values(split.children).reduce((sum, list) => sum + list.length, 0)
    expect(split.main.length + moved).toBe(events.length)

    const first = foldSubagentBlock(split.children[AGENT_1]!)
    const second = foldSubagentBlock(split.children[AGENT_2]!)
    // The child ran echo once and answered in one word (order: tool, then message).
    expect(shape(first)).toEqual(['tool:Bash:echo 17:ok', 'subagent:17'])
    expect(shape(second)).toEqual(['tool:Bash:echo 25:ok', 'subagent:25'])
    // Two steps, so no '+N' appears.
    const view = subagentBlockView(first, false)
    expect(view).toMatchObject({ hidden: 0, total: 2, toolUses: 1, failed: 0, collapsible: false })
  })

  it("the parent column's Agent call holds no child, and child messages do not mix into the parent's timeline", () => {
    const split = splitChildEvents(fixtureEvents())
    const { items } = foldTimeline(split.main)
    const agents = items.flatMap((item) => (item.kind === 'tool' && item.name === 'Agent' ? [item] : []))
    expect(agents.map((item) => item.toolUseId)).toEqual([AGENT_1, AGENT_2])
    expect(agents.every((item) => item.children.length === 0)).toBe(true)
    expect(items.some((item) => item.kind === 'assistant' && item.actor === 'subagent')).toBe(false)
    // The parent's final answer ('42') is in the parent's list.
    const texts = items.flatMap((item) => (item.kind === 'assistant' ? [item.text] : []))
    expect(texts.at(-1)).toBe('42')
  })

  it("when child rows were mixed in one column, the parent's body being received disappeared under child rows (does not happen with the sorting)", () => {
    // The child's tool call arrives while the parent is still receiving its text (the background child runs alongside the parent's turn; spike 19).
    const delta = (id: string, text: string): AiosEvent =>
      ({ id, sessionId: 's', threadId: 't', ts: 1, actor: 'main', kind: 'assistant_delta', payload: { text } }) as AiosEvent
    const events = [delta('d1', '親の'), child(AGENT_1, 'tool_use', 1, 2), delta('d2', '本文')]
    expect(foldTimeline(events).streaming).toBe('本文') // The previous single list: the 'parent' prefix disappears.
    expect(foldTimeline(splitChildEvents(events).main).streaming).toBe('親の本文')
  })

  it("for a batch containing no child rows, the parent's column is the very array passed in (the reference does not change)", () => {
    const events = fixtureEvents().filter((event) => event.actor === 'main')
    const split = splitChildEvents(events)
    expect(split.main).toBe(events)
    expect(split.children).toEqual({})
  })
})

describe('child agent blocks - the latest few steps and 「+N」', () => {
  const steps = (count: number): AiosEvent[] => {
    const out: AiosEvent[] = []
    for (let i = 1; i <= count; i++) {
      out.push(child('tp', 'tool_use', i, i * 10), child('tp', 'tool_result', i, i * 10 + 1))
    }
    return out
  }

  it(`when collapsed, the latest ${RECENT_STEPS} steps and 「+N」, and when expanded everything`, () => {
    const items = foldSubagentBlock([...steps(5), child('tp', 'assistant_text', 9, 100)])
    expect(items).toHaveLength(6)
    const collapsed = subagentBlockView(items, false)
    expect(collapsed.hidden).toBe(3)
    expect(shape(collapsed.items)).toEqual(['tool:Read:f4.ts:ok', 'tool:Read:f5.ts:ok', 'subagent:発言 9'])
    expect(collapsed).toMatchObject({ total: 6, toolUses: 5, failed: 1, collapsible: true })
    const expanded = subagentBlockView(items, true)
    expect(expanded.hidden).toBe(0)
    expect(expanded.items).toBe(items)
  })

  it('if only one would be hidden it is not hidden (showing one more row is shorter than a 「+1」 row)', () => {
    const items = foldSubagentBlock(steps(RECENT_STEPS + 1))
    const view = subagentBlockView(items, false)
    expect(view.hidden).toBe(0)
    expect(view.items).toHaveLength(RECENT_STEPS + 1)
    expect(view.collapsible).toBe(false)
  })

  it("a running child's tool appears as waiting for a result", () => {
    const items = foldSubagentBlock([child('tp', 'tool_use', 1, 1)])
    expect(shape(items)).toEqual(['tool:Read:f1.ts:running'])
    expect(items[0]!.kind === 'tool' && items[0]!.interrupted).toBeUndefined()
  })

  it('observation of item 333 (wave 18): passing { live: false } makes the rows of tools of children with no result 「中断」', () => {
    // When the child becomes Stopped / Failed, SubagentBlock passes this option (`item.interrupted` on ToolBlock shows 'interrupted' instead of 'running'; the same key as in timeline-interrupted.test.ts).
    const items = foldSubagentBlock([child('tp', 'tool_use', 1, 1)], { live: false })
    expect(items).toHaveLength(1)
    expect(items[0]!.kind === 'tool' && items[0]!.interrupted).toBe(true)
  })

  it('a tool of a child whose result arrived does not become 「中断」 even with { live: false }', () => {
    const items = foldSubagentBlock(
      [child('tp', 'tool_use', 1, 1), child('tp', 'tool_result', 1, 2)],
      { live: false }
    )
    expect(items[0]!.kind === 'tool' && items[0]!.result).not.toBeNull()
    expect(items[0]!.kind === 'tool' && items[0]!.interrupted).toBeUndefined()
  })

  it("by default (equivalent to { live: true }), an unfinished child's tool does not become 「中断」 (stays a running block)", () => {
    const items = foldSubagentBlock([child('tp', 'tool_use', 1, 1)])
    expect(items[0]!.kind === 'tool' && items[0]!.interrupted).toBeUndefined()
  })

  it("decides within the block whether one jumped from conversation search to a child's message", () => {
    const events = steps(2)
    expect(blockHasEvent(events, events[1]!.id)).toBe(true)
    expect(blockHasEvent(events, 'other')).toBe(false)
    expect(blockHasEvent(events, null)).toBe(false)
  })
})

describe('child agent blocks - approval requests and how they arrive (add, mix, add to the head)', () => {
  const approval = (toolUseId: string, id = 'p1'): AiosEvent =>
    ({
      id,
      sessionId: 's',
      threadId: 't',
      ts: 50,
      actor: 'main',
      kind: 'permission_request',
      payload: {
        requestId: 'r1',
        toolUseId,
        toolName: 'Read',
        summary: 'f1.ts',
        input: {},
        requestedAt: 50,
        decidedAt: null,
        outcome: { kind: 'pending' }
      }
    }) as AiosEvent

  it("an approval request pointing at a child's tool call enters that block and attaches to the child's tool row", () => {
    // A child's tool call that comes first within the same batch (spike 19: the child's row arrives 3-4 ms before the approval request).
    const same = splitChildEvents([child('tp', 'tool_use', 1, 1), approval('tp-c1')])
    expect(same.main).toEqual([])
    const items = foldSubagentBlock(same.children['tp']!)
    expect(items).toHaveLength(1)
    expect(items[0]!.kind === 'tool' && items[0]!.approval?.outcome.kind).toBe('pending')
    // A child's tool call that was already in the block in an earlier batch.
    const later = splitChildEvents([approval('tp-c1', 'p2')], { tp: [child('tp', 'tool_use', 1, 1)] })
    expect(Object.keys(later.children)).toEqual(['tp'])
    // An approval request that points at a parent tool stays in the parent's list.
    const parent = splitChildEvents([approval('toolu_parent')], { tp: [child('tp', 'tool_use', 1, 1)] })
    expect(parent.main).toHaveLength(1)
  })

  it('when adding, only the touched block gets a new array and the references of other blocks are kept', () => {
    const buckets = { a: [child('a', 'tool_use', 1, 1)], b: [child('b', 'tool_use', 1, 1)] }
    const next = appendChildEvents(buckets, { a: [child('a', 'tool_result', 1, 2)] })
    expect(next['b']).toBe(buckets.b)
    expect(next['a']).toHaveLength(2)
    expect(appendChildEvents(buckets, {})).toBe(buckets)
  })

  it("when opened, orders the DB's blocks and those that arrived while open by time without overlapping by id", () => {
    const fromDb = { a: [child('a', 'tool_use', 1, 1), child('a', 'tool_result', 1, 3)] }
    const live = { a: [child('a', 'tool_result', 1, 3), child('a', 'assistant_text', 2, 2)] }
    const merged = mergeChildEvents(fromDb, live)
    expect(merged['a']!.map((event) => event.ts)).toEqual([1, 2, 3])
    expect(mergeChildEvents({}, NO_BUCKETS)).toBe(NO_BUCKETS)
  })

  it("a child's rows from the page before 「さらに読む」 are added to the head of the block, and ids already present are not added", () => {
    const current = { a: [child('a', 'tool_result', 1, 3)] }
    const next = prependChildEvents(current, { a: [child('a', 'tool_use', 1, 1), child('a', 'tool_result', 1, 3)] })
    expect(next['a']!.map((event) => event.kind)).toEqual(['tool_use', 'tool_result'])
    expect(prependChildEvents(current, { a: [child('a', 'tool_result', 1, 3)] })).toBe(current)
  })
})

describe('child agent blocks - saving and re-reading (the real DB code)', () => {
  let db: Db
  let store: ThreadStore

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    store = new ThreadStore(db, '/Users/tester')
    store.createThread({
      id: 'thread-1',
      title: 'テスト',
      cwd: '/Users/tester/work',
      allowedDirs: ['/Users/tester/work'],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
  })

  afterEach(() => db.close())

  it("the same block after saving and reopening, and a child's tool_result body and child tool arguments do not remain", () => {
    const thread = store.getThread('thread-1')!
    const events = fixtureEvents()
    const live = splitChildEvents(events)
    store.appendEvents(thread, 'session-1', events)

    const raw = db
      .prepare(`SELECT kind, actor, parent_tool_use_id AS parent, payload FROM thread_events WHERE thread_id = ?`)
      .all('thread-1') as { kind: string; actor: string; parent: string | null; payload: string }[]
    const childRows = raw.filter((row) => row.actor === 'subagent')
    expect(childRows.length).toBeGreaterThan(0)
    for (const row of childRows) {
      expect([AGENT_1, AGENT_2]).toContain(row.parent)
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      // Constraint 10: tool_result keeps only the length and the success flag. The output of the child's echo ('17') is not in the result body.
      if (row.kind === 'tool_result') expect(Object.keys(payload).sort()).toEqual(['bytes', 'ok', 'toolUseId'])
      // Item 257: a child's tool call keeps only its name and summary (the body of the arguments is not kept).
      if (row.kind === 'tool_use') {
        expect(payload['input']).toBeNull()
        expect(payload['truncated']).toBe(true)
        expect(payload['name']).toBe('Bash')
        expect(payload['summary']).toMatch(/^echo (17|25)$/)
      }
    }
    // Neither the child's instruction text nor the full arguments of the child's command remain (the parent's Agent arguments remain as the parent's tool).
    expect(childRows.some((row) => row.payload.includes('"command"'))).toBe(false)

    const reloaded = splitChildEvents(store.readTimeline('thread-1'))
    for (const id of [AGENT_1, AGENT_2]) {
      const before = shape(foldSubagentBlock(live.children[id]!))
      const after = shape(foldSubagentBlock(reloaded.children[id]!))
      expect(after).toEqual(before)
    }
    // After reopening, a child's tool has null arguments (ToolBlock does not show an argument frame).
    const tool = foldSubagentBlock(reloaded.children[AGENT_1]!)[0]!
    expect(tool.kind === 'tool' && tool.input).toBeNull()
    expect(tool.kind === 'tool' && tool.result?.text).toBeUndefined()
  })

  it("a child's message does not become the list preview (the parent's last message is the preview)", () => {
    const thread = store.getThread('thread-1')!
    const events = fixtureEvents()
    // Cut at a point where there is no parent message after the child's messages ('17', '25').
    const cut = events.findIndex((event) => event.actor === 'subagent' && event.kind === 'assistant_text')
    store.appendEvents(thread, 'session-1', events.slice(0, cut + 1))
    const preview = store.previewOf('thread-1')
    expect(preview).not.toBe('17')
    expect(store.getThread('thread-1')).toBeDefined()
    const row = db.prepare(`SELECT preview FROM threads WHERE id = ?`).get('thread-1') as { preview: string | null }
    expect(row.preview).toBe(preview)
  })
})
