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

describe('productNameFor / windowTitleFor (項目 225)', () => {
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate('ja', key, params)

  it('既定の userData (null) では手を加えない', () => {
    expect(productNameFor(t, 'aios', null)).toBe('aios')
    expect(windowTitleFor(t, 'aios', null)).toBeNull()
  })

  it('既定以外の userData では製品名に「(複製)」を添える', () => {
    expect(productNameFor(t, 'aios', '/tmp/aios-v18')).toBe('aios (複製)')
  })

  it('既定以外の userData では document.title を「名前 (複製) — パス」の形にする', () => {
    expect(windowTitleFor(t, 'aios', '/tmp/aios-v18')).toBe('aios (複製) — /tmp/aios-v18')
  })

  it('EN でも同じ形 (複製 → copy)', () => {
    const tEn = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
      translate('en', key, params)
    expect(productNameFor(tEn, 'aios', '/tmp/x')).toBe('aios (copy)')
    expect(windowTitleFor(tEn, 'aios', '/tmp/x')).toBe('aios (copy) — /tmp/x')
  })
})

describe('.instance-banner の CSS (項目 225: 薄い地は目立たなかった、濃い塗りに白文字)', () => {
  it('--danger の塗りに --danger-on の文字を使う (--danger-bg / --danger-fg の薄い地ではない)', () => {
    const body = ruleOf('.instance-banner')
    expect(body).toContain('background: var(--danger)')
    expect(body).toContain('color: var(--danger-on)')
    expect(body).not.toContain('var(--danger-bg)')
    expect(body).not.toContain('color: var(--danger-fg)')
  })
})
