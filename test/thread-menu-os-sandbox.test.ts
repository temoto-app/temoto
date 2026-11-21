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

describe('OS sandbox in ⋯ (TODO 1106)', () => {
  it('is pressable on a usable backend and sends ON', async () => {
    await openMenu({ on: false, available: true })
    const box = sandboxCheckbox()
    expect(box.disabled).toBe(false)
    expect(box.checked).toBe(false)
    act(() => box.click())
    expect(setOsSandbox).toHaveBeenCalledWith('t1', true)
    expect(host.textContent).not.toContain('has no OS sandbox')
  })

  it('is grayed out with a reason on an unusable backend', async () => {
    await openMenu({ on: false, available: false })
    expect(sandboxCheckbox().disabled).toBe(true)
    expect(host.textContent).toContain('This backend (this version) has no OS sandbox')
  })

  it('when found unusable at startup, shows that reason (inserts the diagnostic text)', async () => {
    await openMenu({
      on: false,
      available: false,
      degradations: [{ feature: 'os-sandbox', reason: 'x', code: formatReason('os-sandbox-failed', { detail: 'bwrap missing' }) }]
    })
    expect(host.textContent).toContain("The OS sandbox couldn't start in this environment (bwrap missing)")
  })

  it('a thread that became unusable while ON can be turned OFF', async () => {
    await openMenu({ on: true, available: false })
    const box = sandboxCheckbox()
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(false)
    act(() => box.click())
    expect(setOsSandbox).toHaveBeenCalledWith('t1', false)
  })

  it('before the backend list is fetched, is grayed out and says so (TODO 1109)', async () => {
    await openMenu({ on: false, available: false, known: false })
    expect(sandboxCheckbox().disabled).toBe(true)
    expect(host.textContent).toContain("Can't be turned on until the backend has been checked")
    expect(host.textContent).not.toContain('has no OS sandbox')
  })

  it('when main refuses ON, shows the text of that reason code on the description line, and clears it when it passes (TODO 1109)', async () => {
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

  it('a rejection whose reason cannot be extracted uses the internal-error text (TODO 1109)', async () => {
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
  it('order: refusal reason → unusable reason → before the list is fetched (only when OFF)', async () => {
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
