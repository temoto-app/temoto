/**
 * TODO 1018: the group display "backend > model" in the Model picker, and the judgment of selections across backends (pure functions).
 * The paths through the manager (switch in place; or branch and attach the transcript) are "TODO 1018" in `test/session-manager.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { backendSwitchKind, canSwitchBackendInPlace } from '../src/shared/backend-switch.js'
import {
  groupedModelLabel,
  modelMenuEntries,
  settingsNoteShowsThinking
} from '../src/renderer/src/composer-choice.js'
import { buildHandoffText } from '../src/shared/handoff.js'
import type { BackendChoice } from '../src/shared/thread.js'

function backend(id: string, label: string, extra: Partial<BackendChoice> = {}): BackendChoice {
  return {
    id,
    label,
    available: true,
    message: null,
    models: [],
    modelSelect: true,
    thinkingLevel: true,
    rewind: true,
    capabilities: { approval: true, subagents: true, rewind: true, mcp: true },
    degradations: [],
    commands: null,
    ...extra
  }
}

const fresh = { backend: 'a', lastEventAt: null, transcriptOrigin: null, forkedFrom: null }

describe('backendSwitchKind / canSwitchBackendInPlace', () => {
  it('同じバックエンドは same、送る前はその場、送った後は分岐', () => {
    expect(backendSwitchKind(fresh, 'a')).toBe('same')
    expect(backendSwitchKind(fresh, 'b')).toBe('in-place')
    expect(backendSwitchKind({ ...fresh, lastEventAt: 1 }, 'b')).toBe('fork')
  })

  it('転写から続けた・巻き戻しの分岐は送る前でも替えない。961 の引き継ぎは替えてよい', () => {
    expect(canSwitchBackendInPlace({ ...fresh, transcriptOrigin: { fork: false } })).toBe(false)
    expect(canSwitchBackendInPlace({ ...fresh, forkedFrom: { threadId: 't', eventId: 'e', files: false } })).toBe(false)
    expect(
      canSwitchBackendInPlace({ ...fresh, forkedFrom: { threadId: 't', eventId: 'e', files: false, handoff: true } })
    ).toBe(true)
  })
})

describe('modelMenuEntries (グループ表示)', () => {
  const backends = [
    backend('a', 'Agent A', { models: [{ id: 'a1', label: 'A1' }, { id: 'a2', label: 'A2', pinned: true }] }),
    backend('b', 'Agent B', {
      models: [
        { id: 'b1', label: 'B1' },
        { id: 'b2', label: 'B2', unavailable: true }
      ]
    }),
    backend('c', 'Agent C', { available: false, models: [{ id: 'c1', label: 'C1' }] }),
    backend('d', 'Agent D', { modelSelect: false })
  ]

  it('自分の行を先に、他の使えるバックエンドのモデルを「バックエンド › モデル」で続ける', () => {
    const entries = modelMenuEntries({
      backends,
      currentBackendId: 'a',
      own: backends[0]!.models,
      value: 'a2',
      crossKind: 'fork'
    })
    expect(entries.map((e) => groupedModelLabel(e.backendLabel, e.modelLabel))).toEqual([
      'Agent A › A1',
      'Agent A › A2',
      'Agent B › B1',
      'Agent C',
      'Agent D'
    ])
    expect(entries.map((e) => e.kind)).toEqual(['same', 'same', 'fork', 'fork', 'fork'])
    expect(entries.find((e) => e.checked)?.modelId).toBe('a2')
    expect(entries[4]).toMatchObject({ backendId: 'd', modelId: null })
  })

  it('TODO 1026: 使えないバックエンドは隠さず、名前だけの選べない行 + 理由 (message) で出す', () => {
    const list = [
      backends[0]!,
      backend('c', 'Agent C', { available: false, message: 'Not installed', models: [{ id: 'c1', label: 'C1' }] }),
      backend('e', 'Agent E', { available: false, message: null })
    ]
    const entries = modelMenuEntries({ backends: list, currentBackendId: 'a', own: [], value: null, crossKind: 'fork' })
    expect(entries.map((e) => [e.backendId, e.modelId, e.unavailable, e.backendReason])).toEqual([
      ['c', null, true, 'Not installed'],
      ['e', null, true, null]
    ])
    // A row for a usable backend has no reason field.
    const ok = modelMenuEntries({ backends, currentBackendId: 'b', own: [], value: null, crossKind: 'fork' })
    expect(ok.find((e) => e.backendId === 'a')?.backendReason).toBeUndefined()
  })

  it('TODO 1026: 巻き戻しの分岐は送る前でも in-place にならず fork (行に「新しいスレッドで続ける」が付く)', () => {
    const rewound = { backend: 'a', lastEventAt: null, transcriptOrigin: null, forkedFrom: { threadId: 't', eventId: 'e', files: false } }
    expect(backendSwitchKind(rewound, 'b')).toBe('fork')
  })

  it('まだ送っていなければまたぐ行は in-place', () => {
    const entries = modelMenuEntries({ backends, currentBackendId: 'b', own: [], value: null, crossKind: 'in-place' })
    expect(entries.map((e) => [e.backendId, e.modelId, e.kind])).toEqual([
      ['a', 'a1', 'in-place'],
      ['a', 'a2', 'in-place'],
      ['c', null, 'in-place'],
      ['d', null, 'in-place']
    ])
  })

  it('他に使えるバックエンドが無ければ見出しを付けない (今までの見え方)', () => {
    const entries = modelMenuEntries({
      backends: [backends[0]!],
      currentBackendId: 'a',
      own: backends[0]!.models,
      value: null,
      crossKind: 'fork'
    })
    expect(entries.map((e) => groupedModelLabel(e.backendLabel, e.modelLabel))).toEqual(['A1', 'A2'])
    expect(entries.every((e) => e.kind === 'same')).toBe(true)
  })
})

describe('settingsNoteShowsThinking (1017 の追記)', () => {
  it('thinking の段階の無いバックエンドでは書かない。分からなければ書く', () => {
    const list = [backend('a', 'A'), backend('b', 'B', { thinkingLevel: false })]
    expect(settingsNoteShowsThinking(list, 'a')).toBe(true)
    expect(settingsNoteShowsThinking(list, 'b')).toBe(false)
    expect(settingsNoteShowsThinking(list, 'z')).toBe(true)
    expect(settingsNoteShowsThinking(null, 'b')).toBe(true)
    expect(settingsNoteShowsThinking(list, undefined)).toBe(true)
  })
})

describe('buildHandoffText の前置き (TODO 1018)', () => {
  const turns = [{ number: 1, question: { id: 'q1', text: 'Q1', attachments: [] }, answers: ['A1'] }]
  it('別のバックエンドへの分岐は前置きの 1 文だけ違い、961 の文は変えない', () => {
    const lighten = buildHandoffText(turns as never, 'T').text
    const switched = buildHandoffText(turns as never, 'T', 'switch-backend').text
    expect(lighten).toContain('into this new conversation to save context.')
    expect(switched).toContain('different coding agent')
    expect(switched).not.toContain('to save context')
    expect(switched).toContain('Q1')
    expect(switched).toContain('A1')
  })
})
