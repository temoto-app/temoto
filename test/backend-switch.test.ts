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
    capabilities: { approval: true, subagents: true, rewind: true, mcp: true, instructions: true },
    degradations: [],
    commands: null,
    ...extra
  }
}

const fresh = { backend: 'a', lastEventAt: null, transcriptOrigin: null, forkedFrom: null }

describe('backendSwitchKind / canSwitchBackendInPlace', () => {
  it('the same backend is same, before sending it is in place, and after sending it is a fork', () => {
    expect(backendSwitchKind(fresh, 'a')).toBe('same')
    expect(backendSwitchKind(fresh, 'b')).toBe('in-place')
    expect(backendSwitchKind({ ...fresh, lastEventAt: 1 }, 'b')).toBe('fork')
  })

  it('a conversation continued from a transcript or a rewind fork is not switched even before sending; the 961 handover may be switched', () => {
    expect(canSwitchBackendInPlace({ ...fresh, transcriptOrigin: { fork: false } })).toBe(false)
    expect(canSwitchBackendInPlace({ ...fresh, forkedFrom: { threadId: 't', eventId: 'e', files: false } })).toBe(false)
    expect(
      canSwitchBackendInPlace({ ...fresh, forkedFrom: { threadId: 't', eventId: 'e', files: false, handoff: true } })
    ).toBe(true)
  })
})

describe('modelMenuEntries (grouped display)', () => {
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

  it('puts its own rows first and continues with models of other usable backends as 「バックエンド › モデル」', () => {
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

  it('TODO 1026: does not hide unusable backends and shows a name-only unselectable row + a reason (message)', () => {
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

  it('TODO 1026: a rewind fork is not in-place even before sending and is fork (the row gets 「新しいスレッドで続ける」)', () => {
    const rewound = { backend: 'a', lastEventAt: null, transcriptOrigin: null, forkedFrom: { threadId: 't', eventId: 'e', files: false } }
    expect(backendSwitchKind(rewound, 'b')).toBe('fork')
  })

  it('if not sent yet, a cross-backend row is in-place', () => {
    const entries = modelMenuEntries({ backends, currentBackendId: 'b', own: [], value: null, crossKind: 'in-place' })
    expect(entries.map((e) => [e.backendId, e.modelId, e.kind])).toEqual([
      ['a', 'a1', 'in-place'],
      ['a', 'a2', 'in-place'],
      ['c', null, 'in-place'],
      ['d', null, 'in-place']
    ])
  })

  it('no heading when no other backend is usable (the appearance as before)', () => {
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

describe('settingsNoteShowsThinking (addendum to 1017)', () => {
  it('not written for backends without thinking stages; written when unknown', () => {
    const list = [backend('a', 'A'), backend('b', 'B', { thinkingLevel: false })]
    expect(settingsNoteShowsThinking(list, 'a')).toBe(true)
    expect(settingsNoteShowsThinking(list, 'b')).toBe(false)
    expect(settingsNoteShowsThinking(list, 'z')).toBe(true)
    expect(settingsNoteShowsThinking(null, 'b')).toBe(true)
    expect(settingsNoteShowsThinking(list, undefined)).toBe(true)
  })
})

describe('buildHandoffText preface (TODO 1018)', () => {
  const turns = [{ number: 1, question: { id: 'q1', text: 'Q1', attachments: [] }, answers: ['A1'] }]
  it('a fork to another backend differs only by one sentence of the preface and the 961 sentence is unchanged', () => {
    const lighten = buildHandoffText(turns as never, 'T').text
    const switched = buildHandoffText(turns as never, 'T', 'switch-backend').text
    expect(lighten).toContain('into this new conversation to save context.')
    expect(switched).toContain('different coding agent')
    expect(switched).not.toContain('to save context')
    expect(switched).toContain('Q1')
    expect(switched).toContain('A1')
  })
})
