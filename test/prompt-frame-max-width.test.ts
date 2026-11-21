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

describe('項目 353: 質問・承認・Composer の幅をタイムラインの上限に揃える', () => {
  it('.question-prompt はタイムラインと同じ変数で上限を持つ (質問と承認枠の両方が同じクラスを使う)', () => {
    const rules = rulesFor('.question-prompt')
    expect(rules).toContain('max-width: var(--timeline-max-width)')
  })

  it('.composer も同じ変数で上限を持つ', () => {
    const rules = rulesFor('.composer')
    expect(rules).toContain('max-width: var(--timeline-max-width)')
  })

  it('左寄せ (margin で中央寄せにしていない): どちらの規則にも margin: auto / margin-inline を書かない', () => {
    for (const selector of ['.question-prompt', '.composer']) {
      const rules = rulesFor(selector)
      expect(rules).not.toMatch(/margin(-inline)?:\s*(0\s+)?auto/)
    }
  })

  it('新しい CSS 変数は足さない (既存の --timeline-max-width を再利用する)', () => {
    const occurrences = css.match(/--timeline-max-width\s*:/g) ?? []
    // Defined only in the two blocks `:root` and `:root[data-theme="dark"]` (as in item 188, not increased).
    expect(occurrences.length).toBe(2)
  })

  it('権限の要求・計画の承認 (ApprovalPrompt.tsx) は .question-prompt を含む className を描く', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/ApprovalPrompt.tsx'),
      'utf8'
    )
    expect(source).toContain('className="question-prompt approval-prompt"')
  })

  it('選択式の質問 (QuestionPrompt.tsx) も同じ .question-prompt を描く', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/components/QuestionPrompt.tsx'), 'utf8')
    expect(source).toContain('className="question-prompt"')
  })
})
