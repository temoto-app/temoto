// @vitest-environment jsdom
/**
 * TODO 495 (wave 25 bundle D): the Compact button of ContextUsageDialog.
 *
 * - Pressing it sends `/compact` to that thread (the same IPC as `window.aios.threads.send`), and
 *   the dialog closes at once (owner decision: while a run is in progress, main queues it as a reservation (item 94), so the
 *   same call as an ordinary send is enough here, with no confirmation (policy 167)).
 * - Does not touch the input field's draft or attachments (`threadStore.compact`, unlike `send`, does not read the draft).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ContextBreakdownResult } from '../src/shared/context-breakdown.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const THREAD_ID = 't1'

const BREAKDOWN_RESULT: ContextBreakdownResult = {
  fresh: true,
  breakdown: {
    at: 0,
    total: 1000,
    categories: [],
    memoryFiles: []
  }
} as unknown as ContextBreakdownResult

let reactRoot: Root
let host: HTMLDivElement
let sendCalls: Array<{ threadId: string; input: unknown }>
let closed: boolean

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(async () => {
  sendCalls = []
  closed = false
  ;(window as unknown as { aios: unknown }).aios = {
    threads: {
      contextBreakdown: vi.fn(async () => BREAKDOWN_RESULT),
      send: vi.fn(async (threadId: string, input: unknown) => {
        sendCalls.push({ threadId, input })
        return { ok: true }
      })
    }
  }
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  const actual = useThreads.getState()
  useThreads.setState({
    ...actual,
    threadsById: {},
    async compact(threadId: string): Promise<void> {
      await window.aios.threads.send(threadId, { text: '/compact' })
    }
  } as never)
  host = document.createElement('div')
  document.body.appendChild(host)
  reactRoot = createRoot(host)
  const { ContextUsageDialog } = await import('../src/renderer/src/components/ContextUsageDialog.js')
  await act(async () => {
    reactRoot.render(
      createElement(ContextUsageDialog, {
        threadId: THREAD_ID,
        onClose: () => {
          closed = true
        }
      })
    )
  })
  await flush()
})

afterEach(() => {
  act(() => reactRoot.unmount())
  host.remove()
})

function compactButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('.context-dialog-compact')
  if (button === null) throw new Error('no compact button')
  return button
}

describe('Compact button of ContextUsageDialog (TODO 495)', () => {
  it('there is an English "Compact" button', () => {
    expect(compactButton().textContent).toBe('Compact')
  })

  it('pressing it sends /compact to that thread and closes the dialog', async () => {
    await act(async () => {
      compactButton().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(closed).toBe(true)
    expect(sendCalls).toEqual([{ threadId: THREAD_ID, input: { text: '/compact' } }])
  })
})
