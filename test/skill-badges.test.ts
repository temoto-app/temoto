/**
 * TODO 1100: skill badges at the head of a response turn.
 *
 * - Interpretation: from one real turn (`test/fixtures/skill-use.jsonl`, captured with CLI 2.1.317 on 2026-11-03, with only the path, id, and signature replaced; system/init holds the user's list, so it is not included), a neutral `skill` is attached to the skill invocation.
 * - Saving: `skill` survives `ThreadStore.toPersistable`, and the contents of `tool_result` do not (constraint 10).
 * - Folding: `foldTimeline` -> `skillBadgesByTurn` puts the badges on the first line of the turn's response.
 * - Lookup: `findSkillEntry` finds the body file (one line of the skill list) from the badge's name.
 * - Rendering is in `test/skill-badges-render.test.ts` (jsdom).
 *
 * Neither the real CLI nor a model is called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AiosEvent, ToolUsePayload } from '../src/shared/agent.js'
import type { SkillEntry } from '../src/shared/skills.js'
import { parseEvent, toolUsePayload } from '../src/main/session/adapter/parse.js'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import { foldTimeline, type TimelineItem } from '../src/renderer/src/thread/timeline.js'
import { findSkillEntry, skillBadgesByTurn } from '../src/renderer/src/thread/skills.js'

const TOOL_ID = 'toolu_01SkillFixture0003'

let counter = 0
const ctx = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  now: () => 1_700_000_000_000 + counter * 1000,
  newId: () => `e${(counter += 1)}`
}

function fixtureEvents(): AiosEvent[] {
  return readFileSync(new URL('./fixtures/skill-use.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => [...parseEvent(line, ctx)])
}

function userText(id: string, text: string): AiosEvent {
  return { id, sessionId: 'session-1', threadId: 'thread-1', ts: 1, actor: 'main', kind: 'user_text', payload: { text } }
}

function toolUse(id: string, payload: ToolUsePayload): AiosEvent {
  return { id, sessionId: 'session-1', threadId: 'thread-1', ts: 2, actor: 'main', kind: 'tool_use', payload }
}

function assistant(id: string, text: string): AiosEvent {
  return { id, sessionId: 'session-1', threadId: 'thread-1', ts: 3, actor: 'main', kind: 'assistant_text', payload: { text } }
}

describe('parseEvent - skill invocation (TODO 1100, the real fixture)', () => {
  it('a neutral skill is attached to a skill tool_use (the tool name does not leave the adapter)', () => {
    const events = fixtureEvents()
    const uses = events.filter((e): e is Extract<AiosEvent, { kind: 'tool_use' }> => e.kind === 'tool_use')
    expect(uses).toHaveLength(1)
    expect(uses[0]!.actor).toBe('main')
    expect(uses[0]!.payload.toolUseId).toBe(TOOL_ID)
    expect(uses[0]!.payload.skill).toBe('greet-check')
    // The response body and the result also come in the same turn.
    expect(events.some((e) => e.kind === 'assistant_text' && e.payload.text === 'GREETING-CHECK-OK')).toBe(true)
    const result = events.find((e) => e.kind === 'tool_result')
    expect(result?.kind === 'tool_result' && result.payload.toolUseId).toBe(TOOL_ID)
  })

  it("not attached to tools other than skill, not attached to a child's call, a leading / is dropped, and empty is not attached", () => {
    expect(toolUsePayload('Read', 't1', { file_path: '/a/b.md' }).skill).toBeUndefined()
    expect(toolUsePayload('Skill', 't2', { skill: 'greet-check' }, 'subagent').skill).toBeUndefined()
    expect(toolUsePayload('Skill', 't3', { skill: '/frontend-design' }).skill).toBe('frontend-design')
    expect(toolUsePayload('Skill', 't4', { skill: 'docs:pdf', args: 'x' }).skill).toBe('docs:pdf')
    expect(toolUsePayload('Skill', 't5', { skill: '   ' }).skill).toBeUndefined()
    expect(toolUsePayload('Skill', 't6', { skill: 3 }).skill).toBeUndefined()
  })
})

describe('ThreadStore - the source of badges survives saving (TODO 1100)', () => {
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

  it('saving and re-reading a real turn keeps the skill, and the content of the result does not remain. Collapsing shows the badge', () => {
    const thread = store.getThread('thread-1')
    if (thread === null) throw new Error('no thread')
    store.appendEvents(thread, 'session-1', [userText('u1', 'Run the aios greeting check skill.'), ...fixtureEvents()])
    const saved = store.readTimeline('thread-1')
    const use = saved.find((e) => e.kind === 'tool_use')
    expect(use?.kind === 'tool_use' && use.payload.skill).toBe('greet-check')
    const result = saved.find((e) => e.kind === 'tool_result')
    expect(result?.kind === 'tool_result' && result.payload.text).toBeUndefined()
    // The badges appear from the row list when it is opened again.
    const items = foldTimeline(saved, { live: false }).items
    const turns = skillBadgesByTurn(items)
    expect([...turns.values()]).toEqual([[{ name: 'greet-check', uri: 'file:///Users/me/project/.claude/skills/greet-check/SKILL.md' }]])
    const anchor = [...turns.keys()][0]
    expect(items.find((item) => item.id === anchor)?.kind).toBe('tool')
  })

  it("saving and re-reading keeps the URI, and the badge carries the body's path (the body does not remain)", () => {
    const thread = store.getThread('thread-1')
    if (thread === null) throw new Error('no thread')
    store.appendEvents(thread, 'session-1', [userText('u1', 'go'), ...fixtureEvents()])
    const saved = store.readTimeline('thread-1')
    expect(JSON.stringify(saved)).not.toContain('When this skill is used')
    const items = foldTimeline(saved, { live: false }).items
    expect([...skillBadgesByTurn(items).values()][0]?.[0]?.uri).toBe('file:///Users/me/project/.claude/skills/greet-check/SKILL.md')
  })
})

describe('skillBadgesByTurn (TODO 1100)', () => {
  const fold = (events: AiosEvent[]): readonly TimelineItem[] => foldTimeline(events, { live: false }).items

  it('collapsed per turn, one for the same skill, in the order first used. Not shown for turns that do not use it', () => {
    const items = fold([
      userText('u1', 'one'),
      assistant('a1', 'let me look'),
      toolUse('t1', toolUsePayload('Skill', 'tu1', { skill: 'pdf' })),
      toolUse('t2', toolUsePayload('Skill', 'tu2', { skill: 'docs:docx' })),
      toolUse('t3', toolUsePayload('Skill', 'tu3', { skill: 'pdf' })),
      userText('u2', 'two'),
      assistant('a2', 'no skills here'),
      userText('u3', 'three'),
      toolUse('t4', toolUsePayload('Skill', 'tu4', { skill: 'pdf' }))
    ])
    const turns = skillBadgesByTurn(items)
    expect([...turns.entries()]).toEqual([
      ['a1', [{ name: 'pdf' }, { name: 'docs:docx' }]],
      ['t4', [{ name: 'pdf' }]]
    ])
  })

  it("attached to the first answer's row even at the head where the user's message is not loaded (before read more)", () => {
    const items = fold([assistant('a0', 'older half'), toolUse('t1', toolUsePayload('Skill', 'tu1', { skill: 'x' }))])
    expect([...skillBadgesByTurn(items).entries()]).toEqual([['a0', [{ name: 'x' }]]])
  })

  it('empty for a column without skills', () => {
    const items = fold([userText('u1', 'q'), toolUse('t1', toolUsePayload('Read', 'tu1', { file_path: '/a' }))])
    expect(skillBadgesByTurn(items).size).toBe(0)
  })
})

const entry = (patch: Partial<SkillEntry>): SkillEntry => ({
  name: 'x',
  dirName: 'x',
  description: '',
  scope: 'user',
  pluginName: null,
  uri: 'file:///x/SKILL.md',
  linked: false,
  readOnly: false,
  ...patch
})

describe('findSkillEntry (TODO 1100)', () => {
  const entries = [
    entry({ name: 'pdf', dirName: 'pdf', scope: 'user', uri: 'file:///u/pdf/SKILL.md' }),
    entry({ name: 'pdf', dirName: 'pdf', scope: 'project', uri: 'file:///p/pdf/SKILL.md' }),
    entry({ name: 'Doc Writer', dirName: 'docx', scope: 'plugin', pluginName: 'docs', uri: 'file:///pl/docs/docx/SKILL.md', readOnly: true }),
    entry({ name: 'shared', dirName: 'shared', scope: 'plugin', pluginName: 'a', uri: 'file:///pl/a/shared/SKILL.md' }),
    entry({ name: 'shared', dirName: 'shared', scope: 'plugin', pluginName: 'b', uri: 'file:///pl/b/shared/SKILL.md' })
  ]

  it('the same name prefers the project', () => {
    expect(findSkillEntry(entries, 'pdf')?.uri).toBe('file:///p/pdf/SKILL.md')
  })

  it("<plugin>:<skill> is looked up by the plugin's name and the skill's name or directory name", () => {
    expect(findSkillEntry(entries, 'docs:docx')?.uri).toBe('file:///pl/docs/docx/SKILL.md')
    expect(findSkillEntry(entries, 'docs:Doc Writer')?.uri).toBe('file:///pl/docs/docx/SKILL.md')
    expect(findSkillEntry(entries, 'a:shared')?.uri).toBe('file:///pl/a/shared/SKILL.md')
  })

  it('a plugin skill without a prefix only when unique. null if not found', () => {
    expect(findSkillEntry(entries, 'docx')?.uri).toBe('file:///pl/docs/docx/SKILL.md')
    expect(findSkillEntry(entries, 'shared')).toBeNull()
    expect(findSkillEntry(entries, 'bundled-only')).toBeNull()
  })
})

describe('the row that pours in the skill body (TODO 1105, the real fixture)', () => {
  const URI = 'file:///Users/me/project/.claude/skills/greet-check/SKILL.md'

  it("a user row with isSynthetic does not become an echo (user_replay) but a skill_loaded with only the body's URI", () => {
    const events = fixtureEvents()
    expect(events.some((e) => e.kind === 'user_replay')).toBe(false)
    const loaded = events.filter((e): e is Extract<AiosEvent, { kind: 'skill_loaded' }> => e.kind === 'skill_loaded')
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.payload).toEqual({ uri: URI })
    // The body is not included.
    expect(JSON.stringify(loaded[0])).not.toContain('When this skill is used')
  })

  it('a user row without the marker is an echo as before, and a row of a different shape shows nothing', () => {
    const line = (extra: Record<string, unknown>, text: string): string =>
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        uuid: 'u-1',
        session_id: 's',
        parent_tool_use_id: null,
        ...extra
      })
    expect([...parseEvent(line({}, 'hello'), ctx)].map((e) => e.kind)).toEqual(['user_replay'])
    expect([...parseEvent(line({ isSynthetic: true }, 'Base directory for this skill: relative/dir\nx'), ctx)]).toEqual([])
    expect([...parseEvent(line({ isSynthetic: true }, 'something else'), ctx)]).toEqual([])
  })
})

describe('where skill_loaded attaches (TODO 1105 review)', () => {
  const ev = (id: string, kind: string, payload: unknown): AiosEvent =>
    ({ id, sessionId: 'session-1', threadId: 'thread-1', ts: 1, actor: 'main', kind, payload }) as AiosEvent
  const result = (id: string, toolUseId: string, ok: boolean): AiosEvent => ev(id, 'tool_result', { toolUseId, ok, bytes: 3 })
  const loaded = (id: string, uri: string): AiosEvent => ev(id, 'skill_loaded', { uri })
  const skill = (id: string, tuid: string, name: string): AiosEvent => toolUse(id, toolUsePayload('Skill', tuid, { skill: name }))
  const uris = (events: AiosEvent[]): (string | undefined)[] =>
    foldTimeline(events, { live: false }).items.flatMap((i) => (i.kind === 'tool' ? [i.skillUri] : []))

  it('not attached to the errored a, and attached to the successful b', () => {
    expect(
      uris([
        skill('t1', 'a', 'a'),
        result('r1', 'a', false),
        skill('t2', 'b', 'b'),
        result('r2', 'b', true),
        loaded('l1', 'file:///x/b/SKILL.md')
      ])
    ).toEqual([undefined, 'file:///x/b/SKILL.md'])
  })

  it('if there was no earlier skill invocation it attaches to nothing, and a second one after attaching does not attach either', () => {
    expect(uris([toolUse('t1', toolUsePayload('Read', 'r', { file_path: '/a' })), result('r1', 'r', true), loaded('l1', 'file:///x')])).toEqual([
      undefined
    ])
    expect(
      uris([skill('t1', 'a', 'a'), result('r1', 'a', true), loaded('l1', 'file:///x/1'), loaded('l2', 'file:///x/2')])
    ).toEqual(['file:///x/1'])
  })

  it('even with the same name each turn has its own URI', () => {
    const items = foldTimeline(
      [
        userText('u1', 'one'),
        skill('t1', 'a', 'dup'),
        result('r1', 'a', true),
        loaded('l1', 'file:///one/SKILL.md'),
        userText('u2', 'two'),
        skill('t2', 'b', 'dup'),
        result('r2', 'b', true),
        loaded('l2', 'file:///two/SKILL.md')
      ],
      { live: false }
    ).items
    expect([...skillBadgesByTurn(items).values()]).toEqual([
      [{ name: 'dup', uri: 'file:///one/SKILL.md' }],
      [{ name: 'dup', uri: 'file:///two/SKILL.md' }]
    ])
  })

  it('a synthetic row with tool_result still produces tool_result as before', () => {
    const line = JSON.stringify({
      type: 'user',
      isSynthetic: true,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu9', content: 'ok' }] },
      uuid: 'u-9',
      session_id: 's',
      parent_tool_use_id: null
    })
    expect([...parseEvent(line, ctx)].map((e) => e.kind)).toEqual(['tool_result'])
  })

  it('persistence does not keep URIs other than file:', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const store = new ThreadStore(db, '/Users/tester')
    store.createThread({ id: 'thread-1', title: 't', cwd: '/Users/tester/work', allowedDirs: [], retention: 'forever', backend: 'agent-cli', modelId: null, thinking: null })
    const thread = store.getThread('thread-1')!
    store.appendEvents(thread, 'session-1', [loaded('l1', 'file:///ok/SKILL.md'), loaded('l2', 'https://evil/x')])
    expect(store.readTimeline('thread-1').flatMap((e) => (e.kind === 'skill_loaded' ? [e.payload.uri] : []))).toEqual(['file:///ok/SKILL.md'])
    db.close()
  })
})
