/**
 * Item 280-4 (wave 15 bundle I): in a narrow pane the Plan toggle does not fill the bottom row.
 * jsdom evaluates neither layout nor container queries, so this is checked with the shape of the CSS rules and the shape of the Composer DOM
 * (how it looks on a real machine at 280 px is for the proxy verification / the owner to confirm).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
const composer = readFileSync(join(process.cwd(), 'src/renderer/src/components/Composer.tsx'), 'utf8')

/** The body of the last `selector { … }` that appears (the later rule wins, so the bundle I addition is checked). */
function lastRule(selector: string): string {
  const i = css.lastIndexOf(`\n${selector} {`)
  expect(i, selector).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', i)
  return css.slice(open + 1, css.indexOf('}', open))
}

describe('item 280-4: the lower row of a narrow pane', () => {
  it('.composer is a container (inline-size) and has a name', () => {
    const body = lastRule('.composer')
    expect(body).toContain('container-type: inline-size')
    expect(body).toContain('container-name: composer')
  })

  it('TODO 465: the Plan badge is `⏸ plan mode on` only while ON, and there is no rule for omitting `(shift+tab to cycle)`', () => {
    // The badge becomes a short notation shown only when ON, and the key has moved to the bubble (point (2) of 280-4 has finished its role).
    expect(css).not.toContain('.plan-toggle-hint')
    expect(composer).not.toContain('plan-toggle-hint')
    expect(composer).not.toContain("'composer.planCycle'")
  })

  it('the lower row can wrap (no overflow that cuts off the left); the Model / Thinking / usage columns can shrink and wrap', () => {
    expect(lastRule('.composer-actions')).toContain('flex-wrap: wrap')
    expect(lastRule('.composer-settings')).toContain('flex-wrap: wrap')
  })
})
