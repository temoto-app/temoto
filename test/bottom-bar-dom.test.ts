// @vitest-environment jsdom
/**
 * TODO 658 (wave 30 bundle A): the right-hand order of the BottomBar is `IndexStatusBar` -> `UsageBadge` ->
 * `BuildInfoBadge` (so that the usage badge does not shift left and right as the index text grows and shrinks, the index goes at the far left and the
 * usage and version badges stay still). The CSS selectors are all class names (no `:nth-child` etc.), so the DOM order itself is pinned down here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UsageSnapshot } from '../src/shared/usage.js'
import { resetUsageForTest } from '../src/renderer/src/usageStore.js'
import { useStore } from '../src/renderer/src/store.js'
import { useThreads } from '../src/renderer/src/threadStore.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('描画 — BottomBar 右側の並び (TODO 658)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    resetUsageForTest()
    const nowSec = Math.floor(Date.now() / 1000)
    const snapshot: UsageSnapshot = {
      fiveHour: { utilization: 0.1, resetsAt: nowSec + 3600 },
      sevenDay: { utilization: 0.01, resetsAt: nowSec + 6 * 86400 },
      status: 'allowed',
      usingOverage: false,
      receivedAt: Date.now()
    }
    ;(window as unknown as { aios: unknown }).aios = {
      usage: {
        get: async () => snapshot,
        onChanged: () => () => {}
      },
      // TODO 1038: the plugin sync badge in the BottomBar (draws nothing when empty).
      plugins: {
        list: async () => [],
        onChanged: () => () => {},
        surfaces: async () => ({ sidebar: [], status: [] }),
        onSurfacesChanged: () => () => {}
      }
    }
    useThreads.setState({ agent: { email: 'user@example.com' } as never })
    useStore.setState({
      appInfo: {
        productName: 'aios',
        dataName: 'aios',
        version: '0.30.0',
        homeUri: 'file:///home',
        storage: 'encrypted',
        storageReason: null,
        platform: 'darwin',
        userDataLabel: null,
        agentDisabled: false,
        build: { version: '0.30.0', commit: 'abcdef0123456789abcdef0123456789abcdef01', dirty: false, date: new Date().toISOString() },
        runtime: { electron: '38.0.0', chromium: '140.0.0.0', node: '22.19.0', v8: '14.0.0-electron.0', os: 'Darwin arm64 25.6.0' }
      }
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete (window as unknown as { aios?: unknown }).aios
  })

  it('索引 → 使用量 → 版 の順で並ぶ', async () => {
    const { BottomBar } = await import('../src/renderer/src/components/BottomBar.js')
    await act(async () => {
      root.render(createElement(BottomBar))
    })
    // Wait for the asynchronous loads of usage / build to settle.
    await act(async () => {})
    const right = container.querySelector('.bottom-bar-right')
    expect(right).not.toBeNull()
    const kinds = [...(right?.children ?? [])].map((el) => {
      if (el.classList.contains('status-bar')) return 'index'
      if (el.classList.contains('usage-badge')) return 'usage'
      if (el.classList.contains('build-badge')) return 'build'
      return el.className
    })
    expect(kinds).toEqual(['index', 'usage', 'build'])
  })
})

describe('描画 — 全委任モードの札 (TODO 1175)', () => {
  let container: HTMLDivElement
  let root: Root
  let fullDelegation = false
  const listeners = new Set<() => void>()

  beforeEach(() => {
    fullDelegation = false
    listeners.clear()
    ;(window as unknown as { aios: unknown }).aios = {
      approvals: { getPolicy: async () => ({ autoAllowAll: true, autoAllowTools: [], bashDenyPatterns: [], fullDelegation }) },
      settings: {
        onChanged: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      }
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    delete (window as unknown as { aios?: unknown }).aios
  })

  it('OFF なら何も出さず、ON に変わった知らせで札が出る。OFF に戻すと消える', async () => {
    const { FullDelegationBadge } = await import('../src/renderer/src/components/FullDelegationBadge.js')
    const { en } = await import('../src/renderer/src/i18n/en.js')
    await act(async () => {
      root.render(createElement(FullDelegationBadge))
    })
    await act(async () => {})
    expect(container.querySelector('.full-delegation-badge')).toBeNull()

    fullDelegation = true
    await act(async () => {
      for (const listener of listeners) listener()
    })
    await act(async () => {})
    const badge = container.querySelector('.full-delegation-badge')
    expect(badge?.textContent).toBe(en['fullDelegation.badge'])
    expect(badge?.getAttribute('aria-label')).toBe(en['fullDelegation.badgeTitle'])

    fullDelegation = false
    await act(async () => {
      for (const listener of listeners) listener()
    })
    await act(async () => {})
    expect(container.querySelector('.full-delegation-badge')).toBeNull()
    act(() => root.unmount())
    expect(listeners.size).toBe(0)
    root = createRoot(container)
  })
})
