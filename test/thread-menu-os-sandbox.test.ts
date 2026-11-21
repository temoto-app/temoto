// @vitest-environment jsdom
/**
 * TODO 1106 (wave 68 bundle A): 'OS sandbox' in the thread's ⋯ menu (the same shape as strict mode).
 * On backends where it cannot be used, it is greyed out with the reason; a conversation that had it ON and can no longer use it can only be turned OFF.
 * TODO 1109 item 4: the reason is also shown in the explanation line before the backend list is fetched (`os-sandbox-pending`) and when main refuses (IPC rejection).
 * Neither the real CLI nor a model is called. `window.aios` is a fake with only the entry points used for rendering and operation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ThreadSummary } from '../src/shared/thread.js'
import { formatReason } from '../src/shared/reason.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let setOsSandbox: ReturnType<typeof vi.fn>

beforeEach(() => {
  setOsSandbox = vi.fn(async () => undefined)
  ;(window as unknown as { aios: unknown }).aios = {
    threads: { setPlanMode: vi.fn(), setApprovalStrict: vi.fn(), setOsSandbox, setRetention: vi.fn(), clearLog: vi.fn() }
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

async function openMenu(options: {
  on: boolean
  available: boolean
  degradations?: readonly { feature: string; reason: string; code: string | null }[]
  /** In the fake, the backend list has not been fetched yet (`backends` is null). */
  known?: boolean
}): Promise<void> {
  const { useThreads } = await import('../src/renderer/src/threadStore.js')
  const thread = {
    id: 't1',
    backend: 'b1',
    approvalStrict: false,
    retention: 'forever',
    ...(options.on ? { osSandbox: true } : {})
  } as unknown as ThreadSummary['thread']
  useThreads.setState({
    backends: (options.known === false
      ? null
      : [
          {
            id: 'b1',
            models: [],
            degradations: options.degradations ?? [],
            ...(options.available ? { osSandbox: true } : {})
          }
        ]) as unknown as never,
    threadsById: {
      t1: { thread, runtime: { state: 'idle', live: false }, preview: null } as unknown as ThreadSummary
    }
  })
  const { useLocale } = await import('../src/renderer/src/localeStore.js')
  useLocale.setState({ resolved: 'en' })
  const { ThreadSettingsMenu } = await import('../src/renderer/src/components/ThreadSettingsMenu.js')
  act(() => root.render(createElement(ThreadSettingsMenu, { threadId: 't1' })))
  await settle()
  act(() => (host.querySelector('button.menu-button') as HTMLButtonElement).click())
  await settle()
}

function sandboxCheckbox(): HTMLInputElement {
  const item = [...host.querySelectorAll('.thread-settings-item')].find((el) =>
    el.querySelector('.thread-settings-title')?.textContent === 'OS Sandbox'
  )
  const input = item?.querySelector('input[type="checkbox"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('no OS sandbox item')
  return input
}

describe('⋯ の OS サンドボックス (TODO 1106)', () => {
  it('使えるバックエンドでは押せて、ON を送る', async () => {
    await openMenu({ on: false, available: true })
    const box = sandboxCheckbox()
    expect(box.disabled).toBe(false)
    expect(box.checked).toBe(false)
    act(() => box.click())
    expect(setOsSandbox).toHaveBeenCalledWith('t1', true)
    expect(host.textContent).not.toContain('has no OS sandbox')
  })

  it('使えないバックエンドでは灰色にして理由を出す', async () => {
    await openMenu({ on: false, available: false })
    expect(sandboxCheckbox().disabled).toBe(true)
    expect(host.textContent).toContain('This backend (this version) has no OS sandbox')
  })

  it('起動で使えないと分かったなら、その理由 (診断文を差し込む)', async () => {
    await openMenu({
      on: false,
      available: false,
      degradations: [{ feature: 'os-sandbox', reason: 'x', code: formatReason('os-sandbox-failed', { detail: 'bwrap missing' }) }]
    })
    expect(host.textContent).toContain("The OS sandbox couldn't start in this environment (bwrap missing)")
  })

  it('ON のまま使えなくなった会話は OFF にできる', async () => {
    await openMenu({ on: true, available: false })
    const box = sandboxCheckbox()
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(false)
    act(() => box.click())
    expect(setOsSandbox).toHaveBeenCalledWith('t1', false)
  })

  it('バックエンドの一覧を取る前は灰色にして、その旨を出す (TODO 1109)', async () => {
    await openMenu({ on: false, available: false, known: false })
    expect(sandboxCheckbox().disabled).toBe(true)
    expect(host.textContent).toContain("Can't be turned on until the backend has been checked")
    expect(host.textContent).not.toContain('has no OS sandbox')
  })

  it('main が ON を断ったら、その理由コードの文を説明の行に出す。通れば消す (TODO 1109)', async () => {
    setOsSandbox.mockImplementationOnce(async () => {
      throw new Error("Error invoking remote method 'aios:thread/setOsSandbox': Error: " + formatReason('os-sandbox-unsupported'))
    })
    await openMenu({ on: false, available: true })
    expect(host.textContent).not.toContain('has no OS sandbox')
    act(() => sandboxCheckbox().click())
    await settle()
    expect(host.textContent).toContain('This backend (this version) has no OS sandbox')
    // Press once more and it passes, and the reason disappears.
    act(() => sandboxCheckbox().click())
    await settle()
    expect(setOsSandbox).toHaveBeenCalledTimes(2)
    expect(host.textContent).not.toContain('has no OS sandbox')
  })

  it('理由の拾えない rejection は internal-error の文にする (TODO 1109)', async () => {
    setOsSandbox.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    await openMenu({ on: false, available: true })
    act(() => sandboxCheckbox().click())
    await settle()
    expect(host.textContent).not.toContain('boom')
    expect(host.textContent).toContain('Something went wrong. Details are in the log')
  })
})

describe('osSandboxMenuReason (TODO 1109)', () => {
  it('断った理由 → 使えない理由 → 一覧を取る前 (OFF のときだけ) の順', async () => {
    const { osSandboxMenuReason } = await import('../src/renderer/src/components/ThreadSettingsMenu.js')
    const refused = formatReason('internal-error')
    const unavailable = formatReason('os-sandbox-unsupported')
    expect(osSandboxMenuReason({ refused, unavailable, known: true, on: false })).toBe(refused)
    expect(osSandboxMenuReason({ refused: null, unavailable, known: true, on: false })).toBe(unavailable)
    expect(osSandboxMenuReason({ refused: null, unavailable: null, known: false, on: false })).toBe(formatReason('os-sandbox-pending'))
    // If it is ON, it can be turned OFF, so nothing is shown 'until confirmed'.
    expect(osSandboxMenuReason({ refused: null, unavailable: null, known: false, on: true })).toBeNull()
    expect(osSandboxMenuReason({ refused: null, unavailable: null, known: true, on: false })).toBeNull()
  })
})
