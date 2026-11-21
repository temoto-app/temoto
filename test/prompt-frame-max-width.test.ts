/**
 * Item 353 (wave 19 bundle B): the question frame (`.question-prompt`, item 166), the permission request and plan approval
 * (`.question-prompt.approval-prompt`, item 182), and the Composer (`.composer`) are aligned to the same maximum width as the timeline
 * (`--timeline-max-width`, item 188). Left-aligned (no margin is added), and no new CSS variable is added.
 *
 * Same method as `schedule-form-css.test.ts` / `composer-narrow-css.test.ts`: the stylesheet is read
 * as text and the shape of the rules is checked. (jsdom does not compute the real layout, so whether the left and right edges look aligned has to be checked on a real device.)
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

/** The body of the rules for the given selector (concatenated if they are split across several places). */
function rulesFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g')
  return [...css.matchAll(re)].map((m) => m[1] ?? '').join('\n')
}

describe('item 353: align the width of questions, approvals, and the Composer to the timeline maximum', () => {
  it('.question-prompt has a maximum with the same variable as the timeline (both questions and approval frames use the same class)', () => {
    const rules = rulesFor('.question-prompt')
    expect(rules).toContain('max-width: var(--timeline-max-width)')
  })

  it('.composer also has a maximum with the same variable', () => {
    const rules = rulesFor('.composer')
    expect(rules).toContain('max-width: var(--timeline-max-width)')
  })

  it('left aligned (not centered with margin): neither rule writes margin: auto or margin-inline', () => {
    for (const selector of ['.question-prompt', '.composer']) {
      const rules = rulesFor(selector)
      expect(rules).not.toMatch(/margin(-inline)?:\s*(0\s+)?auto/)
    }
  })

  it('adds no new CSS variable (reuses the existing --timeline-max-width)', () => {
    const occurrences = css.match(/--timeline-max-width\s*:/g) ?? []
    // Defined only in the two blocks `:root` and `:root[data-theme="dark"]` (as in item 188, not increased).
    expect(occurrences.length).toBe(2)
  })

  it('permission requests and plan approval (ApprovalPrompt.tsx) render a className containing .question-prompt', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/ApprovalPrompt.tsx'),
      'utf8'
    )
    expect(source).toContain('className="question-prompt approval-prompt"')
  })

  it('the multiple choice question (QuestionPrompt.tsx) also renders the same .question-prompt', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/components/QuestionPrompt.tsx'), 'utf8')
    expect(source).toContain('className="question-prompt"')
  })
})
