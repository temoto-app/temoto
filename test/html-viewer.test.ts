// @vitest-environment jsdom
/**
 * The Preview document of `aios.html` (TODO 401, wave 22 bundle A), and the judgment of Source / Preview.
 *
 * Does not go through drawing of the iframe or through the bridge (they cannot run outside the iframe). Re-reads with DOMParser the string placed in a nested `<iframe sandbox="">` via srcdoc (`buildPreviewDocument`), and checks that no script, event attribute, or external load remains, that a CSP is placed at the head, and that the CSP string has the form that stops external and other files.
 * That a nested srcdoc can be drawn under the plugin's CSP in the real Chromium is recorded in bundle A of docs/notes/wave22.md.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FORBID_TAGS,
  PREVIEW_BASE_STYLE,
  PREVIEW_CSP,
  PREVIEW_SANDBOX,
  PURIFY_CONFIG,
  buildPreviewDocument
} from '../plugins/aios.html/viewer/preview.js'
import { INITIAL_MODE, acceptsInsert, revealNeedsRender } from '../plugins/aios.html/viewer/mode.js'

const repoRoot = join(__dirname, '..')

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

/** Turns the CSP string into `{ directive: sources[] }`. */
function directives(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    if (name) out[name] = values
  }
  return out
}

const HOSTILE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=https://example.com/">
  <title>Sample</title>
  <base href="https://example.com/">
  <link rel="stylesheet" href="https://example.com/a.css">
  <link rel="stylesheet" href="other.css">
  <style>h1 { color: blue }</style>
  <script>alert(1)</script>
  <script src="app.js"></script>
</head>
<body onload="boot()">
  <h1 style="font-weight: bold">Hello</h1>
  <img id="ext" src="http://example.com/a.png" onerror="alert(2)">
  <img id="local" src="./photo.png">
  <img id="inline" src="data:image/png;base64,iVBORw0KGgo=">
  <iframe src="file:///etc/passwd"></iframe>
  <iframe srcdoc="<script>alert(3)</script>"></iframe>
  <object data="movie.swf"></object>
  <embed src="x.swf">
  <a id="ext-link" href="https://example.com/">out</a>
  <a id="js-link" href="javascript:alert(4)">js</a>
  <a id="frag" href="#top">top</a>
  <button onclick="alert(5)">b</button>
  <svg><use href="file:///tmp/x.svg#a"/><script>alert(6)</script></svg>
