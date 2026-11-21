/**
 * Machine checks of the color theme rules (ARCHITECTURE.md 7.4.1).
 *
 *   1. Hard-coded colors (`#…` / `rgb(a)(…)`) appear only in the two blocks `:root` and `:root[data-theme="dark"]`. The only exceptions are those listed explicitly in ALLOWED below.
 *   2. Light and dark define **the same set of variable names** (if a name is added to only one, then when switching, that color keeps the value of the previous theme).
 *   3. The body text (`--fg` / `--bg`) is 7:1 or higher, and the subdued text (`--fg-dim`) is 4.5:1 or higher.
 *
 * The same rules apply to both the renderer (styles.css) and the viewer (plugins/_shared/viewer.css). The viewer is in a separate origin's iframe and cannot receive the parent's variables, so it holds its own variables with the same names.
 *   4. The syntax colors of code blocks (`--hl-*`, T6) are also 4.5:1 or higher on `--code-bg`.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Allows hard-coded colors (file, selector, value). Only where 'staying dark is correct'. */
const ALLOWED: readonly { file: string; selector: string; literal: string }[] = [
  // The image backdrop is correctly dark, for how transparent PNGs look. It does not change with the theme.
  { file: 'src/renderer/src/styles.css', selector: '.image-viewer img', literal: '#000' },
  // The highlight of search terms in File search (TODO 56) is a fixed color specified by the owner (yellow background, black text).
  { file: 'plugins/_shared/viewer.css', selector: '.cm-searchHit, .cm-searchHit *', literal: '#ffff00' },
  { file: 'plugins/_shared/viewer.css', selector: '.cm-searchHit, .cm-searchHit *', literal: '#000000' },
  // The letterbox of video (TODO 405, aios.video). For the same reason as the image backdrop (`.image-viewer img`), it does not change with the theme.
  { file: 'plugins/_shared/viewer.css', selector: '.video-viewer', literal: '#000' }
]

const STYLESHEETS = ['src/renderer/src/styles.css', 'plugins/_shared/viewer.css'] as const

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/g
const TOKEN_BLOCK = /:root(\[[^\]]*\])?\s*\{([^}]*)\}/g

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

interface TokenBlocks {
  light: Record<string, string>
  dark: Record<string, string>
  lightRaw: string
  darkRaw: string
}

function parseVars(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim()
  return out
}

function tokenBlocks(css: string): TokenBlocks {
  let lightRaw = ''
  let darkRaw = ''
  for (const m of css.matchAll(TOKEN_BLOCK)) {
    if (m[1] === undefined) lightRaw = m[2]!
    else if (m[1] === '[data-theme="dark"]') darkRaw = m[2]!
  }
  return { light: parseVars(lightRaw), dark: parseVars(darkRaw), lightRaw, darkRaw }
}

/** From the body with the token block removed, lists the hard-coded colors as (selector, value, line). */
export function findHardcodedColors(css: string): { selector: string; literal: string; line: number }[] {
  const text = stripComments(css).replace(TOKEN_BLOCK, (m) => m.replace(/[^\n]/g, ' '))
  const found: { selector: string; literal: string; line: number }[] = []
  for (const m of text.matchAll(COLOR_LITERAL)) {
    const index = m.index ?? 0
    const before = text.slice(0, index)
    const open = before.lastIndexOf('{')
    const close = before.lastIndexOf('}', open)
    const selector = before.slice(close + 1, open).trim().replace(/\s+/g, ' ')
    const literal = m[0].endsWith('(') ? m[0] + text.slice(index + m[0].length).split(')')[0] + ')' : m[0]
    found.push({ selector, literal, line: before.split('\n').length })
  }
  return found
}

// ---- Contrast (WCAG 2.x relative luminance) ----

