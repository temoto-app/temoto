/**
 * Continuation of item 187 (wave 14 bundle P): the spacing, text size, and input width of the settings editor were matched to the real values in VS Code's CSS. It only reads the CSS to check the shape of the rules (the real `getComputedStyle` check is the owner's; see the bundle P table in `docs/notes/wave14.md`).
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

describe("margins and font sizes of settings items (matched to VS Code's setting-item-contents)", () => {
  it('.settings-item has the same padding as VS Code: 12px 14px 18px', () => {
    expect(ruleOf('.settings-item')).toContain('padding: 12px 14px 18px')
  })

  it('the title is 13px / 700, and the description is the same 13px as the title (not made smaller)', () => {
    const title = ruleOf('.settings-item-title')
    expect(title).toContain('font-size: 13px')
    expect(title).toContain('font-weight: 600')
    const description = ruleOf('.settings-item-description')
    expect(description).toContain('font-size: 13px')
    expect(description).toContain('line-height: 1.4')
  })

  it('the mark for changed from default is a vertical line 2px wide, same as VS Code', () => {
    expect(ruleOf('.settings-item-modified')).toContain('width: 2px')
  })

  it('the checkbox is 18x18px, same as VS Code', () => {
    const input = ruleOf('.settings-item-checkbox input')
    expect(input).toContain('width: 18px')
    expect(input).toContain('height: 18px')
  })
})

describe("widths of input fields (matched to VS Code's setting-item-control)", () => {
  it('a choice (enum) is 320px, same as VS Code', () => {
    expect(ruleOf('.settings-editor .settings-item-control select')).toContain('width: 320px')
  })

  it('the search field is 30px high with 14px text, same as VS Code', () => {
    const search = ruleOf('.settings-search')
    expect(search).toContain('height: 30px')
    expect(search).toContain('font-size: 14px')
  })

  it('each row of the table of contents has a 22px row height, same as VS Code', () => {
    expect(ruleOf('.settings-toc button')).toContain('line-height: 22px')
  })
})

describe("colors are tokens only (does not write VS Code's --vscode-* variables directly)", () => {
  it('the wave 14 bundle P section has no string --vscode-', () => {
    const markerStart = css.indexOf('Wave 14 bundle B: the settings editor')
    expect(markerStart).toBeGreaterThanOrEqual(0)
    const nextMarker = css.indexOf('\n/* The gear menu', markerStart)
    const section = css.slice(markerStart, nextMarker > 0 ? nextMarker : markerStart + 4000)
    expect(section).not.toContain('--vscode-')
  })
})
