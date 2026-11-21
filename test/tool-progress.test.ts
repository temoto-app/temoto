/**
 * Item 259 (wave 15 bundle G): saving, memo, and display of the progress of a running tool (`tool_progress`). The regression for interpreting (parseEvent) is 'tool progress' in `test/parse-event.test.ts`.
 *
 * Owner decision (2026-09-30): interpret it and **show the elapsed seconds on the tool's row** (the form of the CLI's '(12s)'). **Not saved** (same as deltas). The items inside a child are used for the 'current activity' of the child's list. Neither a model nor the CLI is called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AiosEvent } from '../src/shared/agent.js'
import { EPHEMERAL_EVENT_KINDS } from '../src/shared/agent.js'
import type { RunningSubtask, ToolProgress } from '../src/shared/thread.js'
import { parseEvent } from '../src/main/session/adapter/parse.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { applyToolProgressEvent } from '../src/main/session/tool-progress.js'
import {
  foldTimeline,
  formatToolElapsed,
  toolProgressSeconds
} from '../src/renderer/src/thread/timeline.js'
import { translate } from '../src/renderer/src/i18n/index.js'

const TOOL = 'toolu_01AbCdEfGhIjKlMnOpQrStUv'

let counter = 0
const ctx = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  now: () => 1_700_000_000_000 + counter * 1000,
  newId: () => `e${(counter += 1)}`
}

/** Two real lines (heartbeat 300 s / 330 s). */
function fixtureEvents(): AiosEvent[] {
  return readFileSync(new URL('./fixtures/tool-progress.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => [...parseEvent(line, ctx)])
}

function event(kind: AiosEvent['kind'], payload: unknown, ts = 1_700_000_000_000): AiosEvent {
  counter += 1
  return {
    id: `x${counter}`,
    sessionId: 'session-1',
    threadId: 'thread-1',
    ts,
    actor: 'main',
    kind,
    payload
  } as unknown as AiosEvent
}

function toolUse(): AiosEvent {
  return event('tool_use', { toolUseId: TOOL, name: 'Bash', summary: 'sleep 400', input: { command: 'sleep 400' }, truncated: false })
}

function subtask(taskId: string, toolUseId: string): RunningSubtask {
  return {
    taskId,
    toolUseId,
    description: '子',
    subagentType: 'general-purpose',
    status: 'running',
    startedAt: 0,
    usage: null,
    usageAt: null,
    lastToolName: null,
    activity: null,
    model: null
  }
}

describe('ThreadStore — ツールの経過は保存しない (項目 259)', () => {
  let db: Db
  let store: ThreadStore
  beforeEach(() => {
    counter = 0
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

  it('delta と同じ永続化しない種別に入っている', () => {
    expect(EPHEMERAL_EVENT_KINDS.has('tool_progress')).toBe(true)
  })

  it('実物の 2 行は DB に 1 行も残らない (以前は unknown として残っていた)', () => {
    const thread = store.getThread('thread-1')!
    store.appendEvents(thread, 'session-1', [toolUse(), ...fixtureEvents()])
    const kinds = (db.prepare('SELECT kind FROM thread_events ORDER BY rowid').all() as { kind: string }[]).map(
      (r) => r.kind
    )
    expect(kinds).toEqual(['tool_use'])
  })
})

describe('applyToolProgressEvent — main の控え (項目 259)', () => {
  it('呼び出しごとに最後の報告だけを持ち、結果で外す', () => {
    counter = 0
    const progress = new Map<string, ToolProgress>()
    const subtasks = new Map<string, RunningSubtask>()
    const [first, second] = fixtureEvents()
    expect(applyToolProgressEvent(progress, subtasks, first!)).toBe(true)
    expect(applyToolProgressEvent(progress, subtasks, second!)).toBe(true)
    expect([...progress.values()]).toEqual([
      { toolUseId: TOOL, toolName: 'Bash', elapsedSeconds: 330, at: second!.ts }
    ])
    // A duplicate with the same value is not redistributed.
    expect(applyToolProgressEvent(progress, subtasks, second!)).toBe(false)
    // A result of another call does not clear it.
    expect(applyToolProgressEvent(progress, subtasks, event('tool_result', { toolUseId: 'other', ok: true, bytes: 0 }))).toBe(false)
    expect(applyToolProgressEvent(progress, subtasks, event('tool_result', { toolUseId: TOOL, ok: true, bytes: 3 }))).toBe(true)
    expect(progress.size).toBe(0)
  })

  it('ターンの終わり (result) で全部外す。空なら配り直さない', () => {
    counter = 0
    const progress = new Map<string, ToolProgress>()
    const subtasks = new Map<string, RunningSubtask>()
    applyToolProgressEvent(progress, subtasks, fixtureEvents()[0]!)
    expect(applyToolProgressEvent(progress, subtasks, event('result', {}))).toBe(true)
    expect(progress.size).toBe(0)
    expect(applyToolProgressEvent(progress, subtasks, event('result', {}))).toBe(false)
  })

  it('子の中のシェルの経過 (heartbeat 無し・子を起こした呼び出しの id) は子のいまの活動にする', () => {
    const progress = new Map<string, ToolProgress>()
    const subtasks = new Map<string, RunningSubtask>([['task-a', subtask('task-a', 'toolu_agent')]])
    const shell = event('tool_progress', { toolUseId: 'toolu_agent', toolName: 'Bash', elapsedSeconds: 12, heartbeat: false })
    expect(applyToolProgressEvent(progress, subtasks, shell)).toBe(true)
    expect(progress.size).toBe(0)
    expect(subtasks.get('task-a')).toMatchObject({ lastToolName: 'Bash', activity: 'Bash (12s)', description: '子' })
    expect(applyToolProgressEvent(progress, subtasks, shell)).toBe(false)
  })

  it('子を起こした呼び出しそのものの heartbeat は行の経過 (子の活動は書き換えない)', () => {
    const progress = new Map<string, ToolProgress>()
    const subtasks = new Map<string, RunningSubtask>([['task-a', subtask('task-a', 'toolu_agent')]])
    const beat = event('tool_progress', { toolUseId: 'toolu_agent', toolName: 'Agent', elapsedSeconds: 30, heartbeat: true })
    expect(applyToolProgressEvent(progress, subtasks, beat)).toBe(true)
    expect(progress.get('toolu_agent')?.elapsedSeconds).toBe(30)
    expect(subtasks.get('task-a')?.activity).toBeNull()
  })
})

describe('ツールの行の経過秒 (renderer の純関数、項目 259)', () => {
  it('報告の秒に「受けてからの時間」を足して進める (負にはしない)', () => {
    const p: ToolProgress = { toolUseId: TOOL, toolName: 'Bash', elapsedSeconds: 30, at: 10_000 }
    expect(toolProgressSeconds(p, 10_000)).toBe(30)
    expect(toolProgressSeconds(p, 12_999)).toBe(32)
    expect(toolProgressSeconds(p, 5_000)).toBe(30)
  })

  it('CLI の書き方: 12s / 1m 5s / 2m / 1h 2m / 1h', () => {
    expect(formatToolElapsed(0)).toBe('0s')
    expect(formatToolElapsed(12)).toBe('12s')
    expect(formatToolElapsed(59.9)).toBe('59s')
    expect(formatToolElapsed(65)).toBe('1m 5s')
    expect(formatToolElapsed(120)).toBe('2m')
    expect(formatToolElapsed(3_720)).toBe('1h 2m')
    expect(formatToolElapsed(3_600)).toBe('1h')
    expect(formatToolElapsed(-3)).toBe('0s')
  })

  it('表示の文言 (EN / JA)', () => {
    expect(translate('ja', 'tool.runningFor', { elapsed: '1m 5s' })).toBe('実行中 1m 5s')
    expect(translate('en', 'tool.runningFor', { elapsed: '12s' })).toBe('Running 12s')
  })

  it('タイムラインに行を作らない (「未知のイベント」も出ない)。ツールの行は結果待ちのまま', () => {
    counter = 0
    const folded = foldTimeline([toolUse(), ...fixtureEvents()])
    expect(folded.items.map((i) => i.kind)).toEqual(['tool'])
    const [tool] = folded.items
    expect(tool?.kind === 'tool' && tool.result).toBeNull()
    expect(tool?.kind === 'tool' && tool.children).toEqual([])
  })
})