function channel(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (m === null) throw new Error(`6 桁の #rrggbb で書くこと: ${hex}`)
  const n = parseInt(m[1]!, 16)
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff)
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Checked in both themes: (foreground, background, minimum ratio). */
const CONTRAST_PAIRS: readonly [string, string, number][] = [
  ['--fg', '--bg', 7],
  ['--fg', '--bg-raised', 7],
  ['--fg-dim', '--bg', 4.5],
  ['--fg-dim', '--bg-raised', 4.5],
  // TODO 432: the placeholder is a dedicated variable, even fainter than the 'subdued text' (--fg-dim). It is 3:1, the same as VS Code's default placeholder (not 4.5:1).
  ['--placeholder-fg', '--bg', 3],
  ['--accent', '--bg', 4.5],
  // Syntax coloring of code blocks (5.1.2, T6). Must be readable on the code surface.
  ['--hl-keyword', '--code-bg', 4.5],
  ['--hl-string', '--code-bg', 4.5],
  ['--hl-comment', '--code-bg', 4.5],
  ['--hl-number', '--code-bg', 4.5],
  ['--hl-type', '--code-bg', 4.5],
  ['--hl-function', '--code-bg', 4.5],
  ['--hl-variable', '--code-bg', 4.5],
  ['--hl-meta', '--code-bg', 4.5]
]

/** The state colors and surfaces that exist only in styles.css. Each must be readable on its own background. */
const STATE_PAIRS: readonly [string, string, number][] = [
  // The vertical icon bar (5.3, T14). Both the unselected (--fg-dim) and the selected (--fg-strong) must be readable.
  ['--fg-dim', '--activity-bg', 4.5],
  ['--fg-strong', '--activity-bg', 7],
  ['--warn-fg', '--bg', 4.5],
  ['--warn-fg', '--warn-bg', 4.5],
  ['--warn-fg', '--approval-bg', 4.5],
  ['--warn-fg', '--approval-stale-bg', 4.5],
  ['--danger-fg', '--bg', 4.5],
  ['--danger-fg', '--danger-bg', 4.5],
  ['--ok-fg', '--bg', 4.5],
  // Segment buttons (item 61). Unselected (--fg-dim) must be readable on the ground, and selected (--fg) on the raised surface.
  ['--fg-dim', '--segment-bg', 4.5],
  ['--fg', '--segment-on-bg', 7],
  // Wave 13 bundle B (item 151): read thread titles are 4.5:1 or higher on the surface (--bg) and on hover (--bg-raised). The circled numbers for awaiting approval are --bg text on the --warn-fg ground. The circles themselves (not text) are 3:1 or higher.
  ['--thread-read-fg', '--bg', 4.5],
  ['--thread-read-fg', '--bg-raised', 4.5],
  ['--bg', '--warn-fg', 4.5],
  ['--accent', '--bg-raised', 3],
  ['--warn-fg', '--bg-raised', 3],
  ['--accent', '--activity-bg', 3],
  ['--warn-fg', '--activity-bg', 3],
  // The primary button of the prompt field (item 154). For icons, the guide is 3:1, looser than 4.5:1.
  ['--accent-fg', '--accent', 3],
  // Wave 13 bundle C2 (item 161): the white ■ of the stop button is on red fill, and the fill is 3:1 or higher on the surface.
  ['--danger-on', '--danger', 3],
  ['--danger', '--bg', 3],
  // Wave 26 bundle B (TODO 525): BottomBar when the network is down or the model cannot connect. White text on red ground, 4.5:1 or higher.
  ['--error-fg', '--error-bg', 4.5],
  // Wave 17 bundle G (item 321): the vertical line and the marks (✓ / ✕ / ■ / ⏸) of a child block's state. No new token is added; the existing state colors are used.
  // The marks are readable characters on the surface (--bg) (checked by the 4.5:1 pair above), and 3:1 or higher on the highlighted block (--bg-raised) that jumps to it.
  ['--ok-fg', '--bg-raised', 3],
  ['--danger-fg', '--bg-raised', 3],
  ['--fg-dim', '--bg-raised', 3],
  ['--fg-dim', '--bg', 4.5],
  ['--subagent-line', '--bg', 3],
  // Wave 21 bundle E (TODO 404): file type icons (Seti colors). They are shapes, not text, so 3:1. On the Files tree ground (--bg), and on raised surfaces such as the filter input field (--bg-raised).
  ['--file-icon-blue', '--bg', 3],
  ['--file-icon-blue', '--bg-raised', 3],
  ['--file-icon-green', '--bg', 3],
  ['--file-icon-green', '--bg-raised', 3],
  ['--file-icon-yellow', '--bg', 3],
  ['--file-icon-yellow', '--bg-raised', 3],
  ['--file-icon-orange', '--bg', 3],
  ['--file-icon-orange', '--bg-raised', 3],
  ['--file-icon-red', '--bg', 3],
  ['--file-icon-red', '--bg-raised', 3],
  ['--file-icon-pink', '--bg', 3],
  ['--file-icon-pink', '--bg-raised', 3],
  ['--file-icon-purple', '--bg', 3],
  ['--file-icon-purple', '--bg-raised', 3],
  ['--file-icon-grey', '--bg', 3],
  ['--file-icon-grey', '--bg-raised', 3],
  ['--file-icon-amber', '--bg', 3],
  ['--file-icon-amber', '--bg-raised', 3],
  ['--file-icon-teal', '--bg', 3],
  ['--file-icon-teal', '--bg-raised', 3],
  // TODO 1011: the red rectangle of Movies is 3:1 or higher on the surface, and the white triangle is 3:1 or higher on the red.
  ['--file-icon-movies-bg', '--bg', 3],
  ['--file-icon-movies-bg', '--bg-raised', 3],
  ['--file-icon-movies-mark', '--file-icon-movies-bg', 3]
]

