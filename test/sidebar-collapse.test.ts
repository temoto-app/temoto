/**
 * Sidebar collapse (ARCHITECTURE.md 5.5.1 'Collapse', T27 / TODO 38).
 *
 * Four things to look at:
 * 1. Pressing an icon again is a **toggle**, and an icon for a different mode **opens** it.
 * 2. The ⌘B (menu) toggle does not change the mode.
 * 3. **A width of 0 is not saved**: collapsing leaves `aios.sidebarWidth` intact, and opening restores it.
 * 4. It renders as 'open' even when `localStorage` is broken or missing.
 */
import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_COLLAPSED_KEY,
  loadSidebarCollapsed,
  pressMode,
  saveSidebarCollapsed,
  toggleCollapsed
} from '@renderer/sidebarCollapse.js'
import {
  SIDEBAR_WIDTH_KEY,
  loadSidebarWidth,
  saveSidebarWidth
} from '@renderer/sidebarWidth.js'
import type { PrefStorage } from '@renderer/uiPrefs.js'

type Mode = 'threads' | 'files' | 'search'

function memoryStorage(initial: Record<string, string> = {}): PrefStorage & {
  data: Record<string, string>
} {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    }
  }
}

const throwingStorage: PrefStorage = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  }
}

describe('pressMode (アイコンバーの押下)', () => {
  it('いま出ているモードをもう一度押すと畳む', () => {
    expect(pressMode<Mode>({ mode: 'threads', collapsed: false }, 'threads')).toEqual({
      mode: 'threads',
      collapsed: true
    })
  })

  it('畳んだ状態で同じアイコンを押すと開く (復帰の導線はここ)', () => {
    expect(pressMode<Mode>({ mode: 'threads', collapsed: true }, 'threads')).toEqual({
      mode: 'threads',
      collapsed: false
    })
  })

  it('畳んでいるときに別のモードを押したら、そのモードで開く', () => {
    expect(pressMode<Mode>({ mode: 'threads', collapsed: true }, 'search')).toEqual({
      mode: 'search',
      collapsed: false
    })
  })

  it('開いているときに別のモードを押したらモードだけ変わる (畳まない)', () => {
    expect(pressMode<Mode>({ mode: 'files', collapsed: false }, 'search')).toEqual({
      mode: 'search',
      collapsed: false
    })
  })
})

describe('toggleCollapsed (⌘B)', () => {
  it('モードは変えずに畳む / 開くを入れ替える', () => {
    expect(toggleCollapsed<Mode>({ mode: 'search', collapsed: false })).toEqual({
      mode: 'search',
      collapsed: true
    })
    expect(toggleCollapsed<Mode>({ mode: 'search', collapsed: true })).toEqual({
      mode: 'search',
      collapsed: false
    })
  })

  it('2 回で元に戻る', () => {
    const view = { mode: 'files' as Mode, collapsed: false }
    expect(toggleCollapsed(toggleCollapsed(view))).toEqual(view)
  })
})

describe('localStorage への保存', () => {
  it("往復する ('1' / '0' の形)", () => {
    const storage = memoryStorage()
    saveSidebarCollapsed(true, storage)
    expect(storage.data[SIDEBAR_COLLAPSED_KEY]).toBe('1')
    expect(loadSidebarCollapsed(storage)).toBe(true)
    saveSidebarCollapsed(false, storage)
    expect(storage.data[SIDEBAR_COLLAPSED_KEY]).toBe('0')
    expect(loadSidebarCollapsed(storage)).toBe(false)
  })

  it('未保存 / 壊れた値は「開いている」に倒す', () => {
    expect(loadSidebarCollapsed(memoryStorage())).toBe(false)
    expect(loadSidebarCollapsed(memoryStorage({ [SIDEBAR_COLLAPSED_KEY]: 'true' }))).toBe(false)
    expect(loadSidebarCollapsed(memoryStorage({ [SIDEBAR_COLLAPSED_KEY]: '' }))).toBe(false)
  })

  it('storage が投げても / 無くても例外を漏らさない', () => {
    expect(loadSidebarCollapsed(throwingStorage)).toBe(false)
    expect(() => saveSidebarCollapsed(true, throwingStorage)).not.toThrow()
    expect(loadSidebarCollapsed(undefined)).toBe(false)
    expect(() => saveSidebarCollapsed(true, undefined)).not.toThrow()
  })
})

describe('幅と畳んだ状態は別の値', () => {
  it('畳んでも覚えていた幅は無傷で、開いたらそこへ戻る (0 を幅として保存しない)', () => {
    const storage = memoryStorage()
    saveSidebarWidth(412, storage)
    saveSidebarCollapsed(true, storage)
    expect(storage.data[SIDEBAR_WIDTH_KEY]).toBe('412')
    expect(loadSidebarWidth(storage)).toBe(412)
    saveSidebarCollapsed(false, storage)
    expect(loadSidebarWidth(storage)).toBe(412)
  })

  it('別のキーを使う (片方の保存が他方を壊さない)', () => {
    expect(SIDEBAR_COLLAPSED_KEY).not.toBe(SIDEBAR_WIDTH_KEY)
  })
})

describe('畳んでいるときのアイコンの見た目 (styles.css をいじったら落ちる)', () => {
  it('.activity-item.current があり、アクセント帯 (box-shadow) は出さない', async () => {
    const { readFile } = await import('node:fs/promises')
    const css = await readFile(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    const block = (selector: string): string => {
      const at = css.indexOf(`${selector} {`)
      expect(at).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    expect(block('.activity-item.current')).not.toContain('box-shadow')
    expect(block('.activity-item.current')).toContain('var(--fg-strong)')
    // When open, the band is shown (as in T14).
    expect(block('.activity-item.active')).toContain('var(--accent)')
  })

  it('TODO 528: .threads-pulsing は明滅し、reduced-motion では止まる', async () => {
    const { readFile } = await import('node:fs/promises')
    const css = await readFile(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    const block = (selector: string): string => {
      const at = css.indexOf(`${selector} {`)
      expect(at).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    expect(block('.activity-item.threads-pulsing svg')).toContain('animation')
    expect(css).toContain('@keyframes threads-pulse')
    // TODO 830: the strengthened period and width, and the dot while a response is in progress (color is only in CSS variables; the unread dot is at the top right, so the one here is at the bottom right).
    expect(block('.activity-item.threads-pulsing svg')).toContain('1.1s')
    expect(css.slice(css.indexOf('@keyframes threads-pulse'))).toContain('opacity: 0.25')
    const dotCss = block('.activity-item.threads-pulsing::after')
    expect(dotCss).toContain('var(--accent)')
    expect(dotCss).toContain('bottom:')
    // Inside the reduced-motion block it falls back to animation: none (same handling as the rotation section).
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('threads-pulse')))
    expect(reduced.slice(0, reduced.indexOf('}', reduced.indexOf('}') + 1))).toContain(
      '.activity-item.threads-pulsing svg'
    )
  })
})
