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

describe('ツール名 → 種別の対応表 (制約 6: 表は compat/ にだけ置く)', () => {
  it('web 検索は検索語を出す', () => {
    expect(toolProgressHint('WebSearch', { query: '日本語 形態素解析' })).toEqual({
      kind: 'search',
      label: '日本語 形態素解析'
    })
  })

  it('リンク取得は URL を「ホスト名 + 末尾」に縮め、行き先として URL を持つ', () => {
    const hint = toolProgressHint('WebFetch', { url: 'https://example.com/a/b/page.html' })
    expect(hint).toEqual({
      kind: 'fetch',
      label: 'example.com/…/page.html',
      href: 'https://example.com/a/b/page.html'
    })
  })

  it('http(s) でない URL は押せない (行き先を付けない)', () => {
    const hint = toolProgressHint('WebFetch', { url: 'ftp://example.com/x' })
    expect(hint?.href).toBeUndefined()
  })

  it('ファイル読みは「親ディレクトリ名/ファイル名」まで。行き先は file: URI', () => {
    const hint = toolProgressHint('Read', { file_path: '/Users/x/docs/報告 書.md' })
    expect(hint?.kind).toBe('file')
    expect(hint?.label).toBe('docs/報告 書.md')
    // **The path itself is not shown to the renderer** (only the URI).
    expect(hint?.label.includes('/Users/')).toBe(false)
    expect(hint?.href).toBe('file:///Users/x/docs/%E5%A0%B1%E5%91%8A%20%E6%9B%B8.md')
  })

  it('相対パスは開き先を推測しない (押せない行として名前だけ出す)', () => {
    const hint = toolProgressHint('Read', { file_path: 'docs/a.md' })
    expect(hint).toEqual({ kind: 'file', label: 'docs/a.md' })
  })

  it('サブエージェントは定型文 (発言は流れてこない — Phase 2 の実測)', () => {
    expect(toolProgressHint('Task', { subagent_type: 'explore' })).toEqual({
      kind: 'other',
      label: 'サブエージェントが作業中'
    })
  })

  it('項目 93: 子エージェントのツールの新しい名前 (Agent) も同じ定型文になる', () => {
    expect(toolProgressHint('Agent', { description: 'x', subagent_type: 'general-purpose' })).toEqual({
      kind: 'other',
      label: 'サブエージェントが作業中'
    })
  })

  it('表に無いツールは label の無い other (renderer で 1 行に畳まれる)', () => {
    expect(toolProgressHint('Bash', { command: 'ls' })).toEqual({ kind: 'other', label: '' })
  })

  it('URL の短縮とパスの末尾取りは単体でも成り立つ', () => {
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
  it('ターンは user_text で切れる。過去のターンの一覧はそのまま残る', () => {
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

  it('畳まれるイベント (tool_result) は描画位置にしない', () => {
    const turns = buildProgressTurns([
      ev({ id: 'u1', kind: 'user_text', payload: { text: 'x' } }),
      tool('Read', file('docs/a.md', 'file:///docs/a.md'), 't1'),
      ev({ id: 'tr', kind: 'tool_result', payload: { toolUseId: 'tu-t1', ok: true, bytes: 3 } })
    ])
    expect(turns[0]!.afterId).toBe('t1')
  })

  it('同じものは 1 行に畳み、回数を数える (位置は最初に出た場所のまま)', () => {
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

  it('表示文字列を持たない other は「ほか N 件の操作」に畳む', () => {
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

  it('progress を持たない古い行 (この機能より前の保存) も畳むだけで壊れない', () => {
    const turns = buildProgressTurns([
      ev({ id: 'u1', kind: 'user_text', payload: { text: 'x' } }),
      tool('Read', undefined, 't1')
    ])
    expect(turns[0]!.lines.map((l) => l.label)).toEqual(['ほか 1 件の操作'])
  })

  it('最新 N 行で打ち切る。消えるのは古い方 (最後の行 = スピナーの居場所は残る)', () => {
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

  it('同じ列を渡せば同じ結果になる (応答中と確定後で一覧が食い違わない)', () => {
    const events = [
      ev({ id: 'u1', kind: 'user_text', payload: { text: 'x' } }),
      tool('Read', file('docs/a.md', 'file:///docs/a.md'), 't1')
    ]
    expect(buildProgressTurns(events)).toEqual(buildProgressTurns(events))
  })

  it('行き先はそのまま渡す (file: は ViewerPane、http(s) は外部ブラウザ)', () => {
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
