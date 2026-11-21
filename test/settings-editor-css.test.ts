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

describe('設定項目の余白と文字サイズ (VS Code の setting-item-contents に合わせた)', () => {
  it('.settings-item は VS Code と同じ padding: 12px 14px 18px', () => {
    expect(ruleOf('.settings-item')).toContain('padding: 12px 14px 18px')
  })

  it('題名は 13px / 700 で、説明は題名と同じ 13px (小さくしない)', () => {
    const title = ruleOf('.settings-item-title')
    expect(title).toContain('font-size: 13px')
    expect(title).toContain('font-weight: 600')
    const description = ruleOf('.settings-item-description')
    expect(description).toContain('font-size: 13px')
    expect(description).toContain('line-height: 1.4')
  })

  it('既定から変えた印は VS Code と同じ 2px 幅の縦線', () => {
    expect(ruleOf('.settings-item-modified')).toContain('width: 2px')
  })

  it('チェックボックスは VS Code と同じ 18x18px', () => {
    const input = ruleOf('.settings-item-checkbox input')
    expect(input).toContain('width: 18px')
    expect(input).toContain('height: 18px')
  })
})

describe('入力欄の幅 (VS Code の setting-item-control に合わせた)', () => {
  it('選択式 (enum) は VS Code と同じ 320px', () => {
    expect(ruleOf('.settings-editor .settings-item-control select')).toContain('width: 320px')
  })

  it('検索欄は VS Code と同じ 30px の高さ・14px の文字', () => {
    const search = ruleOf('.settings-search')
    expect(search).toContain('height: 30px')
    expect(search).toContain('font-size: 14px')
  })

  it('目次の各行は VS Code と同じ 22px の行の高さ', () => {
    expect(ruleOf('.settings-toc button')).toContain('line-height: 22px')
  })
})

describe('色はトークンだけ (VS Code の --vscode-* 変数を直書きしていない)', () => {
  it('第 14 波 束 P の節に --vscode- という文字列が無い', () => {
    const markerStart = css.indexOf('Wave 14 bundle B: the settings editor')
    expect(markerStart).toBeGreaterThanOrEqual(0)
    const nextMarker = css.indexOf('\n/* The gear menu', markerStart)
    const section = css.slice(markerStart, nextMarker > 0 ? nextMarker : markerStart + 4000)
    expect(section).not.toContain('--vscode-')
  })
})