/** A color made by layering `rgba(r, g, b, a)` on a `#rrggbb` ground (to measure contrast on a translucent surface). */
export function composite(rgba: string, base: string): string {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(rgba.trim())
  if (m === null) throw new Error(`rgba(r, g, b, a) で書くこと: ${rgba}`)
  const b = /^#([0-9a-f]{6})$/i.exec(base.trim())
  if (b === null) throw new Error(`6 桁の #rrggbb で書くこと: ${base}`)
  const n = parseInt(b[1]!, 16)
  const under = [n >> 16, (n >> 8) & 0xff, n & 0xff]
  const alpha = Number(m[4])
  const mixed = [1, 2, 3].map((i, k) => Math.round(Number(m[i]) * alpha + under[k]! * (1 - alpha)))
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Must be readable on the colors made by layering translucent surfaces (`--selected-bg` / `--hover`) on `--bg` (wave 13 bundle B).
 * Selected rows are not darkened even when read, but the unread and awaiting-approval circles are measured here, and the read colors too, to be safe.
 */
const OVERLAY_PAIRS: readonly [string, string, number][] = [
  ['--thread-read-fg', '--selected-bg', 4.5],
  ['--thread-read-fg', '--hover', 4.5],
  ['--fg', '--selected-bg', 7],
  ['--accent', '--selected-bg', 3],
  ['--warn-fg', '--selected-bg', 3],
  // Wave 21 bundle E (TODO 404): the icons of selected and hovered rows are also 3:1 or higher.
  ['--file-icon-blue', '--selected-bg', 3],
  ['--file-icon-blue', '--hover', 3],
  ['--file-icon-green', '--selected-bg', 3],
  ['--file-icon-green', '--hover', 3],
  ['--file-icon-yellow', '--selected-bg', 3],
  ['--file-icon-yellow', '--hover', 3],
  ['--file-icon-orange', '--selected-bg', 3],
  ['--file-icon-orange', '--hover', 3],
  ['--file-icon-red', '--selected-bg', 3],
  ['--file-icon-red', '--hover', 3],
  ['--file-icon-pink', '--selected-bg', 3],
  ['--file-icon-pink', '--hover', 3],
  ['--file-icon-purple', '--selected-bg', 3],
  ['--file-icon-purple', '--hover', 3],
  ['--file-icon-grey', '--selected-bg', 3],
  ['--file-icon-grey', '--hover', 3],
  ['--file-icon-amber', '--selected-bg', 3],
  ['--file-icon-amber', '--hover', 3],
  ['--file-icon-teal', '--selected-bg', 3],
  ['--file-icon-teal', '--hover', 3]
]

describe('配色テーマ (7.4.1)', () => {
  for (const file of STYLESHEETS) {
    const css = readFileSync(join(repoRoot, file), 'utf8')
    const blocks = tokenBlocks(css)

    describe(file, () => {
      it('ライトが既定 (:root) で、ダークは :root[data-theme="dark"] に同じ変数名を持つ', () => {
        expect(blocks.lightRaw).toMatch(/color-scheme:\s*light/)
        expect(blocks.darkRaw).toMatch(/color-scheme:\s*dark/)
        const light = Object.keys(blocks.light).sort()
        const dark = Object.keys(blocks.dark).sort()
        expect(light.length).toBeGreaterThan(0)
        expect(dark).toEqual(light)
      })

      it('トークンのブロック以外に色の直書きが無い (例外は ALLOWED に列挙)', () => {
        const allowed = ALLOWED.filter((a) => a.file === file)
        const leftovers = findHardcodedColors(css).filter(
          (c) => !allowed.some((a) => a.selector === c.selector && a.literal === c.literal)
        )
        expect(leftovers).toEqual([])
        // Conversely, the listed exceptions must exist (if one disappears, remove it from the list too).
        for (const a of allowed) {
          expect(findHardcodedColors(css)).toContainEqual(expect.objectContaining({ selector: a.selector, literal: a.literal }))
        }
      })

      for (const theme of ['light', 'dark'] as const) {
        it(`${theme}: 本文 7:1 以上、控えめな文字 4.5:1 以上`, () => {
          const vars = blocks[theme]
          const pairs = [...CONTRAST_PAIRS, ...STATE_PAIRS.filter(([fg, bg]) => fg in vars && bg in vars)]
          for (const [fg, bg, min] of pairs) {
            expect(vars[fg], fg).toBeDefined()
            expect(vars[bg], bg).toBeDefined()
            const ratio = contrast(vars[fg]!, vars[bg]!)
            expect(ratio, `${theme} ${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min)
          }
        })
      }
    })
  }

  for (const theme of ['light', 'dark'] as const) {
    it(`styles.css ${theme}: 半透明の面 (選択中・hover) の上でも既読の題名と丸が読める`, () => {
      const vars = tokenBlocks(readFileSync(join(repoRoot, 'src/renderer/src/styles.css'), 'utf8'))[theme]
      for (const [fg, overlay, min] of OVERLAY_PAIRS) {
        const surface = composite(vars[overlay]!, vars['--bg']!)
        const ratio = contrast(vars[fg]!, surface)
        expect(ratio, `${theme} ${fg} on ${overlay} (${surface}) = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min)
      }
    })
  }

  // TODO 990: the conversation name and icon in the header are `color-mix(in srgb, <rainbow color> 60%, var(--fg))` (`--thread-cwd-fg` in styles.css). All 16 colors must be readable on --bg in both themes. The ratio is kept in line with the CSS.
  for (const theme of ['light', 'dark'] as const) {
    it(`styles.css ${theme}: 見出しの cwd の色 (虹色 60% + --fg 40%) が全 16 色で --bg の上で 4.5:1 以上`, () => {
      const css = readFileSync(join(repoRoot, 'src/renderer/src/styles.css'), 'utf8')
      expect(css).toContain('color-mix(in srgb, var(--thread-accent, var(--fg-dim)) 60%, var(--fg))')
      const vars = tokenBlocks(css)[theme]
      const hex = (c: string): number[] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
      const fg = hex(vars['--fg']!)
      for (let n = 0; n < 16; n++) {
        const accent = hex(vars[`--rainbow-${n}`]!)
        const mixed = `#${accent.map((v, k) => Math.round(v * 0.6 + fg[k]! * 0.4).toString(16).padStart(2, '0')).join('')}`
        const ratio = contrast(mixed, vars['--bg']!)
        expect(ratio, `${theme} --rainbow-${n} → ${mixed} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
      }
    })
  }

  it('半透明の重ね合わせは素直な線形の混色', () => {
    expect(composite('rgba(0, 0, 0, 0.5)', '#ffffff')).toBe('#808080')
    expect(composite('rgba(255, 255, 255, 0)', '#123456')).toBe('#123456')
  })

  /**
   * **An unclosed `{` swallows every rule after it without dropping a single line.** This was actually hit in T15: the `}` of `.row.cursored` was missing, so the CSSOM rules were cut off there (225 items), and the `.progress-*` and `.pane-divider` written after it were **disabled as nested rules**.
   * The build and lint both passed, and DevTools shows only 'no such rule', so it is pinned down by a machine check.
   */
  for (const file of STYLESHEETS) {
    it(`${file}: 波括弧が釣り合う (閉じ忘れは後続の全規則を飲み込む)`, () => {
      const css = stripComments(readFileSync(join(repoRoot, file), 'utf8'))
      let depth = 0
      let line = 1
      for (const ch of css) {
        if (ch === '\n') line += 1
        else if (ch === '{') depth += 1
        else if (ch === '}') {
          depth -= 1
          expect(depth, `${file}:${line} で余分な }`).toBeGreaterThanOrEqual(0)
        }
      }
      expect(depth, `${file}: 閉じていない { が ${depth} 個`).toBe(0)
    })
  }

  /**
   * **A `,` right after a `}` throws away the whole next rule** (item 238, the 16th proxy verification). In `.a { … },\n.b { … }`, the selector list of `.b` becomes `,\n.b`, and with an empty first selector the whole rule is disabled. The braces stay balanced, so the check above does not catch it. This made the band of item 192 (`.instance-banner`) transparent, and the distinction of a duplicated window did not work.
   */
  for (const file of STYLESHEETS) {
    it(`${file}: } の直後に , が無い (次の規則を捨てる)`, () => {
      const css = stripComments(readFileSync(join(repoRoot, file), 'utf8'))
      const lines = css.split('\n')
      const bad = lines
        .map((text, i) => ({ text, line: i + 1 }))
        .filter(({ text }) => /\}\s*,\s*$/.test(text))
      expect(bad.map(({ line, text }) => `${file}:${line}: ${text.trim()}`)).toEqual([])
    })
  }

  it('CodeMirror のテーマ (editor.ts) も色を直書きしない', () => {
    const source = readFileSync(join(repoRoot, 'plugins/_shared/editor.ts'), 'utf8')
    expect(source.match(COLOR_LITERAL) ?? []).toEqual([])
    // Light / dark is selected by the theme name sent from the host (it does not read the parent's DOM).
    expect(source).toContain('dark: true')
    expect(source).toContain('dark: false')
    expect(source).not.toMatch(/matchMedia|parent\.|top\./)
  })

  it('diff の viewer (aios.diff) も色を直書きせず、@codemirror/merge の既定色は viewer.css の変数で上書きする', () => {
    const source = readFileSync(join(repoRoot, 'plugins/aios.diff/viewer/diff-view.ts'), 'utf8')
    expect(source.match(COLOR_LITERAL) ?? []).toEqual([])
    const css = readFileSync(join(repoRoot, 'plugins/_shared/viewer.css'), 'utf8')
    for (const token of ['--diff-add-bg', '--diff-del-bg', '--diff-add-text', '--diff-del-text']) {
      expect(css).toContain(`var(${token})`)
    }
    // Every changed line in the default theme, changed characters, and the marks beside line numbers have overrides.
    for (const selector of ['.cm-merge-a .cm-changedLine', '.cm-merge-b .cm-changedLine', '.cm-deletedChunk', '.cm-changedText', '.cm-changedLineGutter', '.cm-collapsedLines']) {
      expect(css).toContain(selector)
    }
  })

  it('検査は仕込んだ直書きを捕まえる', () => {
    const css = ':root { --fg: #111; }\n.a { color: var(--fg); }\n.b:hover { background: rgba(0, 0, 0, 0.5); }\n.c { border: 1px solid #abc; }'
    expect(findHardcodedColors(css)).toEqual([
      { selector: '.b:hover', literal: 'rgba(0, 0, 0, 0.5)', line: 3 },
      { selector: '.c', literal: '#abc', line: 4 }
    ])
  })

  it('コントラストの計算は WCAG の例に一致する', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
  })
})
