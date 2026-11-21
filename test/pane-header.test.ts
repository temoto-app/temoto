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

describe('headings of the conversation and viewer (item 190)', () => {
  it('the 2 headings fix the height with the same variable and have the same underline (1px + rainbow 2px)', () => {
    for (const selector of ['.thread-header', '.viewer-header']) {
      const body = ruleOf(selector)
      expect(body).toContain('height: var(--pane-header-height)')
      expect(body).toContain('border-bottom: 1px solid var(--line)')
      expect(body).toContain('box-shadow: inset 0 -2px 0 var(--thread-accent, transparent)')
      expect(body).toMatch(/padding: 0 \d+px/)
    }
  })

  it('the rules for the status badge and the instruction file badge no longer remain', () => {
    expect(css).not.toMatch(/^\.thread-state\b/m)
    expect(css).not.toMatch(/^\.thread-instructions\b/m)
  })
})

describe('timeline width limit (item 188)', () => {
  it('applies the limit to each child of .thread-body and does not center it', () => {
    const body = ruleOf('.thread-body > *')
    expect(body).toContain('max-width: var(--timeline-max-width)')
    expect(body).not.toContain('margin')
  })

  it('does not apply the limit to the heading or to .thread-body itself', () => {
    expect(ruleOf('.thread-body')).not.toContain('max-width')
    expect(ruleOf('.thread-header')).not.toContain('max-width')
  })
})

describe('the work list and the child agent list get the same limit as the timeline (the rest of item 188, wave 14 bundle L)', () => {
  it('.todo-list / .subtask-list apply the limit with the same variable and are not centered (no margin)', () => {
    for (const selector of ['.todo-list', '.subtask-list']) {
      const body = ruleOf(selector)
      expect(body).toContain('max-width: var(--timeline-max-width)')
      expect(body).not.toContain('margin')
    }
  })

  it('the question / approval screens and the Composer also share the same limit (item 353, overriding the decision of 188 in wave 19 bundle B)', () => {
    // Both the question (QuestionPrompt) and the approval / plan (ApprovalPrompt) have `.question-prompt` (`ApprovalOrComposer`, item 166). The old approval box `.approval-inline` was removed by item 166.
    // At the time of 188 the rule was "the Composer applies no limit", but at 353 (2026-10-03) the owner decided to align the left and right edges of the timeline, the approval box, the questions and the Composer, so the expectation here is the opposite.
    for (const selector of ['.question-prompt', '.composer']) {
      const body = ruleOf(selector)
      expect(body).toContain('max-width: var(--timeline-max-width)')
      expect(body).not.toContain('margin')
    }
  })
})

describe('MCP list in the heading (item 245, wave 14 bundle S)', () => {
  it("aligns .thread-mcp-list to the right edge (near the heading's right edge), not the badge's left edge", () => {
    const body = ruleOf('.thread-mcp-list')
    expect(body).toContain('right: 0')
    expect(body).not.toMatch(/(?<!-)\bleft:\s*0\b/)
  })

  it('the list width does not exceed the window width (limit based on 100vw)', () => {
    const body = ruleOf('.thread-mcp-list')
    expect(body).toMatch(/max-width:\s*min\(\s*\d+px\s*,\s*calc\(100vw\s*-\s*\d+px\)\s*\)/)
  })

  it("the badge (.thread-mcp) keeps position: relative (the reference for the list's right: 0)", () => {
    expect(ruleOf('.thread-mcp')).toContain('position: relative')
  })
})
