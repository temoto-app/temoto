// @vitest-environment jsdom
/**
 * Static checks of the bundled Help document (`resources/help/index.html`, TODO 1174, ARCHITECTURE.md 7.4.13), and its shape after it passes through the host's preparation (`prepareHelpDocument`) and the Preview of `aios.html` (`buildPreviewDocument`).
 *
 * - It has 10 sections, and each has both Japanese and English. The table of contents links to the 10 sections within the page.
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

/** The 10 sections in the order of the table of contents (the table of TODO 1174; `layout` from TODO 1327). */
const SECTIONS = [
  'getting-started',
  'layout',
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

describe('bundled Help document', () => {
  const doc = parse(source)

  it('has 10 sections, and each section has a heading and body in both Japanese and English', () => {
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

  it('the table of contents is in-page links to the 10 sections, and every link in the document has an in-page target', () => {
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

  it("the language switch is 2 radios and labels and keeps its default form (a form the host's write applies to)", () => {
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

  it('reads no external resources, and has only one script in the document', () => {
    expect(hasExternalReferences(source)).toBe(false)
    expect(doc.querySelectorAll('script[src], link, iframe, img, object, embed').length).toBe(0)
    expect(doc.querySelectorAll('script').length).toBe(1)
  })

  it('colors are only inside the two CSS variable sets (light / dark), and the two sets define the same variables', () => {
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
  it('writes the language, color scheme and version, and only one radio is checked', () => {
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

  it('the version is inserted escaped', () => {
    const out = prepareHelpDocument(source, { lang: 'en', theme: 'light', version: '<b>x</b>' })
    expect(out).not.toContain('<b>x</b>')
    expect(text(parse(out).querySelector('[data-help-version]'))).toBe('<b>x</b>')
  })

  it('even through Preview, sections, radios and labels remain, scripts are dropped, and the table of contents becomes about:srcdoc#...', () => {
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

describe('backend name (constraint 6)', () => {
  it('the bundled HTML has no such term, and it is present after filling in', () => {
    expect(source).not.toMatch(/claude|anthropic|opencode/i)
    expect(source).toContain('{{backend.primary}}')
    const filled = fillBackendNames(source, backendNames)
    expect(filled).not.toMatch(/\{\{backend\./)
    expect(filled).toContain(backendNames.primary)
    expect(filled).toContain(backendNames.primaryInstructionsFile)
    expect(filled).toContain(backendNames.secondary)
    expect(filled).toContain(backendNames.secondaryInstall)
  })

  it('keys not in the table are left, and values are escaped', () => {
    expect(fillBackendNames('{{backend.nope}}', backendNames)).toBe('{{backend.nope}}')
    expect(fillBackendNames('{{backend.x}}', { x: '<b>' })).toBe('&#60;b&#62;')
  })
})
