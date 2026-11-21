// @vitest-environment jsdom
/**
 * Static checks of the bundled Help document (`resources/help/index.html`, TODO 1174, ARCHITECTURE.md 7.4.13), and its shape after it passes through the host's preparation (`prepareHelpDocument`) and the Preview of `aios.html` (`buildPreviewDocument`).
 *
 * - It has 9 sections, and each has both Japanese and English. The table of contents links to the 9 sections within the page.
 * - Language switching works with CSS alone (2 radios + `:checked`). Preview does not run scripts, so the initial values are written by the host (the `checked` of the radios, `lang` / `data-lang` / `data-theme` on `<html>`, and the version).
 * - It reads no external resources. Colors exist only inside the two sets of CSS variables (light / dark).
 * - Even after passing through Preview, the sections, radios, and labels remain, and the links in the table of contents become `about:srcdoc#…` (scrolling within the document).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fillBackendNames, prepareHelpDocument } from '../src/shared/help.js'
import backendNames from '../compat/backend-names.json' with { type: 'json' }
import { buildPreviewDocument } from '../plugins/aios.html/viewer/preview.js'
import { hasExternalReferences } from '../plugins/aios.html/viewer/external.js'

const repoRoot = join(__dirname, '..')
const source = readFileSync(join(repoRoot, 'resources', 'help', 'index.html'), 'utf8')

/** The 9 sections in the order of the table of contents (the table of TODO 1174). */
const SECTIONS = [
  'getting-started',
  'prompt',
  'attachments',
  'viewer',
  'permissions',
  'settings',
  'ai-configuration',
  'troubleshooting',
  'shortcuts'
] as const

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

function text(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** The body of one rule inside a `<style>` (`selector { … }`). */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, selector).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', start)
  return css.slice(start, end + 1)
}

function variables(block: string): string[] {
  return [...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] ?? '').sort()
}

