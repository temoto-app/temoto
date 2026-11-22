/**
 * TODO 1319: the static failure page (`resources/recovery/index.html`): colors only in the two variable blocks, the same names in both themes,
 * readable text in both, no script and nothing loaded from outside, and every slot main fills is present. It is shipped in the release.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { recoveryPageHtml, recoveryTemplatePath } from '../src/main/recovery-page.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const template = readFileSync(recoveryTemplatePath(root), 'utf8')

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
}

const styleBody = /<style>([\s\S]*?)<\/style>/.exec(template)?.[1] ?? ''
const blocks = [...stripComments(styleBody).matchAll(/(:root(?:\[[^\]]*\])?)\s*\{([^}]*)\}/g)]
const vars = (body: string): Record<string, string> =>
  Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]))
const light = vars(blocks.find((b) => b[1] === ':root')?.[2] ?? '')
const dark = vars(blocks.find((b) => b[1] === ':root[data-theme="dark"]')?.[2] ?? '')

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

describe('resources/recovery/index.html (TODO 1319)', () => {
  it('writes colors only in the two variable blocks, with the same names in both', () => {
    const outside = stripComments(styleBody).replace(/(:root(?:\[[^\]]*\])?)\s*\{[^}]*\}/g, '')
    expect(outside).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/)
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).filter((k) => k !== 'color-scheme').sort())
    expect(Object.keys(light).length).toBeGreaterThan(4)
  })

  it.each([
    ['light', light],
    ['dark', dark]
  ])('is readable in %s: text 4.5:1 or more on the background, button text 4.5:1 or more on the button', (_name, v) => {
    expect(contrast(v['--fg']!, v['--bg']!)).toBeGreaterThanOrEqual(7)
    expect(contrast(v['--fg-dim']!, v['--bg']!)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(v['--btn-fg']!, v['--btn-bg']!)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(v['--btn-bg']!, v['--bg']!)).toBeGreaterThanOrEqual(3)
  })

  it('has no script and loads nothing from outside, and its CSP allows neither', () => {
    expect(template).not.toMatch(/<script/i)
    expect(template).not.toMatch(/\b(src|srcset)=/i)
    expect(template).not.toMatch(/<link/i)
    expect(template).toMatch(/Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'/)
  })

  it('has every slot main fills, and leaves none open once filled (both languages)', () => {
    for (const slot of ['lang', 'theme', 'title', 'body', 'reload', 'reloadUrl', 'reasonLabel', 'reason']) expect(template).toContain(`{{${slot}}}`)
    for (const locale of ['en', 'ja'] as const) {
      const html = recoveryPageHtml(template, { locale, theme: 'dark', reason: 'crashed' })
      expect(stripComments(html)).not.toMatch(/\{\{\w+\}\}/)
      expect(html).toContain(`lang="${locale}"`)
    }
  })

  it('is part of the release package and its check', () => {
    expect(readFileSync(join(root, 'scripts', 'release-config.mjs'), 'utf8')).toContain("'resources/recovery/**'")
    expect(readFileSync(join(root, 'scripts', 'release.mjs'), 'utf8')).toContain("'resources/recovery/index.html'")
  })
})

describe('main answers the "Load Again" link on both routes (wave 100 X)', () => {
  const source = readFileSync(join(root, 'src', 'main', 'index.ts'), 'utf8')

  it('setWindowOpenHandler checks isRecoveryReload before anything is handed to the external browser', () => {
    const start = source.indexOf('setWindowOpenHandler(')
    const body = source.slice(start, source.indexOf('})', source.indexOf('openExternalChecked', start)))
    expect(start).toBeGreaterThan(0)
    expect(body.indexOf('isRecoveryReload(url)')).toBeGreaterThan(-1)
    expect(body.indexOf('isRecoveryReload(url)')).toBeLessThan(body.indexOf('openExternalChecked'))
    expect(body).toContain('loadAgain()')
  })

  it('will-navigate still answers it', () => {
    const start = source.indexOf("on('will-navigate'")
    expect(source.slice(start, start + 300)).toContain('isRecoveryReload(event.url)')
  })
})

