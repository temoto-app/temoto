/**
 * TODO 351-1 (the 23rd run's proxy verification, wave 18 bundle D): the field labels and inputs in the scheduled-run form are pulled to the center.
 * The cause is that `.settings-item-control label` (specificity 0,1,1, `align-items: center`) beats `.schedule-field`
 * (0,1,0). Same method as `composer-narrow-css.test.ts` / `viewer-header-css.test.ts`
 * (the stylesheet is read as text and the shape of the rules is checked. jsdom does not compute the real layout, so whether they actually
 * align left has to be checked on a real device).
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

describe('351-1: the fields of the periodic run form are not centered', () => {
  it('label.schedule-field with align-items: stretch wins over center of .settings-item-control label', () => {
    const rules = rulesFor('label.schedule-field')
    expect(rules).toContain('align-items: stretch')
  })

  it('.schedule-field itself stays vertical (shared by div / label)', () => {
    const rules = rulesFor('.schedule-field')
    expect(rules).toContain('flex-direction: column')
  })

  it('to align specificity, the label.schedule-field rule comes after .settings-item-control label', () => {
    const conflict = css.indexOf('.settings-item-control label {')
    const fix = css.indexOf('label.schedule-field {')
    expect(conflict).toBeGreaterThan(-1)
    expect(fix).toBeGreaterThan(conflict)
  })
})
