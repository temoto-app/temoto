/**
 * Separators for built-in commands and the work list (items 117 / 118, ARCHITECTURE.md 4.5.3.1 / 4.6.4, bundle C).
 *
 * The fixture (`test/fixtures/builtins.jsonl`) is **a real capture from CLI 2.1.280 (haiku) run as one process for 10 turns** (stream_event lines dropped,
 * paths and thinking signatures replaced with synthetic values). In order: one ordinary turn -> `/context` -> `/cost` -> `/status` (does not work) -> have it make a work list (`ToolSearch` first
 * -> `TodoWrite`) -> have it advance the work list -> `/compact` -> one turn -> `/clear` -> one turn.
 *
 * **It can run without calling the model.**
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AiosEvent, TodoItem } from '../src/shared/agent.js'
import type { ThreadSummary, TodoList } from '../src/shared/thread.js'
import { parseEvent } from '../src/main/session/adapter/parse.js'
import {
  adjustCommands,
  MAX_TODO_ITEMS,
  MAX_TODO_TEXT_CHARS,
  todoItemsFromInput
} from '../src/main/session/adapter/builtins.js'
import { loadCompatTable, type CompatTable } from '../src/main/session/adapter/compat.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { foldTimeline } from '../src/renderer/src/thread/timeline.js'
import { buildProgressTurns } from '../src/renderer/src/thread/progress.js'
import { dropSupersededDeltas } from '../src/renderer/src/thread-events.js'
import { applyThreadChange, indexFromList } from '../src/renderer/src/thread-index.js'
import { currentTodo, shouldShowTodos, todoCounts, todoText } from '../src/renderer/src/thread/todos.js'
import { translate } from '../src/renderer/src/i18n/index.js'
import { checkSlash, suggestSlash } from '../src/renderer/src/composer-slash.js'

const lines = readFileSync(new URL('./fixtures/builtins.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')

let counter = 0
const ctx = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  now: () => 1_700_000_000_000 + counter,
  newId: () => `e${(counter += 1)}`
}

function parseAll(source: readonly string[] = lines): AiosEvent[] {
  counter = 0
  return source.flatMap((line) => [...parseEvent(line, ctx)])
}

const table = (): CompatTable => loadCompatTable()

describe('parseEvent — real built-in commands (item 117)', () => {
  it('turns delimiters into neutral events and makes nothing unknown', () => {
    const events = parseAll()
    expect(events.filter((e) => e.kind === 'unknown')).toEqual([])
    expect(events.filter((e) => e.kind === 'conversation_reset')).toHaveLength(1)
    const compacted = events.filter((e) => e.kind === 'context_compacted')
    expect(compacted).toHaveLength(1)
    expect(compacted[0]?.payload).toEqual({ trigger: 'manual', preTokens: 32679, postTokens: 1888 })
  })

  it('a line answered without calling the API (synthetic model name, usage 0) does not become turn_usage; the body and result remain', () => {
    const events = parseAll()
    const usages = events.flatMap((e) => (e.kind === 'turn_usage' ? [e.payload] : []))
    expect(usages.length).toBeGreaterThan(0)
    for (const usage of usages) {
      expect(usage.model).toBe('claude-haiku-4-5-20251001')
      expect(usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens).toBeGreaterThan(0)
    }
    const texts = events.flatMap((e) => (e.kind === 'assistant_text' ? [e.payload.text] : []))
    expect(texts.some((t) => t.startsWith('## Context Usage'))).toBe(true)
    expect(texts).toContain("/status isn't available in this environment.")
    // A command that does not work also does not fail (the reason the judgment is kept in the table).
    expect(events.filter((e) => e.kind === 'result').every((e) => e.kind === 'result' && e.payload.ok)).toBe(true)
  })

  it('passing only a synthetic line does not produce usage either (judged by model name), and a usage-0 line is the same', () => {
    const synthetic = JSON.stringify({
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      }
    })
    const zero = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'm',
        content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      }
    })
    for (const line of [synthetic, zero]) {
      expect(parseAll([line]).map((e) => e.kind)).toEqual(['assistant_text'])
    }
  })

  it('fixes the init command list with the table: adds cost missing from the list and drops those that do not work', () => {
    const starts = parseAll().flatMap((e) => (e.kind === 'session_started' ? [e.payload] : []))
    const commands = starts[0]?.commands ?? []
    expect(commands).toContain('cost')
    expect(commands).toContain('compact')
    expect(commands).toContain('clear')
    for (const name of ['status', 'help', 'memory']) expect(commands).not.toContain(name)
    // Not in the real capture, but if it appears in the list it is also dropped.
    const reported = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', slash_commands: ['help', 'x'] })
    expect(parseAll([reported]).flatMap((e) => (e.kind === 'session_started' ? [e.payload.commands] : []))).toEqual([
      ['x', 'cost']
    ])
  })

  it('does not fail even without the compaction boundary field', () => {
    const bare = JSON.stringify({ type: 'system', subtype: 'compact_boundary' })
    expect(parseAll([bare]).map((e) => e.payload)).toEqual([{ trigger: null, preTokens: null, postTokens: null }])
  })
})

describe('adjustCommands (item 117)', () => {
  it("the Composer's judgment (item 68) uses the fixed list: /cost passes, and /memory /help /status stop at the band", () => {
    const commands = parseAll().flatMap((e) => (e.kind === 'session_started' ? [e.payload.commands ?? null] : []))[0] ?? null
    expect(checkSlash('/cost', commands).kind).toBe('known')
    expect(checkSlash('/compact', commands).kind).toBe('known')
    expect(checkSlash('/clear', commands).kind).toBe('known')
    for (const name of ['memory', 'help', 'status']) expect(checkSlash(`/${name}`, commands).kind).toBe('unknown')
    expect(suggestSlash('/co', commands)).toContain('cost')
  })

  it('unknown (null) stays null; keeps the reported order, additions go at the end, and no duplicates', () => {
    expect(adjustCommands(table(), null)).toBeNull()
    expect(adjustCommands(table(), ['a', 'help', 'b'])).toEqual(['a', 'b', 'cost'])
    expect(adjustCommands(table(), ['cost', 'a'])).toEqual(['cost', 'a'])
  })

  it('as reported when the table has no section', () => {
    const bare: CompatTable = { ...table(), builtinCommands: undefined }
    expect(adjustCommands(bare, ['help'])).toEqual(['help'])
  })
})

describe('task list (item 118)', () => {
  it('turns a real TodoWrite into a neutral task list; not attached to ToolSearch', () => {
    const uses = parseAll().flatMap((e) => (e.kind === 'tool_use' ? [e.payload] : []))
    expect(uses.map((u) => u.name)).toEqual(['ToolSearch', 'TodoWrite', 'TodoWrite'])
    expect(uses[0]?.todos).toBeUndefined()
    expect(uses[1]?.todos).toEqual([
      { content: 'A', activeForm: 'Working on A', status: 'in_progress' },
      { content: 'B', activeForm: 'Working on B', status: 'pending' },
      { content: 'C', activeForm: 'Working on C', status: 'pending' }
    ])
    expect(uses[2]?.todos?.map((t) => t.status)).toEqual(['completed', 'in_progress', 'pending'])
  })

  it("not attached to a subagent's task list (with parent_tool_use_id)", () => {
    const line = JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      message: {
        model: 'm',
        content: [{ type: 'tool_use', id: 'tu', name: 'TodoWrite', input: { todos: [{ content: 'A', status: 'pending' }] } }]
      }
    })
    const uses = parseAll([line]).flatMap((e) => (e.kind === 'tool_use' ? [e] : []))
    expect(uses).toHaveLength(1)
    expect(uses[0]?.actor).toBe('subagent')
    expect(uses[0]?.payload.todos).toBeUndefined()
  })

  it('drops lines of the wrong shape, treats unknown states as not started, and cuts long sentences and long lists', () => {
    const items = todoItemsFromInput(table(), 'TodoWrite', {
      todos: [
        { content: 'ok', status: 'weird' },
        { content: '', status: 'pending' },
        'not-an-object',
        { status: 'pending' },
        { content: 'x'.repeat(1000), activeForm: '  ', status: 'completed' }
      ]
    })
    expect(items).toEqual([
      { content: 'ok', activeForm: null, status: 'pending' },
      { content: `${'x'.repeat(MAX_TODO_TEXT_CHARS)}…`, activeForm: null, status: 'completed' }
    ])
    const many = todoItemsFromInput(table(), 'TodoWrite', {
      todos: Array.from({ length: 500 }, (_, i) => ({ content: `t${i}`, status: 'pending' }))
    })
    expect(many).toHaveLength(MAX_TODO_ITEMS)
    // An empty list means "everything is done" (the signal to clear the fixed display). A tool not in the table, or one with a different argument shape, is null.
    expect(todoItemsFromInput(table(), 'TodoWrite', { todos: [] })).toEqual([])
    expect(todoItemsFromInput(table(), 'Read', { todos: [] })).toBeNull()
    expect(todoItemsFromInput(table(), 'TodoWrite', { todos: 'x' })).toBeNull()
  })

  it('pinned display counting: done/total, the folded one line is in progress → not started, and in progress uses the progressive sentence', () => {
    const items: TodoItem[] = [
      { content: 'A', activeForm: 'Doing A', status: 'completed' },
      { content: 'B', activeForm: 'Doing B', status: 'pending' },
      { content: 'C', activeForm: 'Doing C', status: 'in_progress' }
    ]
    expect(todoCounts(items)).toEqual({ done: 1, total: 3 })
    expect(currentTodo(items)?.content).toBe('C')
    expect(todoText(items[2]!)).toBe('Doing C')
    expect(todoText(items[1]!)).toBe('B')
    expect(currentTodo([items[0]!])).toBeNull()
    expect(todoText({ content: 'D', activeForm: null, status: 'in_progress' })).toBe('D')
  })

  it('a closed list is not shown during the same rewrite and is shown when a new rewrite comes; an empty list is not shown', () => {
    const list = (toolUseId: string, items: TodoItem[]): TodoList => ({ toolUseId, items, at: 1 })
    const one: TodoItem[] = [{ content: 'A', activeForm: null, status: 'pending' }]
    expect(shouldShowTodos(null, null)).toBe(false)
    expect(shouldShowTodos(list('t1', []), null)).toBe(false)
    expect(shouldShowTodos(list('t1', one), null)).toBe(true)
    expect(shouldShowTodos(list('t1', one), 't1')).toBe(false)
    expect(shouldShowTodos(list('t2', one), 't1')).toBe(true)
  })
})

describe('timeline (item 117)', () => {
  it('draws delimiters one line at a time and does not change the handling of strings being received (the same result as the sequence with deltas dropped)', () => {
    const events = parseAll()
    const folded = foldTimeline(events)
    const boundaries = folded.items.flatMap((item) => (item.kind === 'boundary' ? [item] : []))
    expect(boundaries.map((b) => b.boundary)).toEqual(['compacted', 'reset'])
    expect(boundaries[0]).toMatchObject({ trigger: 'manual', preTokens: 32679, postTokens: 1888 })
    // Item 88 pitfall: the set of "emptied while receiving" in thread-events.ts and the set in fold must not drift apart.
    // Even for a row where a delta remained just before a separator, the result is the same as the dropped row.
    const delta = (id: string): AiosEvent => ({
      id, sessionId: 's', threadId: 't', ts: 1, actor: 'main', kind: 'assistant_delta', payload: { text: 'x' }
    })
    const withDelta = [...events.slice(0, 3), delta('d1'), ...events.slice(3)]
    expect(foldTimeline(dropSupersededDeltas(withDelta))).toEqual(foldTimeline(withDelta))
  })

  it('a delimiter becomes the drawing position of an interim report (has its own row)', () => {
    const events = parseAll()
    // In a row right after a separator arrives (the later init / result are not there yet), the position of the last turn becomes the separator.
    const upTo = events.findIndex((e) => e.kind === 'conversation_reset')
    const turns = buildProgressTurns(events.slice(0, upTo + 1), (key, params) => translate('ja', key, params))
    expect(turns.at(-1)?.afterId).toBe(events[upTo]?.id)
  })

  it('the wording keys exist in both languages', () => {
    for (const locale of ['ja', 'en'] as const) {
      for (const key of [
        'timeline.boundary.reset',
        'timeline.boundary.compacted',
        'timeline.boundary.compactedAuto',
        'todos.heading'
      ]) {
        expect(translate(locale, key)).not.toBe(key)
      }
    }
  })
})

describe('reuse of the list (items 118 / 75)', () => {
  const summary = (todos: TodoList | null, cost = 0): ThreadSummary =>
    ({
      thread: { id: 'a', title: '', lastEventAt: 1, createdAt: 1, updatedAt: 1 },
      runtime: { threadId: 'a', costUsd: cost, reservations: [], contextUsage: null, subtasks: [], todos },
      preview: null
    }) as unknown as ThreadSummary
  const list: TodoList = { toolUseId: 't', items: [{ content: 'A', activeForm: null, status: 'pending' }], at: 1 }

  it('in a one-item delivery where only the cost moved, reuses the previous object if the task list contents are the same', () => {
    const first = indexFromList([summary(list)])
    const next = applyThreadChange(first, summary({ ...list, items: [...list.items] }, 0.5))
    expect(next.byId['a']?.runtime.costUsd).toBe(0.5)
    expect(next.byId['a']?.runtime.todos).toBe(first.byId['a']?.runtime.todos)
  })
})

describe('ThreadStore — save and restore (items 117 / 118)', () => {
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

  it('saves and restores the real sequence: the task list is null because there is none after a reset, and usage is that of the turn after the reset', () => {
    store.appendEvents(thread(), 'session-1', parseAll())
    // The last separator is a reset. After it, there is no rewrite of the work list.
    expect(store.latestTodos('thread-1')).toBeNull()
    // There is one more turn after the reset, so there is usage.
    expect(store.latestTurnUsage('thread-1')?.cacheReadTokens).toBe(24598)
  })

  it('if only the section before a reset is saved, the second rewrite is the latest', () => {
    const events = parseAll()
    const resetAt = events.findIndex((e) => e.kind === 'conversation_reset')
    const compactAt = events.findIndex((e) => e.kind === 'context_compacted')
    store.appendEvents(thread(), 'session-1', events.slice(0, resetAt))
    const todos = store.latestTodos('thread-1')
    expect(todos?.items.map((t) => t.status)).toEqual(['completed', 'in_progress', 'pending'])
    // There is one turn after compaction, so there is usage. Cut right after compaction, there is none.
    expect(store.latestTurnUsage('thread-1')).not.toBeNull()
    db.prepare('DELETE FROM thread_events').run()
    store.appendEvents(thread(), 'session-1', events.slice(0, compactAt + 1))
    expect(store.latestTurnUsage('thread-1')).toBeNull()
    expect(store.latestTodos('thread-1')?.items).toHaveLength(3)
  })

  it('also passes the task list text through redaction; does not fail even with a broken row', () => {
    const secret = 'Bearer sk-abc123DEF456ghi789'
    store.appendEvents(thread(), 'session-1', [
      {
        id: 'x1', sessionId: 's', threadId: 'thread-1', ts: 5, actor: 'main', kind: 'tool_use',
        payload: {
          toolUseId: 'tu', name: 'n', summary: '', input: {}, truncated: false,
          todos: [{ content: `call with ${secret}`, activeForm: null, status: 'pending' }]
        }
      }
    ])
    db.prepare(
      `INSERT INTO thread_events (id, thread_id, session_id, seq, ts, kind, actor, payload, payload_bytes)
       VALUES ('broken', 'thread-1', 's', 999, 6, 'tool_use', 'main', '{not json', 9)`
    ).run()
    const todos = store.latestTodos('thread-1')
    expect(todos?.toolUseId).toBe('tu')
    expect(todos?.at).toBe(5)
    expect(JSON.stringify(todos)).not.toContain('sk-abc123DEF456ghi789')
  })
})
