// @vitest-environment jsdom
/**
 * TODO 465 (wave 23 bundle E): moved the Plan mode toggle from the prompt field to the ⋯ at the top right of ThreadPane (`ThreadSettingsMenu`).
 * - ⋯ shows it in the same form as strict mode (heading + checkbox + one-line explanation), and the item is not shown at all on backends that cannot use it.
 * - The Composer shows the `⏸ plan mode on` badge **only when ON**, and pressing it turns it OFF. There is no faint button for OFF.
 * - Shift+Tab switching is kept.
 *
 * Neither the real CLI nor a model is called. `window.aios` is a fake with only the entry points that rendering and operation touch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ThreadSummary } from '../src/shared/thread.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let setPlanMode: ReturnType<typeof vi.fn>

beforeEach(() => {
  setPlanMode = vi.fn(async () => undefined)
  ;(window as unknown as { aios: unknown }).aios = {
    drop: { uriFor: (file: { uri?: string }) => file.uri ?? '' },
    attachments: { pick: vi.fn(async () => []) },
    threads: { setPlanMode, setApprovalStrict: vi.fn(), setRetention: vi.fn(), clearLog: vi.fn() },
    fs: {},
    web: { newTab: vi.fn(async () => ({ tabs: [], activeId: null })) }
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = (): Promise<void> => act(async () => {})

async function seed(options: { planMode: boolean; planAvailable: boolean }): Promise<void> {
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  const runtime = {
    state: 'idle',
    live: false,
    ...(options.planMode ? { planMode: true } : {})
  } as unknown as ThreadSummary['runtime']
  const thread = {
    id: 't1',
    backend: 'b1',
    cwdName: '',
    cwdUri: '',
    approvalStrict: false,
    retention: 'forever'
  } as unknown as ThreadSummary['thread']
  useThreads.setState({
    drafts: { t1: '' },
    attachments: {},
    sending: new Set(),
    error: null,
    backends: [
      {
        id: 'b1',
        models: [],
        modelSelect: false,
        thinkingLevel: false,
        ...(options.planAvailable ? { planMode: true } : {})
      }
    ] as unknown as never,
    threadsById: { t1: { thread, runtime, preview: null } as unknown as ThreadSummary }
  })
  const { useLocale } = await import('../src/renderer/src/localeStore.js')
  useLocale.setState({ resolved: 'en' })
}

async function renderComposer(options: { planMode: boolean; planAvailable: boolean }): Promise<void> {
  await seed(options)
  const { Composer } = await import('../src/renderer/src/components/Composer.js')
  act(() => root.render(createElement(Composer, { threadId: 't1' })))
  await settle()
}

async function openMenu(options: { planMode: boolean; planAvailable: boolean }): Promise<void> {
  await seed(options)
  const { ThreadSettingsMenu } = await import('../src/renderer/src/components/ThreadSettingsMenu.js')
  act(() => root.render(createElement(ThreadSettingsMenu, { threadId: 't1' })))
  await settle()
  const button = host.querySelector('button.menu-button') as HTMLButtonElement
  act(() => button.click())
  await settle()
}

describe('Composer Plan badge (TODO 465)', () => {
  it('shows nothing when OFF (there is no faint OFF button)', async () => {
    await renderComposer({ planMode: false, planAvailable: true })
    expect(host.querySelector('.plan-toggle')).toBeNull()
    expect(host.textContent).not.toContain('plan mode')
  })

  it('shows the `⏸ plan mode on` badge only when ON, and pressing it turns it OFF', async () => {
    await renderComposer({ planMode: true, planAvailable: true })
    const badge = host.querySelector('button.plan-toggle.on') as HTMLButtonElement
    expect(badge).not.toBeNull()
    expect(badge.textContent).toBe('⏸︎ plan mode on')
    // The badge is outside the primary button's box. TODO 1294: the box (`.composer-buttons`) now lives at the input's right edge
    // (inside `.composer-prompt`), and the badge stays in the lower row, so the primary button does not move when it comes and goes.
    expect(badge.closest('.composer-buttons')).toBeNull()
    expect(host.querySelector('.composer-prompt > .composer-buttons')).not.toBeNull()
    expect(badge.closest('.composer-actions')).not.toBeNull()
    act(() => badge.click())
    expect(setPlanMode).toHaveBeenCalledWith('t1', false)
  })

  it('does not show the badge even when ON for a backend that cannot use it', async () => {
    await renderComposer({ planMode: true, planAvailable: false })
    expect(host.querySelector('.plan-toggle')).toBeNull()
  })

  it('the Shift+Tab toggle remains', async () => {
    await renderComposer({ planMode: false, planAvailable: true })
    const textarea = host.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    })
    expect(setPlanMode).toHaveBeenCalledWith('t1', true)
  })
})

describe('Plan mode in ⋯ (thread settings) (TODO 465)', () => {
  it('has the same form as strict mode (heading + checkbox + description) and appears above strict mode', async () => {
    await openMenu({ planMode: false, planAvailable: true })
    const items = Array.from(host.querySelectorAll('.thread-settings-item'))
    const titles = items.map((item) => item.querySelector('.thread-settings-title')?.textContent)
    expect(titles.slice(0, 2)).toEqual(['Plan Mode', 'Strict Approvals'])
    const plan = items[0]!
    const box = plan.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box.checked).toBe(false)
    expect(plan.querySelector('.thread-settings-checkbox span')?.textContent).toContain('Shift+Tab')
    act(() => box.click())
    expect(setPlanMode).toHaveBeenCalledWith('t1', true)
  })

  it('is checked when ON and unchecking turns it OFF', async () => {
    await openMenu({ planMode: true, planAvailable: true })
    const box = host.querySelector('.thread-settings-item input[type="checkbox"]') as HTMLInputElement
    expect(box.checked).toBe(true)
    act(() => box.click())
    expect(setPlanMode).toHaveBeenCalledWith('t1', false)
  })

  it('does not show the item at all for a backend that cannot use it', async () => {
    await openMenu({ planMode: false, planAvailable: false })
    const titles = Array.from(host.querySelectorAll('.thread-settings-title')).map((el) => el.textContent)
    expect(titles).not.toContain('Plan Mode')
    expect(titles[0]).toBe('Strict Approvals')
  })
})

describe('「ビューアを開く」 in the heading (TODO 771, moved from ⋯ to a heading icon in TODO 865)', () => {
  it('does not appear inside ⋯', async () => {
    await openMenu({ planMode: false, planAvailable: false })
    expect(host.querySelector('button.thread-settings-open-viewer')).toBeNull()
    expect(host.querySelector('button.thread-settings-open-editor')).toBeNull()
    expect(host.querySelector('button.thread-settings-export-pdf')).toBeNull()
  })

  it('pressing it shows a blank tab (about:blank) in ViewerPane', async () => {
    await seed({ planMode: false, planAvailable: false })
    const { ThreadHeaderActions } = await import('../src/renderer/src/components/ThreadHeaderActions.js')
    act(() => root.render(createElement(ThreadHeaderActions, { threadId: 't1' })))
    await settle()
    const { useStore } = await import('../src/renderer/src/store.js')
    useStore.getState().select(null)
    const item = host.querySelector('button.thread-action-viewer') as HTMLButtonElement
    expect(item).not.toBeNull()
    act(() => item.click())
    expect(useStore.getState().selectedUri).toBe('about:blank')
    expect((window as unknown as { aios: { web: { newTab: ReturnType<typeof vi.fn> } } }).aios.web.newTab).toHaveBeenCalledWith(null)
  })
})