describe('同梱の Help の文書', () => {
  const doc = parse(source)

  it('9 節があり、どの節も見出しと本文を日本語と英語の両方で持つ', () => {
    const sections = [...doc.querySelectorAll('section[id]')].map((el) => el.id)
    expect(sections).toEqual([...SECTIONS])
    for (const id of SECTIONS) {
      const section = doc.getElementById(id)
      for (const lang of ['ja', 'en']) {
        expect(text(section?.querySelector(`h2 [data-lang="${lang}"]`) ?? null), `${id} h2 ${lang}`).not.toBe('')
        const body = section?.querySelector(`:scope > div[data-lang="${lang}"]`) ?? null
        expect(text(body).length, `${id} body ${lang}`).toBeGreaterThan(80)
      }
    }
    // The Japanese body contains kana (it is not a copy of the English).
    for (const id of SECTIONS) {
      expect(/[぀-ヿ]/.test(text(doc.querySelector(`#${id} > div[data-lang="ja"]`))), id).toBe(true)
    }
  })

  it('目次は 9 節へのページ内リンクで、文書の中のリンクは全部ページ内で行き先がある', () => {
    const toc = [...doc.querySelectorAll('nav.toc a')].map((a) => a.getAttribute('href'))
    expect(toc).toEqual(SECTIONS.map((id) => `#${id}`))
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') ?? ''
      expect(href.startsWith('#'), href).toBe(true)
      expect(doc.getElementById(href.slice(1)), href).not.toBeNull()
    }
    const ids = [...doc.querySelectorAll('[id]')].map((el) => el.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('言語の切り替えは radio 2 つと label で、既定の形を保つ (host の書き込みが当たる形)', () => {
    expect(source).toContain('<input class="lang-radio" type="radio" name="help-lang" id="lang-ja">')
    expect(source).toContain('<input class="lang-radio" type="radio" name="help-lang" id="lang-en" checked>')
    expect(doc.querySelector('label[for="lang-ja"]')).not.toBeNull()
    expect(doc.querySelector('label[for="lang-en"]')).not.toBeNull()
    // The radios are siblings before `.page` (they take effect through `:checked ~ .page`).
    const page = doc.querySelector('body > .page')
    for (const id of ['lang-ja', 'lang-en']) {
      const radio = doc.getElementById(id)
      expect(radio?.parentElement?.tagName).toBe('BODY')
      expect(Boolean(radio !== null && page !== null && radio.compareDocumentPosition(page) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    }
    const css = doc.querySelector('style')?.textContent ?? ''
    expect(css).toContain('#lang-ja:checked ~ .page [data-lang="en"] { display: none; }')
    expect(css).toContain('#lang-en:checked ~ .page [data-lang="ja"] { display: none; }')
    expect(doc.querySelector('[data-help-version]')).not.toBeNull()
  })

  it('外部の資源を読まず、script は文書の中の 1 つだけ', () => {
    expect(hasExternalReferences(source)).toBe(false)
    expect(doc.querySelectorAll('script[src], link, iframe, img, object, embed').length).toBe(0)
    expect(doc.querySelectorAll('script').length).toBe(1)
  })

  it('色は CSS 変数の 2 組 (light / dark) の中だけで、2 組は同じ変数を定義する', () => {
    const css = doc.querySelector('style')?.textContent ?? ''
    const light = ruleBody(css, ':root')
    const dark = ruleBody(css, 'html[data-theme="dark"]')
    expect(variables(light)).toEqual(variables(dark))
    expect(variables(light).length).toBeGreaterThan(5)
    const rest = css.replace(light, '').replace(dark, '')
    expect(rest.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)).toBeNull()
  })
})

describe('prepareHelpDocument → Preview', () => {
  it('言語・配色・版を書き込み、radio は 1 つだけ checked', () => {
    const out = prepareHelpDocument(source, { lang: 'ja', theme: 'dark', version: '0.75.0' })
    const doc = parse(out)
    const html = doc.documentElement
    expect(html.getAttribute('lang')).toBe('ja')
    expect(html.getAttribute('data-lang')).toBe('ja')
    expect(html.getAttribute('data-theme')).toBe('dark')
    expect((doc.getElementById('lang-ja') as HTMLInputElement).checked).toBe(true)
    expect((doc.getElementById('lang-en') as HTMLInputElement).checked).toBe(false)
    expect(text(doc.querySelector('[data-help-version]'))).toBe('0.75.0')

    const en = parse(prepareHelpDocument(source, { lang: 'en', theme: 'light', version: '' }))
    expect(en.documentElement.getAttribute('data-theme')).toBe('light')
    expect((en.getElementById('lang-en') as HTMLInputElement).checked).toBe(true)
    expect((en.getElementById('lang-ja') as HTMLInputElement).checked).toBe(false)
    // If the version is empty, the bundled default remains.
    expect(text(en.querySelector('[data-help-version]'))).toBe('-')
  })

  it('版は escape して入れる', () => {
    const out = prepareHelpDocument(source, { lang: 'en', theme: 'light', version: '<b>x</b>' })
    expect(out).not.toContain('<b>x</b>')
    expect(text(parse(out).querySelector('[data-help-version]'))).toBe('<b>x</b>')
  })

  it('Preview を通しても節・radio・label が残り、script は落ち、目次は about:srcdoc#… になる', () => {
    const prepared = prepareHelpDocument(source, { lang: 'ja', theme: 'dark', version: '0.75.0' })
    const doc = parse(buildPreviewDocument(prepared))
    expect(doc.querySelectorAll('script').length).toBe(0)
    expect([...doc.querySelectorAll('section[id]')].map((el) => el.id)).toEqual([...SECTIONS])
    expect((doc.getElementById('lang-ja') as HTMLInputElement | null)?.checked).toBe(true)
    expect(doc.querySelector('label[for="lang-en"]')).not.toBeNull()
    expect(doc.documentElement.getAttribute('data-theme')).toBe('dark')
    const toc = [...doc.querySelectorAll('nav.toc a')].map((a) => a.getAttribute('href'))
    expect(toc).toEqual(SECTIONS.map((id) => `about:srcdoc#${id}`))
    // `<style>` remains (switching and colors work through CSS alone).
    const styles = [...doc.querySelectorAll('style')].map((el) => el.textContent ?? '').join('\n')
    expect(styles).toContain('#lang-ja:checked ~ .page')
    // The default inserted at the head (`:where(html){color-scheme:light}`) has specificity 0, so the document's dark `color-scheme` wins.
    expect(styles).toContain('color-scheme: dark')
  })
})

describe('バックエンドの名前 (制約 6)', () => {
  it('同梱の HTML には語が無く、埋めた後にはある', () => {
    expect(source).not.toMatch(/claude|anthropic|opencode/i)
    expect(source).toContain('{{backend.primary}}')
    const filled = fillBackendNames(source, backendNames)
    expect(filled).not.toMatch(/\{\{backend\./)
    expect(filled).toContain(backendNames.primary)
    expect(filled).toContain(backendNames.primaryInstructionsFile)
    expect(filled).toContain(backendNames.secondary)
    expect(filled).toContain(backendNames.secondaryInstall)
  })

  it('表に無い鍵は残し、値は escape する', () => {
    expect(fillBackendNames('{{backend.nope}}', backendNames)).toBe('{{backend.nope}}')
    expect(fillBackendNames('{{backend.x}}', { x: '<b>' })).toBe('&#60;b&#62;')
  })
})
