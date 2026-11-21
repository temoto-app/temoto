/**
 * Interim report "what is being looked at now" (ARCHITECTURE.md 5.1.3 / TODO 14 + 15).
 *
 * Two things are checked:
 *   1. **The table from tool name to kind** (the path where the adapter looks up `toolKinds` in `compat/claude-code.json`).
 *      It is the only place that holds backend-specific words (constraint 6).
 *   2. **Pure function from event sequence to display lines** (kind, cut-off, folding of duplicates).
 * Neither one calls the model or needs the DOM.
 */
import { describe, expect, it } from 'vitest'
import type { AiosEvent, ToolProgressHint } from '../src/shared/agent.js'
import { shortenUrl, tailLabel, toolProgressHint } from '../src/main/session/adapter/progress.js'
import {
  MAX_PROGRESS_LINES,
  buildProgressTurns as buildProgressTurnsRaw,
  progressLineText as progressLineTextRaw
} from '../src/renderer/src/thread/progress.js'
import { translate } from '../src/renderer/src/i18n/index.js'
import type { ProgressLine } from '../src/renderer/src/thread/progress.js'
import type { AiosEvent as AiosEventType } from '../src/shared/agent.js'

const t = (key: string, params?: Record<string, string | number>): string =>
  translate('ja', key, params)
const buildProgressTurns = (events: readonly AiosEventType[], limit?: number) =>
  buildProgressTurnsRaw(events, t, limit)
const progressLineText = (line: ProgressLine): string => progressLineTextRaw(t, line)

// ---- 1. Tool name → kind (adapter + compat) ----

describe('table from tool name to kind (constraint 6: the table lives only in compat/)', () => {
  it('web search yields the search term', () => {
    expect(toolProgressHint('WebSearch', { query: '日本語 形態素解析' })).toEqual({
      kind: 'search',
      label: '日本語 形態素解析'
    })
  })

  it('link fetch shortens the URL to "host name + tail" and keeps the URL as its destination', () => {
    const hint = toolProgressHint('WebFetch', { url: 'https://example.com/a/b/page.html' })
    expect(hint).toEqual({
      kind: 'fetch',
      label: 'example.com/…/page.html',
      href: 'https://example.com/a/b/page.html'
    })
  })

  it('a URL that is not http(s) cannot be clicked (no destination attached)', () => {
    const hint = toolProgressHint('WebFetch', { url: 'ftp://example.com/x' })
    expect(hint?.href).toBeUndefined()
  })

  it('file read goes up to "parent directory name/file name"; the destination is a file: URI', () => {
    const hint = toolProgressHint('Read', { file_path: '/Users/x/docs/報告 書.md' })
    expect(hint?.kind).toBe('file')
    expect(hint?.label).toBe('docs/報告 書.md')
    // **The path itself is not shown to the renderer** (only the URI).
    expect(hint?.label.includes('/Users/')).toBe(false)
    expect(hint?.href).toBe('file:///Users/x/docs/%E5%A0%B1%E5%91%8A%20%E6%9B%B8.md')
  })

  it('a relative path does not guess where to open (it shows only the name as a row that cannot be clicked)', () => {
    const hint = toolProgressHint('Read', { file_path: 'docs/a.md' })
    expect(hint).toEqual({ kind: 'file', label: 'docs/a.md' })
  })

  it('a subagent is boilerplate (its speech does not stream in; measured in Phase 2)', () => {
    expect(toolProgressHint('Task', { subagent_type: 'explore' })).toEqual({
      kind: 'other',
      label: 'サブエージェントが作業中'
    })
  })

  it('item 93: the new name of the child agent tool (Agent) also becomes the same boilerplate', () => {
    expect(toolProgressHint('Agent', { description: 'x', subagent_type: 'general-purpose' })).toEqual({
      kind: 'other',
      label: 'サブエージェントが作業中'
    })
  })

  it('a tool not in the table is other without a label (folded into one line in the renderer)', () => {
    expect(toolProgressHint('Bash', { command: 'ls' })).toEqual({ kind: 'other', label: '' })
  })

  it('URL shortening and taking the path tail also work on their own', () => {
    expect(shortenUrl('https://example.com')).toBe('example.com')
    expect(shortenUrl('https://example.com/only.html')).toBe('example.com/only.html')
    expect(shortenUrl('ちがう')).toBe('ちがう')
    expect(tailLabel('/a.md')).toBe('a.md')
    expect(tailLabel('/x/y/z.md')).toBe('y/z.md')
  })
})

// ---- 2. Event sequence → display lines (pure functions for the renderer) ----

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

function tool(name: string, progress: ToolProgressHint | undefined, id?: string): AiosEvent {
  return ev({
    ...(id === undefined ? {} : { id }),
    kind: 'tool_use',
    payload: {
      toolUseId: `tu-${id ?? name}`,
      name,
      summary: '',
      input: {},
      truncated: false,
      ...(progress === undefined ? {} : { progress })
    }
  })
}

const file = (label: string, href: string): ToolProgressHint => ({ kind: 'file', label, href })

