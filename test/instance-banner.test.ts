/**
 * item 225 (wave 14 bundle S): tell a duplicate window apart not only by the band but also in the title bar and document.title.
 * Checks the input and output of the pure functions (`productNameFor` / `windowTitleFor`) and whether the band's CSS uses a dark fill.
 * Does not start the GUI.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { productNameFor, windowTitleFor } from '../src/renderer/src/instance-label.js'
import { translate } from '../src/renderer/src/i18n/index.js'

const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

function ruleOf(selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, selector).toBeGreaterThanOrEqual(0)
  const open = css.indexOf('{', start)
  return css.slice(open + 1, css.indexOf('}', open))
}

describe('productNameFor / windowTitleFor (item 225)', () => {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate('ja', key, params)

  it('with the default userData (null) nothing is added', () => {
    expect(productNameFor(t, 'aios', null)).toBe('aios')
    expect(windowTitleFor(t, 'aios', null)).toBeNull()
  })

  it('with a non-default userData, 「(複製)」 is added to the product name', () => {
    expect(productNameFor(t, 'aios', '/tmp/aios-v18')).toBe('aios (複製)')
  })

  it('with a non-default userData, document.title takes the form 「名前 (複製) — パス」', () => {
    expect(windowTitleFor(t, 'aios', '/tmp/aios-v18')).toBe('aios (複製) — /tmp/aios-v18')
  })

  it('the same form in EN (the suffix becomes copy)', () => {
    const tEn = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate('en', key, params)
    expect(productNameFor(tEn, 'aios', '/tmp/x')).toBe('aios (copy)')
    expect(windowTitleFor(tEn, 'aios', '/tmp/x')).toBe('aios (copy) — /tmp/x')
  })
})

describe('.instance-banner CSS (item 225: a pale background was not noticeable, so a dark fill with white text)', () => {
  it('uses the --danger-on text on the --danger fill (not the pale --danger-bg / --danger-fg background)', () => {
    const body = ruleOf('.instance-banner')
    expect(body).toContain('background: var(--danger)')
    expect(body).toContain('color: var(--danger-on)')
    expect(body).not.toContain('var(--danger-bg)')
    expect(body).not.toContain('color: var(--danger-fg)')
  })
})
