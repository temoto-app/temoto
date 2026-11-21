// @vitest-environment jsdom
/**
 * Recording auto-pick of recommendations (TODO 1230): persistence (redaction and truncation in `ThreadStore.toPersistable`) and the question badge in the timeline.
 * - The event of an automatically picked question keeps a mark, the choices, the position of the recommendation, and the position picked. The badge shows "auto-picked" and the list of choices.
 * - A question answered by hand shows neither the mark nor the list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import Database from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { ThreadStore } from '../src/main/session/store.js'
import type { AiosEvent, ApprovalOutcome } from '../src/shared/agent.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const outcome = (over: Partial<Extract<ApprovalOutcome, { kind: 'allowed' }>> = {}): ApprovalOutcome => ({
  kind: 'allowed',
  by: 'user',
  answer: 'どれ? → A (推奨)',
  autoPicked: true,
  autoPick: { question: 'どれ?', options: ['A (推奨)', 'B'], recommended: 0, chosen: 0, waitedMs: 5000 },
  ...over
})

function permissionEvent(id: string, out: ApprovalOutcome): AiosEvent {
  return {
    id,
    sessionId: 's',
    threadId: 'th',
    ts: Date.now(),
    actor: 'main',
    kind: 'permission_request',
    payload: { requestId: id, toolUseId: null, toolName: 'Ask', summary: '', input: {}, requestedAt: 1, decidedAt: 2, outcome: out }
  } as AiosEvent
}

describe('persistence', () => {
  it('the mark, options, and position remain, and strings go through redaction', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const store = new ThreadStore(db, '/Users/tester')
      const thread = store.createThread({
        id: 'th',
        title: 't',
        cwd: '/Users/tester/w',
        allowedDirs: ['/Users/tester/w'],
        retention: 'forever',
        backend: 'agent-cli',
        modelId: null,
        thinking: null
      })
      const secret = 'sk-ant-api03-' + 'A'.repeat(40)
      store.appendEvents(thread, 's', [
        permissionEvent('e1', outcome()),
        permissionEvent('e2', outcome({ autoPick: { question: 'q', options: [secret, 'B'], recommended: 0, chosen: 9, waitedMs: 1 } })),
        permissionEvent('e3', { kind: 'allowed', by: 'user', answer: 'どれ? → B' })
      ])
      const rows = store.readTimeline('th')
      const get = (id: string): ApprovalOutcome => {
        const row = rows.find((r) => r.id === id)
        if (row?.kind !== 'permission_request') throw new Error('missing')
        return row.payload.outcome
      }
      const first = get('e1')
      expect(first).toMatchObject({ autoPicked: true, autoPick: { options: ['A (推奨)', 'B'], recommended: 0, chosen: 0 } })
      const second = get('e2')
      expect(JSON.stringify(second)).not.toContain(secret)
      // Keep an out-of-range position inside the choices
      expect(second.kind === 'allowed' ? second.autoPick?.chosen : -1).toBe(1)
      // Something answered by hand has neither mark nor record
      const manual = get('e3')
      expect(manual.kind === 'allowed' && manual.autoPicked).toBeFalsy()
      expect(manual.kind === 'allowed' && manual.autoPick).toBeFalsy()
    } finally {
      db.close()
    }
  })
})

describe("the timeline's question label", () => {
  let root: Root
  let host: HTMLDivElement
  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const render = async (value: ApprovalOutcome): Promise<void> => {
    const { OutcomeLabel } = await import('../src/renderer/src/components/ThreadPane.js')
    act(() => root.render(createElement(OutcomeLabel, { outcome: value, requestedAt: 0 })))
  }

  it('an automatically chosen question shows 「自動で選択」 with the question, options, recommendation, and chosen answer', async () => {
    await render(outcome())
    const record = host.querySelector('[data-testid="auto-pick-record"]')
    expect(record).not.toBeNull()
    expect(record?.textContent).toContain('どれ?')
    expect(record?.textContent).toContain('A (推奨)')
    expect(record?.textContent).toContain('B')
    expect(record?.querySelector('li.chosen')?.textContent).toContain('A (推奨)')
    expect(host.textContent).toMatch(/Auto-selected|自動で選択/)
  })

  it('does not appear on a question answered by hand', async () => {
    await render({ kind: 'allowed', by: 'user', answer: 'どれ? → B' })
    expect(host.querySelector('[data-testid="auto-pick-record"]')).toBeNull()
    expect(host.textContent).not.toMatch(/Auto-selected|自動で選択/)
  })
})
