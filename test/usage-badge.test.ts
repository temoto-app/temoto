// @vitest-environment jsdom
/**
 * Item 317 (wave 17 bundle B): draws the BottomBar usage badge (`UsageBadge`), its floating frame, and the settings section (`UsageSection`).
 * Values come from a fake `window.aios.usage` (the copy kept at startup, plus push). Aggregation, storage, and pure functions are in `usage-limits.test.ts`.
 * Neither the model nor Electron is used.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UsageSnapshot } from '../src/shared/usage.js'
import { resetUsageForTest, useUsage } from '../src/renderer/src/usageStore.js'
import { useThreads } from '../src/renderer/src/threadStore.js'
import { en } from '../src/renderer/src/i18n/en.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('rendering: the BottomBar badge and popover, and the settings section (item 317)', () => {
  let container: HTMLDivElement
  let root: Root
  let listener: ((snapshot: UsageSnapshot) => void) | null = null
  const nowSec = Math.floor(Date.now() / 1000)
  const snapshot: UsageSnapshot = {
    fiveHour: { utilization: 0.11, resetsAt: nowSec + 3600 + 120 },
    sevenDay: { utilization: 0.01, resetsAt: nowSec + 6 * 86400 + 3600 },
    status: 'allowed',
    usingOverage: false,
    receivedAt: Date.now() - 5 * 60_000
  }

  beforeEach(() => {
    resetUsageForTest()
    listener = null
    ;(window as unknown as { aios: unknown }).aios = {
      usage: {
        get: async () => snapshot,
        onChanged: (fn: (s: UsageSnapshot) => void) => {
          listener = fn
          return () => {}
        }
      }
    }
    useThreads.setState({ agent: { email: 'user@example.com' } as never })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows the badge from the startup cache, and pressing it shows the Session / Weekly bars and a popover with Resets in, n minutes ago, and Email', async () => {
    const { UsageBadge } = await import('../src/renderer/src/components/UsageBadge.js')
    await act(async () => {
      root.render(createElement(UsageBadge))
    })
    const button = container.querySelector<HTMLButtonElement>('.usage-badge button')
    expect(button?.textContent).toBe('5h 11% · 7d 1%')
    expect(container.querySelector('.usage-badge.warn')).toBeNull()
    // TODO 377: next to the per-window text, a bar whose width is proportional to usage (decoration, aria-hidden)
    const bars = container.querySelectorAll<HTMLElement>('.usage-badge-bar')
    expect(bars).toHaveLength(2)
    expect([...bars].every((bar) => bar.getAttribute('aria-hidden') === 'true')).toBe(true)
    const fills = container.querySelectorAll<HTMLElement>('.usage-badge-bar-fill')
    expect(fills[0]?.style.width).toBe('11%')
    expect(fills[1]?.style.width).toBe('1%')
    await act(async () => button?.click())
    const popover = container.querySelector('.usage-popover')
    expect(popover).not.toBeNull()
    const text = popover?.textContent ?? ''
    expect(text).toContain(en['usage.fiveHour'])
    expect(text).toContain(en['usage.sevenDay'])
    expect(text).toContain('Resets in 1h')
    expect(text).toContain('Resets in 6d')
    expect(text).toContain('As of 5 min ago')
    expect(text).toContain('user@example.com')
    expect(popover?.querySelectorAll('[role="progressbar"]')).toHaveLength(2)
    // Closes with Esc
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(container.querySelector('.usage-popover')).toBeNull()
    // Replaced by push, and turns the warning color
    await act(async () =>
      listener?.({ ...snapshot, status: 'allowed_warning', fiveHour: { utilization: 0.92, resetsAt: null } })
    )
    expect(container.querySelector('.usage-badge.warn button')?.textContent).toBe('5h 92% · 7d 1%')
    // When warning, the bar is also warning-colored (the --warn-fg class; the CSS is in styles.css)
    expect(container.querySelector('.usage-badge.warn .usage-badge-bar-fill')).not.toBeNull()
    expect(container.querySelectorAll<HTMLElement>('.usage-badge-bar-fill')[0]?.style.width).toBe('92%')
  })

  it('a window past resetsAt shows the badge as `5h —` and the popover as 「—」/「Reset」, and does not show the stale percentage (small observation of TODO 333-1)', async () => {
    ;(window as unknown as { aios: { usage: { get: () => Promise<UsageSnapshot> } } }).aios.usage.get = async () => ({
      ...snapshot,
      fiveHour: { utilization: 0.3, resetsAt: nowSec - 20 * 3600 }
    })
    const { UsageBadge } = await import('../src/renderer/src/components/UsageBadge.js')
    await act(async () => {
      root.render(createElement(UsageBadge))
    })
    const button = container.querySelector<HTMLButtonElement>('.usage-badge button')
    expect(button?.textContent).toBe('5h — · 7d 1%')
    // A window that has already reset shows no bar (hidden, not 0 width). The other bar still shows
    const parts = container.querySelectorAll<HTMLElement>('.usage-badge-part')
    expect(parts[0]?.querySelector('.usage-badge-bar')).toBeNull()
    expect(parts[1]?.querySelector('.usage-badge-bar')).not.toBeNull()
    await act(async () => button?.click())
    const popover = container.querySelector('.usage-popover')
    const text = popover?.textContent ?? ''
    expect(text).toContain(en['usage.percentUnknown'])
    expect(text).toContain(en['usage.reset'])
    expect(text).not.toContain('30%')
    const bars = popover?.querySelectorAll<HTMLElement>('[role="progressbar"]')
    expect(bars?.[0]?.getAttribute('aria-valuenow')).toBe('0')
  })

  it('the Fable weekly window (TODO 1000) appears only in the details (popover, settings), and the badge stays 5h · 7d, and when old shows n minutes ago', async () => {
    ;(window as unknown as { aios: { usage: { get: () => Promise<UsageSnapshot> } } }).aios.usage.get = async () => ({
      ...snapshot,
      sevenDayFable: { utilization: 0.07, resetsAt: nowSec + 6 * 86400 },
      // 3.5 hours ago: even if the render-side clock was read a little earlier, truncating the hours does not give 2 h (not placed on a boundary)
      sevenDayFableReceivedAt: Date.now() - 3.5 * 3600_000
    })
    const { UsageBadge } = await import('../src/renderer/src/components/UsageBadge.js')
    await act(async () => {
      root.render(createElement(UsageBadge))
    })
    const button = container.querySelector<HTMLButtonElement>('.usage-badge button')
    expect(button?.textContent).toBe('5h 11% · 7d 1%')
    await act(async () => button?.click())
    const popover = container.querySelector('.usage-popover')
    expect(popover?.querySelectorAll('.usage-meter')).toHaveLength(3)
    expect(popover?.textContent).toContain(en['usage.sevenDayFable'])
    expect(popover?.textContent).toContain('7% used')
    expect(popover?.textContent).toContain('3 h ago')
  })

  it('does not show the badge at all when there is no value', async () => {
    ;(window as unknown as { aios: { usage: { get: () => Promise<null> } } }).aios.usage.get = async () => null
    const { UsageBadge } = await import('../src/renderer/src/components/UsageBadge.js')
    await act(async () => {
      root.render(createElement(UsageBadge))
    })
    expect(useUsage.getState().snapshot).toBeNull()
    expect(container.querySelector('.usage-badge')).toBeNull()
  })

  it('settings section: the two, ACCOUNT (Email) and USAGE', async () => {
    const { UsageSection } = await import('../src/renderer/src/components/UsageSection.js')
    await act(async () => {
      root.render(createElement(UsageSection))
    })
    const headings = [...container.querySelectorAll('.usage-heading')].map((h) => h.textContent)
    expect(headings).toEqual([en['usage.heading.account'], en['usage.heading.usage']])
    expect(container.querySelectorAll('.usage-meter')).toHaveLength(2)
    expect(container.textContent).not.toContain(en['usage.none'])
  })
})
