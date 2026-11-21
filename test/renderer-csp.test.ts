/** TODO 856: the renderer's CSP in the distributed build is connect-src 'self' only. */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tightenConnectSrc } from '../src/common/renderer-csp.js'

const csp = (html: string): string => /Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1] ?? ''

describe('renderer CSP (TODO 856)', () => {
  it('the source index.html has ws: for dev, and tighten removes it', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../src/renderer/index.html'), 'utf8')
    expect(csp(src)).toContain('ws:')
    const tight = csp(tightenConnectSrc(src))
    expect(tight).toContain("connect-src 'self';")
    expect(tight).not.toMatch(/ws:|localhost/)
  })
  const built = resolve(import.meta.dirname, '../out/renderer/index.html')
  // If the built artifact is older than the source that tightens it (a build from before 856), skip it (same as `build-stamp-bundle.test.ts`: `npm run check` runs the tests before the build, so it does not fail by looking at the previous `out/`).
  const tightenSource = resolve(import.meta.dirname, '../src/common/renderer-csp.ts')
  const fresh = existsSync(built) && statSync(built).mtimeMs >= statSync(tightenSource).mtimeMs
  it.skipIf(!fresh)('the build output out/renderer/index.html has no ws: or localhost', () => {
    const c = csp(readFileSync(built, 'utf8'))
    expect(c).toContain("connect-src 'self';")
    expect(c).not.toMatch(/ws:|localhost/)
  })
})
