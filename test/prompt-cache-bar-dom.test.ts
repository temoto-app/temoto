// @vitest-environment jsdom
/**
 * Review of TODO 961: "lighten and continue in a new conversation" on the bar (`PromptCacheBar`) is not shown for a thread where the handoff text for the estimate cannot be built
 * (`handoffTokens` is 0 — retention is not kept, there are no messages). Pressing it would always give `handoff-empty`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { HANDOFF_MIN_CONVERSATION_TOKENS, offersHandoff, type HandoffEstimate } from '../src/shared/handoff.js'
import { PromptCacheBar } from '../src/renderer/src/components/PromptCacheBar.js'
import { useLocale } from '../src/renderer/src/localeStore.js'
import { useThreads } from '../src/renderer/src/threadStore.js'
import type { TimelineItem } from '../src/renderer/src/thread/timeline.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const handoffEstimate = vi.fn<(threadId: string) => Promise<HandoffEstimate>>()

let root: Root
let host: HTMLDivElement

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

beforeEach(() => {
  handoffEstimate.mockReset()
  ;(window as unknown as { aios: unknown }).aios = { threads: { handoffEstimate } }
  useLocale.setState({ resolved: 'en' })
  useThreads.setState({
    threadsById: {
      t1: {
        runtime: {
          state: 'idle',
          contextUsage: { inputTokens: 10, cacheReadTokens: 200_000, cacheCreationTokens: 0 }
        }
      }
    }
  } as never)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function renderBar(): Promise<void> {
  // A turn that ended 2 hours ago, with a 1-hour lifetime = expired.
  const items = [{ id: 'r1', ts: Date.now() - 2 * 3_600_000 }] as unknown as TimelineItem[]
  await act(async () => {
    root.render(createElement(PromptCacheBar, { threadId: 't1', cache: { resultId: 'r1', ttlMs: 3_600_000 }, items }))
    await settle()
  })
}

describe('PromptCacheBar: lighten and continue in a new conversation (TODO 961)', () => {
  it('shows the estimate and the button when a handoff text can be built', async () => {
    handoffEstimate.mockResolvedValue({ baseTokens: 20_000, handoffTokens: 5_000 })
    await renderBar()
    expect(host.querySelector('.cache-bar')).not.toBeNull()
    expect(host.querySelector('.cache-bar-button')).not.toBeNull()
    expect(host.querySelector('.cache-bar-estimate')).not.toBeNull()
  })

  it('does not show the button when it cannot be built (handoffTokens is 0); the bar text stays', async () => {
    handoffEstimate.mockResolvedValue({ baseTokens: null, handoffTokens: 0 })
    await renderBar()
    expect(host.querySelector('.cache-bar')).not.toBeNull()
    expect(host.querySelector('.cache-bar-button')).toBeNull()
    expect(host.querySelector('.cache-bar-estimate')).toBeNull()
  })

  it('does not show the button until the estimate arrives', async () => {
    handoffEstimate.mockReturnValue(new Promise(() => undefined))
    await renderBar()
    expect(host.querySelector('.cache-bar')).not.toBeNull()
    expect(host.querySelector('.cache-bar-button')).toBeNull()
  })
})

/** Sets the size of the conversation (input + cacheRead + cacheCreation) as total. */
function setConversation(total: number): void {
  useThreads.setState({
    threadsById: {
      t1: { runtime: { state: 'idle', contextUsage: { inputTokens: 0, cacheReadTokens: total, cacheCreationTokens: 0 } } }
    }
  } as never)
}

describe('PromptCacheBar: light gray when the conversation is small (TODO 996)', () => {
  it('the threshold constant is 150 thousand, and the judgement at the boundary (150 thousand - 1 / 150 thousand) is fixed', () => {
    expect(HANDOFF_MIN_CONVERSATION_TOKENS).toBe(150_000)
    expect(offersHandoff(150_000 - 1)).toBe(false)
    expect(offersHandoff(150_000)).toBe(true)
  })

  it('150 thousand - 1: the bar stays but is subdued, does not ask for an estimate, and shows no button', async () => {
    handoffEstimate.mockResolvedValue({ baseTokens: 20_000, handoffTokens: 5_000 })
    setConversation(150_000 - 1)
    await renderBar()
    const bar = host.querySelector('.cache-bar')
    expect(bar).not.toBeNull()
    expect(bar?.classList.contains('subdued')).toBe(true)
    expect(host.querySelector('.cache-bar-button')).toBeNull()
    expect(handoffEstimate).not.toHaveBeenCalled()
  })

  it('exactly 150 thousand: the explicit bar + button as before', async () => {
    handoffEstimate.mockResolvedValue({ baseTokens: 20_000, handoffTokens: 5_000 })
    setConversation(150_000)
    await renderBar()
    const bar = host.querySelector('.cache-bar')
    expect(bar?.classList.contains('subdued')).toBe(false)
    expect(host.querySelector('.cache-bar-button')).not.toBeNull()
  })
})
