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

describe('Composer の Plan の札 (TODO 465)', () => {
  it('OFF のときは何も出さない (OFF の薄いボタンは無い)', async () => {
    await renderComposer({ planMode: false, planAvailable: true })
    expect(host.querySelector('.plan-toggle')).toBeNull()
    expect(host.textContent).not.toContain('plan mode')
  })

  it('ON のときだけ `⏸ plan mode on` の札を出し、押すと OFF にする', async () => {
    await renderComposer({ planMode: true, planAvailable: true })
    const badge = host.querySelector('button.plan-toggle.on') as HTMLButtonElement
    expect(badge).not.toBeNull()
    expect(badge.textContent).toBe('⏸︎ plan mode on')
    // The badge is outside the primary button's box (on the left). The contents of the box (`.composer-buttons`) do not change, so the primary button does not move.
    expect(badge.closest('.composer-buttons')).toBeNull()
    expect(badge.nextElementSibling?.classList.contains('composer-buttons')).toBe(true)
    act(() => badge.click())
    expect(setPlanMode).toHaveBeenCalledWith('t1', false)
  })

  it('使えないバックエンドでは ON でも札を出さない', async () => {
    await renderComposer({ planMode: true, planAvailable: false })
    expect(host.querySelector('.plan-toggle')).toBeNull()
  })

  it('Shift+Tab の切り替えは残る', async () => {
    await renderComposer({ planMode: false, planAvailable: true })
    const textarea = host.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    })
    expect(setPlanMode).toHaveBeenCalledWith('t1', true)
  })
})

describe('⋯ (スレッドの設定) の Plan mode (TODO 465)', () => {
  it('厳格モードと同じ形 (見出し + チェックボックス + 説明) で、厳格モードの上に出す', async () => {
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

  it('ON ならチェックが入っていて、外すと OFF', async () => {
    await openMenu({ planMode: true, planAvailable: true })
    const box = host.querySelector('.thread-settings-item input[type="checkbox"]') as HTMLInputElement
    expect(box.checked).toBe(true)
    act(() => box.click())
    expect(setPlanMode).toHaveBeenCalledWith('t1', false)
  })

  it('使えないバックエンドでは項目ごと出さない', async () => {
    await openMenu({ planMode: false, planAvailable: false })
    const titles = Array.from(host.querySelectorAll('.thread-settings-title')).map((el) => el.textContent)
    expect(titles).not.toContain('Plan Mode')
    expect(titles[0]).toBe('Strict Approvals')
  })
})

describe('見出しの「ビューアを開く」(TODO 771、TODO 865 で ⋯ から見出しのアイコンへ)', () => {
  it('⋯ の中には出さない', async () => {
    await openMenu({ planMode: false, planAvailable: false })
    expect(host.querySelector('button.thread-settings-open-viewer')).toBeNull()
    expect(host.querySelector('button.thread-settings-open-editor')).toBeNull()
    expect(host.querySelector('button.thread-settings-export-pdf')).toBeNull()
  })

  it('押すと空白のタブ (about:blank) を ViewerPane に出す', async () => {
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
