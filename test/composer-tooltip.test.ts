// @vitest-environment jsdom
/**
 * Item 373 (wave 20 bundle F): moved the descriptions of the icons at the bottom right of the Composer (attach, queue, interrupt, primary button) and
 * of the queue list rows (✎ / ×) from the OS `title` to the shared bubble (`Tooltip`).
 *
 * The main point is that **the bubble appears even on a disabled (`disabled`) button** (the same kind of missed migration as 354, but this time there is another
 * pitfall: "Chromium may not deliver mouseenter to a `disabled` button"). The outside is wrapped in `<span className="composer-icon-tip">`, and the
 * bubble's mouse and focus events are received by that span.
 *
 * Neither the real CLI nor the model is called. `window.aios` is a minimal fake with only the entry points touched at render time
 * (`attachments.pick` / `drop.uriFor`), the same approach as `test/composer-paste.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ThreadSummary } from '../src/shared/thread.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(window as unknown as { aios: unknown }).aios = {
    drop: { uriFor: (file: { uri?: string }) => file.uri ?? '' },
    attachments: { pick: vi.fn(async () => []) },
    threads: { setPlanMode: vi.fn() },
    fs: {}
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Shows the secondary buttons for queueing and interrupt when `busy: true` (item 161: shown only while responding). */
async function render(options: { busy: boolean; draft?: string }): Promise<void> {
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  const runtime = { state: options.busy ? 'running' : 'idle', live: options.busy } as unknown as ThreadSummary['runtime']
  useThreads.setState({
    drafts: { t1: options.draft ?? '' },
    attachments: {},
    sending: new Set(),
    error: null,
    threadsById: { t1: { thread: {}, runtime, preview: null } as unknown as ThreadSummary }
  })
  const { useLocale } = await import('../src/renderer/src/localeStore.js')
  useLocale.setState({ resolved: 'en' })
  const { Composer } = await import('../src/renderer/src/components/Composer.js')
  act(() => root.render(createElement(Composer, { threadId: 't1' })))
  await settle()
}

const settle = (): Promise<void> => act(async () => {})

async function hover(el: Element): Promise<void> {
  // React's onMouseEnter is synthesized from mouseover / mouseout (the same approach as `test/tooltip.test.ts`).
  act(() => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })))
  // The Tooltip waits 400 ms by default before showing.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450))
  })
}

function tooltipText(): string | null {
  const tip = document.body.querySelector('[role="tooltip"]')
  return tip === null ? null : (tip.textContent ?? '')
}

describe('Composer の右下のアイコンの吹き出し (項目 373)', () => {
  it('添付のボタンは title を持たず、乗せると吹き出しが出る', async () => {
    await render({ busy: false })
    const button = host.querySelector('button.composer-attach')!
    expect(button.hasAttribute('title')).toBe(false)
    await hover(button)
    expect(tooltipText() ?? '').toContain('Choose files to attach')
  })

  it('予約ボタンは入力が空で disabled。span を包んで乗せても吹き出しが出て、無効の理由を示す', async () => {
    await render({ busy: true, draft: '' })
    const button = host.querySelector('button.composer-reserve')!
    expect(button.hasAttribute('title')).toBe(false)
    expect(button.hasAttribute('disabled')).toBe(true)
    const wrap = button.closest('.composer-icon-tip')!
    expect(wrap).not.toBeNull()
    await hover(wrap)
    expect(tooltipText()).toBe('Send after the current response finishes (type a message first)')
  })

  it('入力があれば予約ボタンは押せて、吹き出しは通常の文言', async () => {
    await render({ busy: true, draft: 'hello' })
    const button = host.querySelector('button.composer-reserve')!
    expect(button.hasAttribute('disabled')).toBe(false)
    const wrap = button.closest('.composer-icon-tip')!
    await hover(wrap)
    expect(tooltipText()).toBe('Send after the current response finishes')
  })

  it('割り込みボタンも同じ扱い (無効の理由・キーの文言)', async () => {
    await render({ busy: true, draft: '' })
    const button = host.querySelector('button.composer-interrupt')!
    expect(button.hasAttribute('title')).toBe(false)
    const wrap = button.closest('.composer-icon-tip')!
    await hover(wrap)
    expect(tooltipText()).toBe('Stop the current response and send now (type a message first)')

    await render({ busy: true, draft: 'hi' })
    const button2 = host.querySelector('button.composer-interrupt')!
    const wrap2 = button2.closest('.composer-icon-tip')!
    await hover(wrap2)
    expect(tooltipText() ?? '').toContain('Stop the current response and send now')
  })

  it('主ボタン (送信 / 停止) も title を持たず span で包まれる', async () => {
    await render({ busy: false, draft: '' })
    const button = host.querySelector('button.composer-send')!
    expect(button.hasAttribute('title')).toBe(false)
    expect(button.closest('.composer-icon-tip')).not.toBeNull()
  })

  it('予約の一覧の行の ✎ / × も title を持たず、吹き出しに移っている', async () => {
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const runtime = {
      state: 'running',
      live: true,
      reservations: [{ id: 'r1', preview: 'next message', attachments: 0, interrupt: false }]
    } as unknown as ThreadSummary['runtime']
    useThreads.setState({
      drafts: { t1: '' },
      attachments: {},
      sending: new Set(),
      error: null,
      threadsById: { t1: { thread: {}, runtime, preview: null } as unknown as ThreadSummary }
    })
    const { useLocale } = await import('../src/renderer/src/localeStore.js')
    useLocale.setState({ resolved: 'en' })
    const { Composer } = await import('../src/renderer/src/components/Composer.js')
    act(() => root.render(createElement(Composer, { threadId: 't1' })))
    await settle()
    const buttons = host.querySelectorAll('.composer-reservations button.reservation-action')
    expect(buttons.length).toBe(2)
    for (const button of Array.from(buttons)) {
      expect(button.hasAttribute('title')).toBe(false)
    }
    await hover(buttons[0]!)
    expect(tooltipText()).toBe('Move back to the input to edit')
  })
})

describe('予約のアイコン (項目 374): 時計から「≡↑」へ', () => {
  it('ComposerQueueIcon は待ち行列の 3 本線 + 送信の矢印 (circle は使わない)', async () => {
    const { ComposerQueueIcon } = await import('../src/renderer/src/icons/ComposerQueueIcon.js')
    const markup = (await import('react-dom/server')).renderToStaticMarkup(createElement(ComposerQueueIcon))
    expect(markup).not.toContain('<circle')
    expect(markup).toContain('M4 8h7M4 12h7M4 16h7')
    expect(markup).toContain('M18 20V11')
  })
})
