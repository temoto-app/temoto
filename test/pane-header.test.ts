/**
 * Items 190 / 188 (wave 14 bundle E): the matching heading heights, and the upper limit on the timeline width.
 * Only reads the CSS to check the shape of the rules (the owner checks `getComputedStyle` on the real app).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

/** The body of the first rule that starts with the selector itself. */
function ruleOf(selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, selector).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', start)
  return css.slice(open + 1, css.indexOf('}', open))
}

describe('会話と viewer の見出し (項目 190)', () => {
  it('2 つの見出しは同じ変数で高さを固定し、同じ下線 (1px + 虹色 2px) を持つ', () => {
    for (const selector of ['.thread-header', '.viewer-header']) {
      const body = ruleOf(selector)
      expect(body).toContain('height: var(--pane-header-height)')
      expect(body).toContain('border-bottom: 1px solid var(--line)')
      expect(body).toContain('box-shadow: inset 0 -2px 0 var(--thread-accent, transparent)')
      expect(body).toMatch(/padding: 0 \d+px/)
    }
  })

  it('状態の札と指示ファイルの札の規則は残っていない', () => {
    expect(css).not.toMatch(/^\.thread-state\b/m)
    expect(css).not.toMatch(/^\.thread-instructions\b/m)
  })
})

describe('タイムラインの幅の上限 (項目 188)', () => {
  it('.thread-body の子ごとに上限を掛け、中央寄せにしない', () => {
    const body = ruleOf('.thread-body > *')
    expect(body).toContain('max-width: var(--timeline-max-width)')
    expect(body).not.toContain('margin')
  })

  it('上限は見出しにも .thread-body 自体にも掛けない', () => {
    expect(ruleOf('.thread-body')).not.toContain('max-width')
    expect(ruleOf('.thread-header')).not.toContain('max-width')
  })
})

describe('作業リスト・子エージェントの一覧もタイムラインと同じ上限 (項目 188 の残り、第 14 波 束 L)', () => {
  it('.todo-list / .subtask-list は同じ変数で上限を掛け、中央寄せにしない (margin は付けない)', () => {
    for (const selector of ['.todo-list', '.subtask-list']) {
      const body = ruleOf(selector)
      expect(body).toContain('max-width: var(--timeline-max-width)')
      expect(body).not.toContain('margin')
    }
  })

  it('質問 / 承認の画面と Composer も同じ上限に揃える (項目 353、第 19 波 束 B で 188 の決定を上書き)', () => {
    // Both the question (QuestionPrompt) and the approval / plan (ApprovalPrompt) have `.question-prompt` (`ApprovalOrComposer`, item 166). The old approval box `.approval-inline` was removed by item 166.
    // At the time of 188 the rule was "the Composer applies no limit", but at 353 (2026-10-03) the owner decided to align the left and right edges of the timeline, the approval box, the questions and the Composer, so the expectation here is the opposite.
    for (const selector of ['.question-prompt', '.composer']) {
      const body = ruleOf(selector)
      expect(body).toContain('max-width: var(--timeline-max-width)')
      expect(body).not.toContain('margin')
    }
  })
})

describe('見出しの MCP の一覧 (項目 245、第 14 波 束 S)', () => {
  it('.thread-mcp-list は札の左端ではなく右端 (見出しの右端寄り) に揃える', () => {
    const body = ruleOf('.thread-mcp-list')
    expect(body).toContain('right: 0')
    expect(body).not.toMatch(/(?<!-)\bleft:\s*0\b/)
  })

  it('一覧の幅は窓の幅を超えない (100vw 基準の上限)', () => {
    const body = ruleOf('.thread-mcp-list')
    expect(body).toMatch(/max-width:\s*min\(\s*\d+px\s*,\s*calc\(100vw\s*-\s*\d+px\)\s*\)/)
  })

  it('札 (.thread-mcp) は position: relative を保つ (一覧の right: 0 の基準)', () => {
    expect(ruleOf('.thread-mcp')).toContain('position: relative')
  })
})
