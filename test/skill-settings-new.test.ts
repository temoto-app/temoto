// @vitest-environment jsdom
/**
 * TODO 824: 'New skill...' in Settings -> Skills can be pressed even when no conversation is selected.
 * Pressing it creates a new conversation (without a dialog) and puts the template into its input field.
 * Neither a model nor Electron is used.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** TODO 1099: the catalog that 'Install a CLI plugin' under the Skills section looks up (empty here). */
const EMPTY_CATALOG = {
  entries: [],
  matched: 0,
  total: 0,
  fetchedAt: null,
  unavailable: 'no-cache',
  refreshCommand: null,
  installed: [],
  opsDisabled: null
}

describe('SkillSettings New skill...', () => {
  let root: Root | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    vi.resetModules()
  })

  it('even without a conversation it is not disabled, and pressing it creates a conversation and puts in a template', async () => {
    Object.defineProperty(window, 'aios', {
      configurable: true,
      value: { skills: { list: vi.fn().mockResolvedValue({ skills: [], projectChecked: false }), pluginCatalog: vi.fn().mockResolvedValue(EMPTY_CATALOG) } }
    })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { SkillSettings } = await import('../src/renderer/src/components/SkillSettings.js')
    const created = vi.fn(async () => {
      useThreads.setState({ activeThreadId: 'new1' })
      return true
    })
    useThreads.setState({ activeThreadId: null, createThreadInFolder: created, drafts: {} })

    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(createElement(SkillSettings))
    })
    const button = host.querySelector('.settings-actions button') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    await act(async () => {
      button.click()
    })
    expect(created).toHaveBeenCalledTimes(1)
    expect((useThreads.getState().drafts['new1'] ?? '').length).toBeGreaterThan(0)
  })

  it('pressing twice in a row creates only one conversation (new-chat-guard)', async () => {
    Object.defineProperty(window, 'aios', {
      configurable: true,
      value: { skills: { list: vi.fn().mockResolvedValue({ skills: [], projectChecked: false }), pluginCatalog: vi.fn().mockResolvedValue(EMPTY_CATALOG) } }
    })
    const { useThreads } = await import('../src/renderer/src/threadStore.js')
    const { SkillSettings } = await import('../src/renderer/src/components/SkillSettings.js')
    let finish: (ok: boolean) => void = () => undefined
    const created = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = (ok) => {
            useThreads.setState({ activeThreadId: 'new1' })
            resolve(ok)
          }
        })
    )
    useThreads.setState({ activeThreadId: null, createThreadInFolder: created, drafts: {} })
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(createElement(SkillSettings))
    })
    const button = host.querySelector('.settings-actions button') as HTMLButtonElement
    await act(async () => {
      button.click()
      button.click()
    })
    finish(true)
    await act(async () => {
      button.click()
    })
    expect(created).toHaveBeenCalledTimes(1)
  })
})
