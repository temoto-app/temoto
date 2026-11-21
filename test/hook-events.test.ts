/**
 * Hook events in the settings (item 126-3, ARCHITECTURE.md 4.6.2 (10)), and the saving, indexing, and display of the replacement of the command list (the rest of item 117, 4.5.3.1) (wave 13 bundle E).
 *
 * Owner decision (2026-09-27): **hooks are "shown in one line, and their output is not saved"**. In the midway progress (5.1.3) one line, "hook <name> (<result>)", is shown, and stdout / stderr / output are neither displayed nor saved (handled the same way as `tool_result` under constraint 10).
 *
 * **There is no real fixture** (spike 25 only recorded the shape). The rows are a synthesis built from the list of keys in spike 25's RESULTS and the zod schema of the CLI 2.1.280 binary. Neither the model nor the CLI is called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AiosEvent, HookRunPayload } from '../src/shared/agent.js'
import { parseEvent } from '../src/main/session/adapter/parse.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { foldTimeline } from '../src/renderer/src/thread/timeline.js'
import {
  buildProgressTurns,
  hookLabel,
  progressLineText
} from '../src/renderer/src/thread/progress.js'
import { dropSupersededDeltas, lastCommands } from '../src/renderer/src/thread-events.js'
import { translate } from '../src/renderer/src/i18n/index.js'

const ja = (key: string, params?: Record<string, string | number>): string => translate('ja', key, params)
const en = (key: string, params?: Record<string, string | number>): string => translate('en', key, params)

const SECRET = 'HOOK-SECRET-OUTPUT'

let counter = 0
const ctx = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  now: () => 1_700_000_000_000 + counter,
  newId: () => `e${(counter += 1)}`
}

/** Three hook lines in the shape of spike 25 (start, midway output, end). */
function hookLines(outcome = 'success', exitCode: number | undefined = 0, name = 'SessionStart:startup'): string[] {
  const common = {
    type: 'system',
    hook_id: `hook-${name}-${outcome}`,
    hook_name: name,
    hook_event: name.split(':')[0],
    uuid: '00000000-0000-4000-8000-00000000abcd',
    session_id: '00000000-0000-4000-8000-000000000001'
  }
  return [
    JSON.stringify({ ...common, subtype: 'hook_started' }),
    JSON.stringify({ ...common, subtype: 'hook_progress', stdout: SECRET, stderr: SECRET, output: SECRET }),
    JSON.stringify({
      ...common,
      subtype: 'hook_response',
      output: `${SECRET} additional context`,
      stdout: `${SECRET} stdout`,
      stderr: `${SECRET} stderr`,
      ...(exitCode === undefined ? {} : { exit_code: exitCode }),
      outcome
    })
  ]
}

function parse(lines: readonly string[]): AiosEvent[] {
  return lines.flatMap((line) => [...parseEvent(line, ctx)])
}

function userText(text: string): AiosEvent {
  counter += 1
  return {
    id: `u${counter}`,
    sessionId: 'session-1',
    threadId: 'thread-1',
    ts: 1_700_000_000_000 + counter,
    actor: 'main',
    kind: 'user_text',
    payload: { text }
  }
}

