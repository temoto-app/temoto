// @vitest-environment jsdom
/**
 * Entry points for exporting a conversation (TODO 864 / 865 / 866).
 * - 864: the hover button on your own messages is an SVG icon, not the text "PDF".
 * - 865: the three items in ⋯ (viewer, editor, PDF) are icon buttons at the upper right of the heading (`ThreadHeaderActions`).
 * - 866: pressing the export icon (heading and hover) opens a small menu with "Save as PDF…" / "Save as HTML…".
 *
 * Does not call the real CLI or the model. `window.aios` is a fake that covers only the touch points used for rendering and operation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let savePdf: ReturnType<typeof vi.fn>
let saveHtml: ReturnType<typeof vi.fn>

const TURNS = [
  { number: 1, question: { id: 'e1', ts: 1, text: 'Q1' }, answers: ['A1'] },
  { number: 2, question: { id: 'e2', ts: 2, text: 'Q2' }, answers: ['![図](/w/a.png)'] }
]

beforeEach(async () => {
  savePdf = vi.fn(async () => ({ saved: false }))
  saveHtml = vi.fn(async () => ({ saved: false }))
  ;(window as unknown as { aios: unknown }).aios = {
    threads: { exportTurns: vi.fn(async () => ({ threadId: 't1', turns: TURNS })), savePdf, saveHtml }
  }
  const { useLocale } = await import('../src/renderer/src/localeStore.js')
  useLocale.setState({ resolved: 'en' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = (): Promise<void> => act(async () => {})

async function seedThread(cwd: boolean): Promise<void> {
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  const thread = {
    id: 't1',
    title: 'T',
    backend: 'b1',
    cwdName: cwd ? 'aios' : '',
    cwdUri: cwd ? 'file:///w/aios' : '',
    approvalStrict: false,
    retention: 'forever'
  }
  useThreads.setState({
    error: null,
    threadsById: { t1: { thread, runtime: { state: 'idle', live: false }, preview: null } } as never
  })
}

function menuItems(): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll('.menu-popover[role="menu"] button')) as HTMLButtonElement[]
}

describe('hover の書き出しボタン (TODO 864 / 866)', () => {
  it('文字の「PDF」ではなくアイコンで、名前 (title / aria-label) がある', async () => {
    await seedThread(true)
    const { ExportTurnButton } = await import('../src/renderer/src/components/ExportTurnButton.js')
    act(() => root.render(createElement(ExportTurnButton, { threadId: 't1', eventId: 'e1' })))
    await settle()
    const button = host.querySelector('.export-turn-menu button.export-turn-button') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.textContent).toBe('')
    expect(button.getAttribute('aria-label')).toBe('Export this question and answer')
  })

  it('押すと PDF / HTML の小メニュー、HTML を選ぶとその 1 問 1 答を saveHtml へ', async () => {
    await seedThread(true)
    const { ExportTurnButton } = await import('../src/renderer/src/components/ExportTurnButton.js')
    act(() => root.render(createElement(ExportTurnButton, { threadId: 't1', eventId: 'e2' })))
    await settle()
    act(() => (host.querySelector('button.export-turn-button') as HTMLButtonElement).click())
    await settle()
    expect(menuItems().map((item) => item.textContent)).toEqual(['Save as PDF…', 'Save as HTML…', 'Save as Markdown…'])
    act(() => menuItems()[1]!.click())
    await settle()
    expect(savePdf).not.toHaveBeenCalled()
    expect(saveHtml).toHaveBeenCalledTimes(1)
    const [threadId, scope, html] = saveHtml.mock.calls[0] as [string, unknown, string]
    expect(threadId).toBe('t1')
    expect(scope).toEqual({ kind: 'turn', number: 2 })
    expect(html).toContain("img-src data:")
    expect(html).not.toMatch(/<script/i)
    expect(menuItems()).toEqual([])
  })
})

describe('見出しの右上のアイコン (TODO 865 / 866)', () => {
  it('ビューア・エディタ・書き出しの 3 つをアイコンで出し、名前は前の文言のまま', async () => {
    await seedThread(true)
    const { ThreadHeaderActions } = await import('../src/renderer/src/components/ThreadHeaderActions.js')
    act(() => root.render(createElement(ThreadHeaderActions, { threadId: 't1' })))
    await settle()
    const buttons = Array.from(host.querySelectorAll('button.thread-action'))
    expect(buttons.map((button) => button.className)).toEqual([
      'icon-button thread-action thread-action-viewer',
      'icon-button thread-action thread-action-editor',
      'icon-button menu-button thread-action'
    ])
    for (const button of buttons) {
      expect(button.querySelector('svg')).not.toBeNull()
      expect(button.textContent).toBe('')
    }
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Open a viewer (URL or file path)')
    expect(buttons[1]?.getAttribute('aria-label')).toMatch(/^Open the folder in /)
    expect(buttons[2]?.getAttribute('aria-label')).toBe('Export conversation')
    expect(buttons[2]?.closest('.thread-action-export')).not.toBeNull()
  })

  it('書き出しは小メニューで、PDF を選ぶと会話全体を savePdf へ', async () => {
    await seedThread(true)
    const { ThreadHeaderActions } = await import('../src/renderer/src/components/ThreadHeaderActions.js')
    act(() => root.render(createElement(ThreadHeaderActions, { threadId: 't1' })))
    await settle()
    act(() => (host.querySelector('.thread-action-export button') as HTMLButtonElement).click())
    await settle()
    act(() => menuItems()[0]!.click())
    await settle()
    expect(saveHtml).not.toHaveBeenCalled()
    expect(savePdf).toHaveBeenCalledTimes(1)
    expect(savePdf.mock.calls[0]?.[1]).toEqual({ kind: 'all' })
  })

  it('cwd の無いスレッド (捨て場・古い行) にはエディタのボタンを出さない', async () => {
    await seedThread(false)
    const { ThreadHeaderActions } = await import('../src/renderer/src/components/ThreadHeaderActions.js')
    act(() => root.render(createElement(ThreadHeaderActions, { threadId: 't1' })))
    await settle()
    expect(host.querySelector('button.thread-action-editor')).toBeNull()
    expect(host.querySelector('button.thread-action-viewer')).not.toBeNull()
    expect(host.querySelector('.thread-action-export button')).not.toBeNull()
  })

  it('ThreadPane の見出しで 🔍 の左、⋯ はその右に残る', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/renderer/src/components/ThreadPane.tsx', 'utf8')
    expect(src).toMatch(/<ThreadHeaderActions[\s\S]*thread-find-open[\s\S]*<ThreadSettingsMenu/)
  })
})

describe('書き出し中の表示 (TODO 866 code-review)', () => {
  it('走っている入口は busy、同じスレッドの別の入口は押せない。終われば戻る', async () => {
    await seedThread(true)
    let finish: () => void = () => undefined
    saveHtml.mockImplementation(() => new Promise((resolve) => (finish = () => resolve({ saved: false }))))
    const { ExportTurnButton } = await import('../src/renderer/src/components/ExportTurnButton.js')
    const { ThreadHeaderActions } = await import('../src/renderer/src/components/ThreadHeaderActions.js')
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          createElement(ExportTurnButton, { threadId: 't1', eventId: 'e1' }),
          createElement(ThreadHeaderActions, { threadId: 't1' })
        )
      )
    )
    await settle()
    const turn = host.querySelector('button.export-turn-button') as HTMLButtonElement
    const header = host.querySelector('.thread-action-export button') as HTMLButtonElement
    act(() => turn.click())
    await settle()
    act(() => menuItems()[1]!.click())
    await settle()
    expect(turn.disabled).toBe(true)
    expect(turn.getAttribute('aria-busy')).toBe('true')
    expect(header.disabled).toBe(true)
    expect(header.getAttribute('aria-busy')).toBeNull()
    await act(async () => finish())
    await settle()
    expect(turn.disabled).toBe(false)
    expect(turn.getAttribute('aria-busy')).toBeNull()
    expect(header.disabled).toBe(false)
  })
})
