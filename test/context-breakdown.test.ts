/**
 * Pure functions for the breakdown of context usage (item 155, ARCHITECTURE.md 4.5.1).
 *
 * - Adapter: the response (the real one from spike 26, and the older shape without `kind`) -> a neutral shape (`readContextUsage`)
 * - main: path -> URI and "can it be opened" (`toContextBreakdown`)
 * - renderer: heading, horizontal bars, and table (`breakdownView` / `headerFromUsage` / `formatShare` / `breakdownColor`)
 * - Colors: `--ctx-*` exist in both light and dark in styles.css, and are the values that passed the dataviz validation as is
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fixture from './fixtures/context-usage-response.json'
import { loadCompatTable } from '../src/main/session/adapter/compat.js'
import { readContextUsage } from '../src/main/session/adapter/context-usage.js'
import { toContextBreakdown } from '../src/main/session/context-breakdown.js'
import {
  breakdownColor,
  breakdownView,
  formatShare,
  headerFromUsage
} from '../src/renderer/src/context-breakdown.js'
import { CONTEXT_TONES, type ContextBreakdown } from '../src/shared/context-breakdown.js'

const vocab = loadCompatTable().control.contextUsage!
const real = fixture.response.response

describe('readContextUsage (Adapter, item 155)', () => {
  it('the real thing: uses kind as is, and gives a color role only to the used row', () => {
    const usage = readContextUsage(real, vocab)!
    expect(usage.totalTokens).toBe(28845)
    // The full-state categories match the total (Messages takes the remainder, spike 26).
    const used = usage.categories.filter((c) => c.kind === 'used').reduce((sum, c) => sum + c.tokens, 0)
    expect(Math.abs(used - usage.totalTokens)).toBeLessThanOrEqual(1)
    const free = usage.categories.find((c) => c.kind === 'free')!
    expect(used + free.tokens).toBe(usage.maxTokens)
    expect(usage.categories.filter((c) => c.kind !== 'used').every((c) => c.tone === null)).toBe(true)
  })

  it('an old response without kind is split by name and isDeferred; a category not in the table is other', () => {
    const usage = readContextUsage(
      {
        totalTokens: 100,
        maxTokens: 1000,
        categories: [
          { name: 'System prompt', tokens: 40 },
          { name: 'MCP server instructions', tokens: 10 },
          { name: 'MCP tools (deferred)', tokens: 5, isDeferred: true },
          { name: 'Messages', tokens: 50 },
          { name: 'Autocompact buffer', tokens: 200 },
          { name: 'Free space', tokens: 700 },
          { name: 'broken', tokens: -1 },
          { tokens: 3 }
        ],
        memoryFiles: [{ path: '/a/CLAUDE.md', type: 'Project', tokens: 7 }, { path: '' }, 'x']
      },
      vocab
    )!
    expect(usage.categories.map((c) => [c.name, c.kind, c.tone])).toEqual([
      ['System prompt', 'used', 'system'],
      ['MCP server instructions', 'used', 'other'],
      ['MCP tools (deferred)', 'deferred', null],
      ['Messages', 'used', 'messages'],
      ['Autocompact buffer', 'buffer', null],
      ['Free space', 'free', null]
    ])
    expect(usage.memoryFiles).toEqual([{ path: '/a/CLAUDE.md', type: 'Project', tokens: 7 }])
    // Without percentage, computed from the total / window. Without model, null.
    expect(usage.percentage).toBe(10)
    expect(usage.model).toBeNull()
  })

  it('null when the total or the window cannot be read', () => {
    expect(readContextUsage(null, vocab)).toBeNull()
    expect(readContextUsage({ totalTokens: 1 }, vocab)).toBeNull()
    expect(readContextUsage({ totalTokens: 1, maxTokens: 0 }, vocab)).toBeNull()
  })

  it('every compat color role is a ContextTone', () => {
    for (const tone of Object.values(vocab.tones)) expect(CONTEXT_TONES).toContain(tone)
  })
})

describe('toContextBreakdown (main, item 155)', () => {
  it('turns paths into URIs and marks those that hit a choke point as not openable; drops relative paths', () => {
    const breakdown = toContextBreakdown(
      {
        model: 'm',
        totalTokens: 1,
        maxTokens: 10,
        percentage: 10,
        categories: [],
        memoryFiles: [
          { path: '/Users/me/p/CLAUDE.md', type: 'Project', tokens: 3 },
          { path: '/Users/me/.claude/CLAUDE.md', type: 'User', tokens: 4 },
          { path: 'relative.md', type: 'Project', tokens: 1 }
        ]
      },
      123,
      (uri) => !uri.includes('/.claude/')
    )
    expect(breakdown.at).toBe(123)
    expect(breakdown.memoryFiles).toEqual([
      { uri: 'file:///Users/me/p/CLAUDE.md', type: 'Project', tokens: 3, openable: true },
      { uri: 'file:///Users/me/.claude/CLAUDE.md', type: 'User', tokens: 4, openable: false }
    ])
  })
})

const sample: ContextBreakdown = {
  model: 'claude-x',
  totalTokens: 218_300,
  maxTokens: 1_000_000,
  percentage: 22,
  categories: [
    { name: 'System prompt', tokens: 8_000, kind: 'used', tone: 'system' },
    { name: 'System tools (deferred)', tokens: 20_000, kind: 'deferred', tone: null },
    { name: 'Free space', tokens: 748_700, kind: 'free', tone: null },
    { name: 'Messages', tokens: 210_300, kind: 'used', tone: 'messages' },
    { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer', tone: null },
    { name: 'Skills', tokens: 0, kind: 'used', tone: 'skills' }
  ],
  memoryFiles: [],
  at: 0
}

describe('breakdownView (renderer, item 155)', () => {
  it('the heading is the breakdown value, and the bar draws used → buffer → free without deferred and 0 rows', () => {
    const view = breakdownView(sample)
    expect(view.header).toEqual({ model: 'claude-x', used: '218.3k', max: '1.0M', percent: 22 })
    expect(view.bar.map((s) => s.name)).toEqual(['System prompt', 'Messages', 'Autocompact buffer', 'Free space'])
    expect(view.bar.reduce((sum, s) => sum + s.fraction, 0)).toBeCloseTo(1, 5)
  })

  it('the table is in the order used → free → buffer → deferred, the share is a decimal with 1 digit relative to the window, and deferred is —', () => {
    const view = breakdownView(sample)
    expect(view.rows.map((r) => [r.name, r.tokens, r.share])).toEqual([
      ['System prompt', '8.0k', '0.8%'],
      ['Messages', '210.3k', '21.0%'],
      ['Free space', '748.7k', '74.9%'],
      ['Autocompact buffer', '33.0k', '3.3%'],
      ['System tools (deferred)', '20.0k', null]
    ])
  })

  it('when the sum of categories exceeds the window, shrinks the bar proportionally (no overflow)', () => {
    const view = breakdownView({
      ...sample,
      maxTokens: 100,
      categories: [
        { name: 'Messages', tokens: 150, kind: 'used', tone: 'messages' },
        { name: 'System prompt', tokens: 50, kind: 'used', tone: 'system' }
      ]
    })
    expect(view.bar.reduce((sum, s) => sum + s.fraction, 0)).toBeCloseTo(1, 5)
  })

  it('the heading with no breakdown is the donut value; null when the window is unknown', () => {
    const usage = {
      model: 'claude-x',
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 1_000,
      cacheReadTokens: 20_000,
      contextWindow: 200_000,
      windowSource: 'reported' as const,
      at: 0
    }
    expect(headerFromUsage(usage)).toEqual({ model: 'claude-x', used: '21.0k', max: '200.0k', percent: 11 })
    expect(headerFromUsage({ ...usage, contextWindow: null })).toBeNull()
    expect(headerFromUsage(null)).toBeNull()
  })

  it('formatShare / breakdownColor', () => {
    expect(formatShare(1, 3)).toBe('33.3%')
    expect(formatShare(1, 0)).toBe('0.0%')
    expect(breakdownColor('used', 'memory')).toBe('var(--ctx-memory)')
    expect(breakdownColor('free', null)).toBe('var(--usage-free)')
    expect(breakdownColor('buffer', null)).toBe('var(--ctx-buffer)')
    expect(breakdownColor('deferred', null)).toBe('var(--ctx-deferred)')
  })
})

describe('category colors (7.4.1 / item 155)', () => {
  /**
   * The default 8 dataviz categorical colors, run through `validate_palette.js` in this order, and the values that passed
   * (light: surface #ffffff, adjacent CVD ΔE >= 9.1 / normal vision >= 19.6. Dark: surface #1b1d21, >= 8.4 / >= 19.3,
   * 3:1 or more for every color). If the values change, validation must be redone and this must be fixed too.
   */
  const VALIDATED = {
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
  }
  const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
  const block = (selector: string): string => {
    const start = css.indexOf(`${selector} {`)
    return css.slice(start, css.indexOf('\n}', start))
  }
  for (const [theme, selector] of [
    ['light', ':root'],
    ['dark', ':root[data-theme="dark"]']
  ] as const) {
    it(`${theme}: --ctx-<tone> is a verified value in the order of CONTEXT_TONES`, () => {
      const text = block(selector)
      const values = CONTEXT_TONES.map((tone) => new RegExp(`--ctx-${tone}:\\s*(#[0-9a-f]{6})`).exec(text)?.[1])
      expect(values).toEqual(VALIDATED[theme])
    })
  }
})