describe('ThreadStore — hook の行と一覧の差し替えの保存 (第 13 波 束 E)', () => {
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

  const thread = () => {
    const found = store.getThread('thread-1')
    if (found === null) throw new Error('no thread')
    return found
  }

  it('hook の 3 行は 1 行だけ保存され、DB のどこにも出力 (stdout / stderr / output) が残らない', () => {
    store.appendEvents(thread(), 'session-1', [userText('こんにちは'), ...parse(hookLines())])
    const rows = db.prepare('SELECT kind, payload FROM thread_events ORDER BY rowid').all() as {
      kind: string
      payload: string
    }[]
    expect(rows.map((r) => r.kind)).toEqual(['user_text', 'hook_run'])
    for (const row of rows) expect(row.payload).not.toContain(SECRET)
    // It does not become the old path in which the raw line remains as `unknown` (TODO 126 item 3).
    expect(rows.some((r) => r.kind === 'unknown')).toBe(false)

    const restored = store.readTimeline('thread-1').find((e) => e.kind === 'hook_run')
    expect(restored?.kind === 'hook_run' && restored.payload).toEqual({
      hookId: 'hook-SessionStart:startup-success',
      hookName: 'SessionStart:startup',
      hookEvent: 'SessionStart',
      outcome: 'success',
      exitCode: 0
    })
  })

  it('payload に余計な欄が紛れても保存の門 (toPersistable) は列挙した欄しか写さない', () => {
    const [event] = parse(hookLines().slice(2))
    if (event?.kind !== 'hook_run') throw new Error('no hook_run')
    const smuggled = { ...event, payload: { ...event.payload, stdout: SECRET } } as unknown as AiosEvent
    store.appendEvents(thread(), 'session-1', [smuggled])
    const payload = (db.prepare("SELECT payload FROM thread_events WHERE kind = 'hook_run'").get() as {
      payload: string
    }).payload
    expect(payload).not.toContain(SECRET)
    expect(Object.keys(JSON.parse(payload) as object).sort()).toEqual(
      ['exitCode', 'hookEvent', 'hookId', 'hookName', 'outcome'].sort()
    )
  })

  it('hook の行も一覧の差し替えも会話索引に載らない (本文ではない)', () => {
    const changed = parseEvent(
      JSON.stringify({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'compact' }] }),
      ctx
    )
    store.appendEvents(thread(), 'session-1', [userText('索引に載る'), ...parse(hookLines()), ...changed])
    const indexable = store.indexableEvents()
    expect(indexable).toHaveLength(1)
    const ids = store.readTimeline('thread-1').filter((e) => e.kind !== 'user_text').map((e) => e.id)
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(store.eventText(id)).toBeNull()
  })

  it('一覧の差し替えは名前だけを保存し、復元した列の lastCommands が session_started より後のこれを採る', () => {
    const started: AiosEvent = {
      id: 's1',
      sessionId: 'session-1',
      threadId: 'thread-1',
      ts: 1_700_000_000_000,
      actor: 'main',
      kind: 'session_started',
      payload: {
        backendSessionId: 'b1',
        backendVersion: '2.1.280',
        model: null,
        cwd: null,
        reportedPermissionMode: null,
        tools: [],
        toolServers: [],
        resumed: false,
        commands: ['compact', 'cost']
      }
    }
    const changed = parseEvent(
      JSON.stringify({
        type: 'system',
        subtype: 'commands_changed',
        commands: [
          { name: 'compact', description: 'SECRET-DESCRIPTION' },
          { name: 'new-skill', description: 'x', argumentHint: '<a>' }
        ]
      }),
      ctx
    )
    store.appendEvents(thread(), 'session-1', [started, ...changed])
    const payload = (db.prepare("SELECT payload FROM thread_events WHERE kind = 'commands_changed'").get() as {
      payload: string
    }).payload
    expect(JSON.parse(payload)).toEqual({ commands: ['compact', 'new-skill', 'cost'] })
    expect(payload).not.toContain('SECRET-DESCRIPTION')
    expect(lastCommands(store.readTimeline('thread-1'))).toEqual(['compact', 'new-skill', 'cost'])
  })
})

describe('途中経過の hook の行 (5.1.3、第 13 波 束 E)', () => {
  it('ターンの途中経過に「hook <名前> (<結果>)」を 1 行出す。資料の数には数えない', () => {
    counter = 0
    const events = [userText('やって'), ...parse(hookLines())]
    const [turn] = buildProgressTurns(events, ja)
    expect(turn?.lines).toHaveLength(1)
    const line = turn!.lines[0]!
    expect(line.kind).toBe('hook')
    expect(line.href).toBeNull()
    expect(progressLineText(ja, line)).toBe('hook SessionStart:startup (成功)')
    expect(turn?.referenced).toBe(0)
    // A position (where it is drawn) does not move for hooks, since they do not have their own line in the timeline.
    expect(turn?.afterId).toBe(events[0]!.id)
  })

  it('同じ名前・同じ結果の hook (設定と個人設定の両方の SessionStart) は畳んで数える。結果が違えば別の行', () => {
    counter = 0
    const events = [
      userText('やって'),
      ...parse(hookLines()),
      ...parse(hookLines()),
      ...parse(hookLines('error', 2))
    ]
    const [turn] = buildProgressTurns(events, ja)
    expect(turn?.lines.map((line) => progressLineText(ja, line))).toEqual([
      'hook SessionStart:startup (成功) ×2',
      'hook SessionStart:startup (失敗、終了 2)'
    ])
  })

  it('結果の言い方 (EN / JA): 失敗で終了コードが無い・取り消し・表に無い結果', () => {
    const base: HookRunPayload = {
      hookId: null,
      hookName: 'Setup',
      hookEvent: 'Setup',
      outcome: 'success',
      exitCode: null
    }
    expect(hookLabel(ja, { ...base, outcome: 'error' })).toBe('hook Setup (失敗)')
    expect(hookLabel(ja, { ...base, outcome: 'cancelled' })).toBe('hook Setup (取り消し)')
    expect(hookLabel(ja, { ...base, outcome: 'other' })).toBe('hook Setup (終了)')
    expect(hookLabel(en, base)).toBe('Hook Setup (succeeded)')
    expect(hookLabel(en, { ...base, outcome: 'error', exitCode: 1 })).toBe('Hook Setup (failed, exit 1)')
  })

  it('タイムラインには行を作らず、受信中の本文も空に戻さない (delta を捨てる集合は変えない — 項目 88)', () => {
    counter = 0
    const delta: AiosEvent = {
      id: 'd1',
      sessionId: 'session-1',
      threadId: 'thread-1',
      ts: 1_700_000_000_500,
      actor: 'main',
      kind: 'assistant_delta',
      payload: { text: '途中' }
    }
    const events = [userText('やって'), delta, ...parse(hookLines())]
    const folded = foldTimeline(events)
    expect(folded.items.map((item) => item.kind)).toEqual(['user'])
    expect(folded.streaming).toBe('途中')
    // A hook line is not a "final version", so the earlier delta is not discarded (the same handling as fold).
    expect(dropSupersededDeltas(events)).toBe(events)
  })
})
