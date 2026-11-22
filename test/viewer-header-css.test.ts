/**
 * Observation for item 333 (wave 18, owner decision 2026-10-03): in a narrow viewer (about 330px), the JA heading 'saved' wraps one character per line vertically.
 * The observation for 312 that Save (⌘S) wraps to two lines at width 280px is also fixed by the same change.
 *
 * The fix is CSS only: `white-space: nowrap` + `flex-shrink: 0` on `.viewer-header > button`, and the shrinking role is concentrated in `.viewer-path`
 * (`min-width: 0`, shrinks with an ellipsis). Colors are only CSS variables (checked separately by `test/theme-tokens.test.ts`).
 * In the same manner as `composer-narrow-css.test.ts`, the stylesheet is read as text and the shape of the rules is checked (jsdom does not compute the real layout).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

/** The contents of the rules for the given selector (concatenated if they are split across several places). */
function rulesFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g')
  return [...css.matchAll(re)].map((m) => m[1] ?? '').join('\n')
}

describe('item 333: button text in a narrow viewer header does not wrap vertically', () => {
  it('.viewer-header > button does not wrap and does not shrink', () => {
    const rules = rulesFor('.viewer-header > button')
    expect(rules).toContain('white-space: nowrap')
    expect(rules).toContain('flex-shrink: 0')
  })

  it('.viewer-path is the shrinking side (min-width: 0) and stretches and shrinks inside the header', () => {
    const rules = rulesFor('.viewer-path')
    expect(rules).toContain('min-width: 0')
    expect(rules).toMatch(/flex:\s*1/)
    // The existing ellipsis promise is unchanged
    expect(rules).toContain('overflow: hidden')
    expect(rules).toContain('text-overflow: ellipsis')
    expect(rules).toContain('white-space: nowrap')
  })

  it('the plugin id is not shown in the header (TODO 1299): no .viewer-id rule is left', () => {
    expect(css).not.toContain('.viewer-id')
  })
})
