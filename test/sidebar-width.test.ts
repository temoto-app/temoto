/**
 * Sidebar width (ARCHITECTURE.md 5.5.1, T24 / TODO 33).
 *
 * Unlike the pane ratio (`test/pane-ratio.test.ts`), this is in **px**. Three things to look at: it cannot be collapsed (it does not become 0); when the three boundaries line up, the minimum widths of ThreadPane / ViewerPane are kept on the right; and it renders with the default even when `localStorage` is broken.
 */
import { describe, expect, it } from 'vitest'
import { MIN_PANE_PX } from '@renderer/paneRatio.js'
import {
  ACTIVITY_BAR_PX,
  DEFAULT_SIDEBAR_WIDTH,
  DIVIDER_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
  SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
  loadSidebarWidth,
  maxSidebarWidth,
  saveSidebarWidth,
  widthFromPointer
} from '@renderer/sidebarWidth.js'
import type { PrefStorage } from '@renderer/uiPrefs.js'

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

describe('clampSidebarWidth', () => {
  it('180〜640px に丸め、0 には潰さない (折りたたみはドラッグの仕事ではない)', () => {
    expect(clampSidebarWidth(320)).toBe(320)
    expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN_PX)
    expect(clampSidebarWidth(-500)).toBe(SIDEBAR_MIN_PX)
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_PX)
  })

  it('整数 px にする (小数の幅は subpixel のちらつきになる)', () => {
    expect(clampSidebarWidth(320.4)).toBe(320)
    expect(clampSidebarWidth(320.6)).toBe(321)
  })

  it('壊れた値は既定に倒す', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  it('limit が最小幅より小さくても最小幅は守る', () => {
    expect(clampSidebarWidth(400, 10)).toBe(SIDEBAR_MIN_PX)
    expect(clampSidebarWidth(400, Number.NaN)).toBe(400)
  })
})

describe('maxSidebarWidth (窓が狭いときにどこから削るか)', () => {
  it('広い窓では上限 640px', () => {
    expect(maxSidebarWidth(2560, true)).toBe(SIDEBAR_MAX_PX)
  })

  it('ビューアが開いていると、右に 2 ペイン ぶんの最小幅を残す', () => {
    const host = 1200
    const limit = maxSidebarWidth(host, true)
    expect(limit).toBe(host - (ACTIVITY_BAR_PX + DIVIDER_PX * 2 + MIN_PANE_PX * 2))
    // With what remains, both panes get exactly their minimum width.
    expect(host - ACTIVITY_BAR_PX - DIVIDER_PX * 2 - limit).toBe(MIN_PANE_PX * 2)
  })

  it('ビューアが閉じていれば同じ窓でもサイドバーを広く取れる', () => {
    expect(maxSidebarWidth(1200, false)).toBeGreaterThan(maxSidebarWidth(1200, true))
    expect(maxSidebarWidth(1200, false)).toBe(SIDEBAR_MAX_PX)
  })

  it('3 つの境界が並んで入り切らない窓では最小幅に落ちる (そこから先は CSS の min-width)', () => {
    expect(maxSidebarWidth(700, true)).toBe(SIDEBAR_MIN_PX)
    expect(maxSidebarWidth(0, true)).toBe(SIDEBAR_MIN_PX)
  })

  it('幅が測れないときは上限を返す', () => {
    expect(maxSidebarWidth(Number.NaN, true)).toBe(SIDEBAR_MAX_PX)
  })
})

describe('widthFromPointer', () => {
  it('アイコンバーの右端 (48px) を原点に幅を出す', () => {
    expect(widthFromPointer(448, ACTIVITY_BAR_PX, SIDEBAR_MAX_PX)).toBe(400)
  })

  it('左へ振り切っても 180px で止まり、右は limit で止まる', () => {
    expect(widthFromPointer(0, ACTIVITY_BAR_PX, SIDEBAR_MAX_PX)).toBe(SIDEBAR_MIN_PX)
    expect(widthFromPointer(9999, ACTIVITY_BAR_PX, 500)).toBe(500)
  })

  it('座標が壊れていても既定を返す', () => {
    expect(widthFromPointer(Number.NaN, ACTIVITY_BAR_PX, SIDEBAR_MAX_PX)).toBe(
      DEFAULT_SIDEBAR_WIDTH
    )
  })
})

describe('localStorage への保存', () => {
  it('往復する (整数 px の文字列)', () => {
    const storage = memoryStorage()
    saveSidebarWidth(412, storage)
    expect(storage.data[SIDEBAR_WIDTH_KEY]).toBe('412')
    expect(loadSidebarWidth(storage)).toBe(412)
  })

  it('未保存 / 壊れた値 / 範囲外は既定に倒す', () => {
    expect(loadSidebarWidth(memoryStorage())).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(loadSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_KEY]: 'nope' }))).toBe(
      DEFAULT_SIDEBAR_WIDTH
    )
    expect(loadSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_KEY]: '0' }))).toBe(
      DEFAULT_SIDEBAR_WIDTH
    )
    expect(loadSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_KEY]: '5000' }))).toBe(
      DEFAULT_SIDEBAR_WIDTH
    )
  })

  it('範囲外は書かない', () => {
    const storage = memoryStorage()
    saveSidebarWidth(0, storage)
    saveSidebarWidth(5000, storage)
    saveSidebarWidth(Number.NaN, storage)
    expect(storage.data[SIDEBAR_WIDTH_KEY]).toBeUndefined()
  })

  it('storage が投げても / 無くても例外を漏らさない', () => {
    expect(loadSidebarWidth(throwingStorage)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(() => saveSidebarWidth(300, throwingStorage)).not.toThrow()
    expect(loadSidebarWidth(undefined)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(() => saveSidebarWidth(300, undefined)).not.toThrow()
  })
})

describe('定数が CSS と一致する (styles.css をいじったら落ちる)', () => {
  it('アイコンバー 48px / 仕切り 5px / サイドバー最小 180px', async () => {
    const { readFile } = await import('node:fs/promises')
    const css = await readFile(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    const block = (selector: string): string => {
      const at = css.indexOf(`${selector} {`)
      expect(at).toBeGreaterThan(-1)
      return css.slice(at, css.indexOf('}', at))
    }
    expect(block('.activity-bar')).toContain(`width: ${ACTIVITY_BAR_PX}px`)
    expect(block('.pane-divider')).toContain(`flex: 0 0 ${DIVIDER_PX}px`)
    expect(block('.sidebar-panel')).toContain(`min-width: ${SIDEBAR_MIN_PX}px`)
    expect(block('.sidebar-panel')).toContain(`var(--sidebar-width, ${DEFAULT_SIDEBAR_WIDTH}px)`)
    expect(block('.thread-pane')).toContain(`min-width: ${MIN_PANE_PX}px`)
  })
})
