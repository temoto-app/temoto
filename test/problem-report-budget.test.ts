/**
 * TODO 1308 review: the problem report must not do the per-line work (parse, mask, redact) for lines past the budget,
 * and must give the event loop a turn on large inputs.
 */
import { describe, expect, it, vi } from 'vitest'

const redactCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../src/common/redact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/common/redact.js')>()
  return {
    ...actual,
    redactText: (text: string) => {
      redactCalls.count += 1
      return actual.redactText(text)
    }
  }
})

import { buildProblemReport, REPORT_YIELD_EVERY_LINES } from '../src/common/problem-report.js'

const build = { version: '0.99.0', commit: 'abc123', dirty: false, date: '' }
const runtime = { electron: '40', chromium: '140', node: '24', v8: '14', os: 'Darwin' }
const row = (o: Record<string, unknown>): string => JSON.stringify({ level: 'info', ...o })
const input = (lines: string[], extra: Partial<Parameters<typeof buildProblemReport>[0]> = {}): Parameters<typeof buildProblemReport>[0] => ({
  productName: 'Temoto',
  build,
  runtime,
  logs: [{ name: 'a.log', text: lines.join('\n') }],
  homeDir: '/Users/alice',
  userName: 'alice',
  now: new Date(2026, 10, 22),
  ...extra
})

describe('problem report cost', () => {
  it('does not redact lines past the budget, but still keeps crash records', async () => {
    const lines = [
      row({ event: 'window.renderer.gone', reason: 'crashed' }),
      ...Array.from({ length: 200 }, (_, i) => row({ event: `e${i}` })),
      row({ event: 'process.child.gone', reason: 'killed' })
    ]
    redactCalls.count = 0
    const text = await buildProblemReport(input(lines, { budgetBytes: 300, yieldFn: async () => {} }))
    // The newest lines fill the budget; the plain rows behind them are never masked.
    expect(redactCalls.count).toBeLessThan(20)
    const crashSection = text.split('## Recent log')[0] ?? ''
    expect(crashSection).toContain('process.child.gone')
    expect(crashSection).toContain('window.renderer.gone')
    expect(text).toContain('older lines left out')
  })

  it('yields to the event loop on a large input', async () => {
    const lines = Array.from({ length: REPORT_YIELD_EVERY_LINES * 4 + 10 }, (_, i) => row({ event: `e${i}` }))
    const yieldFn = vi.fn(async () => {})
    await buildProblemReport(input(lines, { yieldFn }))
    expect(yieldFn.mock.calls.length).toBeGreaterThanOrEqual(4)
  })
})