</body>
</html>`

describe('Preview document (TODO 401)', () => {
  const out = buildPreviewDocument(HOSTILE)
  const doc = parse(out)

  it('<script> remains nowhere in head, body or svg', () => {
    expect(doc.querySelectorAll('script')).toHaveLength(0)
    expect(out).not.toMatch(/alert\(/)
  })

  it('drops event attributes (onerror / onload / onclick)', () => {
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) expect(attr.name.startsWith('on')).toBe(false)
    }
    // The elements themselves remain (their appearance is kept).
    expect(doc.getElementById('ext')).not.toBeNull()
    expect(doc.querySelector('button')?.textContent).toBe('b')
  })

  it('drops <iframe> / <object> / <embed> / <link> / <base> / the original <meta> together with the element', () => {
    for (const tag of ['iframe', 'frame', 'object', 'embed', 'link', 'base', 'use']) {
      expect(doc.querySelectorAll(tag)).toHaveLength(0)
    }
    // The only <meta> that remains is the one CSP that was placed (refresh and charset are dropped).
    const metas = doc.querySelectorAll('meta')
    expect(metas).toHaveLength(1)
    expect(metas[0]?.getAttribute('http-equiv')).toBe('Content-Security-Policy')
  })

  it('drops javascript: hrefs; external links do nothing when clicked (target=_blank, no allow-popups in sandbox)', () => {
    expect(doc.getElementById('js-link')?.hasAttribute('href')).toBe(false)
    const ext = doc.getElementById('ext-link')
    expect(ext?.getAttribute('target')).toBe('_blank')
    expect(ext?.getAttribute('rel')).toContain('noopener')
    // A `#…` within the same document is rewritten to about:srcdoc#… (455-2: the base URL of srcdoc is the parent's URL, so if it stayed `#top`, it would be a navigation to the plugin's index.html#top, which the CSP stops and turns into an error screen).
    const frag = doc.getElementById('frag')
    expect(frag?.getAttribute('href')).toBe('about:srcdoc#top')
    expect(frag?.hasAttribute('target')).toBe(false)
  })

  it("keeps <style>, the style attribute and <title> (shows the HTML's own look); data: images also remain", () => {
    const styles = Array.from(doc.querySelectorAll('style')).map((s) => s.textContent)
    expect(styles).toContain('h1 { color: blue }')
    expect(doc.querySelector('h1')?.getAttribute('style')).toBe('font-weight: bold')
    expect(doc.title).toBe('Sample')
    expect(doc.getElementById('inline')?.getAttribute('src')).toMatch(/^data:image\/png/)
  })

  it('inserts the CSP <meta> and the background-color <style> at the start of <head> (before the original <style> = the original specification wins)', () => {
    const head = doc.head
    expect(head.firstElementChild?.tagName).toBe('META')
    expect(head.firstElementChild?.getAttribute('content')).toBe(PREVIEW_CSP)
    const base = head.children[1]
    expect(base?.tagName).toBe('STYLE')
    expect(base?.textContent).toBe(PREVIEW_BASE_STYLE)
    // Specificity 0 (`:where`). No background color is set, so that the propagation of the body's background is not disturbed. The white base goes under the iframe's element side.
    expect(PREVIEW_BASE_STYLE).toBe(':where(html){color-scheme:light}')
    const css = readFileSync(join(repoRoot, 'plugins/aios.html/viewer/html.css'), 'utf8')
    expect(css).toMatch(/\.html-preview\s*\{[^}]*background:\s*Canvas;/)
    expect(css).toMatch(/\.html-preview\s*\{[^}]*color-scheme:\s*light;/)
    // No hard-coded colors (7.4.1).
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
  })

  it('even if URLs to external resources or other files (http / relative) remain, the CSP is set up to block them', () => {
    // DOMPurify keeps http(s) and relative src, since we want the elements drawn. Stopping loads is the CSP's job.
    expect(doc.getElementById('ext')?.getAttribute('src')).toBe('http://example.com/a.png')
    expect(doc.getElementById('local')?.getAttribute('src')).toBe('./photo.png')
    const csp = directives(PREVIEW_CSP)
    expect(csp['default-src']).toEqual(["'none'"])
    // Images are data: only. Only inline style is allowed; external CSS is not read.
    expect(csp['img-src']).toEqual(['data:'])
    expect(csp['style-src']).toEqual(["'unsafe-inline'"])
    // Anything else (script / frame / font / media / connect) falls back to default-src 'none'.
    for (const name of ['script-src', 'frame-src', 'child-src', 'font-src', 'media-src', 'connect-src', 'object-src']) {
      expect(csp[name]).toBeUndefined()
    }
  })

  it('even a fragment (HTML without <html>) is made into a document and gets the CSP', () => {
    const frag = parse(buildPreviewDocument('<p>only <b>bold</b></p><script>x()</script>'))
    expect(frag.head.firstElementChild?.getAttribute('content')).toBe(PREVIEW_CSP)
    expect(frag.body.innerHTML).toBe('<p>only <b>bold</b></p>')
  })

  it('does not break on an empty body', () => {
    const empty = parse(buildPreviewDocument(''))
    expect(empty.head.firstElementChild?.getAttribute('content')).toBe(PREVIEW_CSP)
  })

  it('DOMPurify config: keeps the whole document and explicitly drops dangerous elements', () => {
    expect(PURIFY_CONFIG.WHOLE_DOCUMENT).toBe(true)
    for (const tag of ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base']) {
      expect(FORBID_TAGS).toContain(tag)
    }
    expect(PURIFY_CONFIG.FORBID_ATTR).toContain('srcdoc')
  })

  it('a nested iframe gets a sandbox with all permissions removed', () => {
    expect(PREVIEW_SANDBOX).toBe('')
  })
})

describe('Source / Preview (TODO 401)', () => {
  it('Preview when opened', () => {
    expect(INITIAL_MODE).toBe('preview')
  })

  it('jumping to a line switches to Source first if in Preview', () => {
    expect(revealNeedsRender('preview', false)).toBe(true)
    expect(revealNeedsRender('preview', true)).toBe(true)
    expect(revealNeedsRender('source', false)).toBe(true)
    expect(revealNeedsRender('source', true)).toBe(false)
  })

  it('inserting a dropped path happens only when Source is editable', () => {
    expect(acceptsInsert('source', true)).toBe(true)
    expect(acceptsInsert('source', false)).toBe(false)
    expect(acceptsInsert('preview', true)).toBe(false)
  })

  it('viewer HTML: the plugin CSP does not hinder a nested srcdoc (frame-src is not opened; scripts only from aios-plugin:)', () => {
    const html = readFileSync(join(repoRoot, 'plugins/aios.html/viewer/index.html'), 'utf8')
    const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1]
    expect(content).toBeDefined()
    const csp = directives(content!)
    expect(csp['default-src']).toEqual(["'none'"])
    expect(csp['script-src']).toEqual(['aios-plugin:'])
    // A nested srcdoc is not fetched, so it is not subject to the frame-src check. It need not be opened, and it is not: opening it would let a click on a link inside the nested document navigate onward.
    expect(csp['frame-src']).toBeUndefined()
    expect(csp['child-src']).toBeUndefined()
    expect(csp['connect-src']).toEqual(["'none'"])
  })
})