describe('buildProgressTurns (5.1.3)', () => {
  it('turns are cut at user_text; the list of past turns stays as it is', () => {
    const turns = buildProgressTurns([
      ev({ id: 'u1', kind: 'user_text', payload: { text: '1 つ目' } }),
      tool('Read', file('docs/a.md', 'file:///docs/a.md'), 't1'),
      ev({ id: 'r1', kind: 'result', payload: { ok: true } as never }),
      ev({ id: 'u2', kind: 'user_text', payload: { text: '2 つ目' } }),
      tool('WebSearch', { kind: 'search', label: '猫' }, 't2')
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0]!.lines.map((l) => l.label)).toEqual(['docs/a.md'])
    // The drawing position is "the last event that has its own line" = result
    expect(turns[0]!.afterId).toBe('r1')
    expect(turns[1]!.lines.map((l) => l.label)).toEqual(['猫'])
  })

  it('events that are folded (tool_result) do not become a render position', () => {
    const turns = buildProgressTurns([
      ev({ id: 'u1', kind: 'user_text', payload: { text: 'x' } }),
      tool('Read', file('docs/a.md', 'file:///docs/a.md'), 't1'),
      ev({ id: 'tr', kind: 'tool_result', payload: { toolUseId: 'tu-t1', ok: true, bytes: 3 } })
    ])
    expect(turns[0]!.afterId).toBe('t1')
  })

  it('identical ones are folded into one line and counted (the position stays where it first appeared)', () => {
    const same = file('docs/a.md', 'file:///docs/a.md')
    const turns = buildProgressTurns([
      ev({ id: 'u1', kind: 'user_text', payload: { text: 'x' } }),
      tool('Read', same, 't1'),
      tool('WebSearch', { kind: 'search', label: '猫' }, 't2'),
      tool('Read', same, 't3')
    ])
    const lines = turns[0]!.lines
    expect(lines.map((l) => l.label)).toEqual(['docs/a.md', '猫'])
    expect(lines[0]!.count).toBe(2)
    expect(lines[0]!.id).toBe('t1')
    expect(progressLineText(lines[0]!)).toBe('資料: docs/a.md ×2')
    expect(progressLineText(lines[1]!)).toBe('検索: 猫')
  })

  it('other without a display string is folded into "ほか N 件の操作"', () => {
    const turns = buildProgressTurns([
      ev({ id: 'u1', kind: 'user_text', payload: { text: 'x' } }),
      tool('Bash', { kind: 'other', label: '' }, 't1'),
      tool('Bash', { kind: 'other', label: '' }, 't2'),
      tool('Task', { kind: 'other', label: 'サブエージェントが作業中' }, 't3')
    ])
    expect(turns[0]!.lines.map((l) => l.label)).toEqual([
      'サブエージェントが作業中',
      'ほか 2 件の操作'
    ])
    // For the "referenced materials (N)" count, N does not include other.
    expect(turns[0]!.referenced).toBe(0)
  })

  it('old rows without progress (saved before this feature) are only folded and do not break', () => {
    const turns = buildProgressTurns([
      ev({ id: 'u1', kind: 'user_text', payload: { text: 'x' } }),
      tool('Read', undefined, 't1')
    ])
    expect(turns[0]!.lines.map((l) => l.label)).toEqual(['ほか 1 件の操作'])
  })

  it("cuts off at the latest N rows; the old ones disappear (the last row = the spinner's place stays)", () => {
    const events: AiosEvent[] = [ev({ id: 'u1', kind: 'user_text', payload: { text: 'x' } })]
    for (let i = 0; i < MAX_PROGRESS_LINES + 3; i += 1) {
      events.push(tool('Read', file(`d/${i}.md`, `file:///d/${i}.md`), `t${i}`))
    }
    const turn = buildProgressTurns(events)[0]!
    expect(turn.lines).toHaveLength(MAX_PROGRESS_LINES)
    expect(turn.omitted).toBe(3)
    expect(turn.lines[0]!.label).toBe('d/3.md')
    expect(turn.lines[MAX_PROGRESS_LINES - 1]!.label).toBe(`d/${MAX_PROGRESS_LINES + 2}.md`)
    // The total number of references is the number of lines after folding (before cutting off).
    expect(turn.referenced).toBe(MAX_PROGRESS_LINES + 3)
  })

  it('the same input gives the same result (the list does not diverge between while responding and after it is finalized)', () => {
    const events = [
      ev({ id: 'u1', kind: 'user_text', payload: { text: 'x' } }),
      tool('Read', file('docs/a.md', 'file:///docs/a.md'), 't1')
    ]
    expect(buildProgressTurns(events)).toEqual(buildProgressTurns(events))
  })

  it('the destination is passed as it is (file: goes to ViewerPane, http(s) to the external browser)', () => {
    const turns = buildProgressTurns([
      ev({ id: 'u1', kind: 'user_text', payload: { text: 'x' } }),
      tool('Read', file('docs/a.md', 'file:///docs/a.md'), 't1'),
      tool('WebFetch', { kind: 'fetch', label: 'example.com/x', href: 'https://example.com/x' }, 't2'),
      tool('WebSearch', { kind: 'search', label: '猫' }, 't3')
    ])
    expect(turns[0]!.lines.map((l) => l.href)).toEqual([
      'file:///docs/a.md',
      'https://example.com/x',
      null
    ])
  })
})
