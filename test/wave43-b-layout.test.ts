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

describe('868: thumbnails of sent images', () => {
  it('a larger display that keeps the aspect ratio, not a 64px crop', () => {
    const body = rule('.user-attachment-thumb')
    expect(body).not.toMatch(/64px/)
    expect(body).toMatch(/object-fit:\s*contain/)
    expect(body).toMatch(/height:\s*128px/)
    expect(body).toMatch(/max-width:\s*240px/)
  })
})

describe('870: file name search rows use the measured height', () => {
  const src = readFileSync('src/renderer/src/components/SearchMode.tsx', 'utf8')
  it('attaches measureElement to hit and name rows, and gives those rows no fixed height', () => {
    expect(src).toMatch(/ref=\{measured \? virtualizer\.measureElement : undefined\}/)
    expect(src).toMatch(/height: measured \? undefined/)
  })
})

describe('873: the Prompt field of scheduled runs', () => {
  it('full width, 12 rows, vertically resizable (the shared settings class is left as is)', () => {
    const src = readFileSync('src/renderer/src/components/ScheduleEditor.tsx', 'utf8')
    expect(src).toMatch(/className="settings-textarea schedule-prompt"\s+rows=\{12\}/)
    expect(css).toMatch(/\.settings-textarea\.schedule-prompt\s*\{\s*width:\s*100%/)
    expect(css).toMatch(/\.settings-textarea \{[^}]*width:\s*min\(100%,\s*480px\)[^}]*resize:\s*vertical/)
  })
})

describe('886: thumbnails of Composer image chips', () => {
  it('height 72px, keeps the aspect ratio, width up to 160px', () => {
    const body = rule('.attachment-thumb')
    expect(body).toMatch(/object-fit:\s*contain/)
    expect(body).toMatch(/height:\s*72px/)
    expect(body).toMatch(/max-width:\s*160px/)
  })
})
