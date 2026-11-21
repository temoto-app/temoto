/**
 * Wave 43 bundle B (868 / 870 / 873): visual regression. jsdom applies no CSS, so it is checked with the strings of styles.css and the components.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/renderer/src/styles.css', 'utf8')
const rule = (selector: string): string => {
  const at = css.indexOf(`\n${selector} {`)
  expect(at).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('}', at))
}

describe('868: 送った画像のサムネイル', () => {
  it('64px の切り抜きではなく、縦横比を保つ大きめの表示', () => {
    const body = rule('.user-attachment-thumb')
    expect(body).not.toMatch(/64px/)
    expect(body).toMatch(/object-fit:\s*contain/)
    expect(body).toMatch(/height:\s*128px/)
    expect(body).toMatch(/max-width:\s*240px/)
  })
})

describe('870: ファイル名検索の行は実測の高さ', () => {
  const src = readFileSync('src/renderer/src/components/SearchMode.tsx', 'utf8')
  it('measureElement をヒット・名前の行に付け、その行には固定の height を付けない', () => {
    expect(src).toMatch(/ref=\{measured \? virtualizer\.measureElement : undefined\}/)
    expect(src).toMatch(/height: measured \? undefined/)
  })
})

describe('873: 予約実行の Prompt 欄', () => {
  it('幅いっぱい・12 行・縦リサイズ可 (設定の共用 class は据え置き)', () => {
    const src = readFileSync('src/renderer/src/components/ScheduleEditor.tsx', 'utf8')
    expect(src).toMatch(/className="settings-textarea schedule-prompt"\s+rows=\{12\}/)
    expect(css).toMatch(/\.settings-textarea\.schedule-prompt\s*\{\s*width:\s*100%/)
    expect(css).toMatch(/\.settings-textarea \{[^}]*width:\s*min\(100%,\s*480px\)[^}]*resize:\s*vertical/)
  })
})

describe('886: Composer の画像チップのサムネイル', () => {
  it('高さ 72px・縦横比を保つ・幅は 160px まで', () => {
    const body = rule('.attachment-thumb')
    expect(body).toMatch(/object-fit:\s*contain/)
    expect(body).toMatch(/height:\s*72px/)
    expect(body).toMatch(/max-width:\s*160px/)
  })
})
