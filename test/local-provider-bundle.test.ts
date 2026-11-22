/**
 * TODO 1315: the bundled local-model provider (`scripts/build-local-provider.mjs` -> `out/local-provider/`).
 *
 * - Always: the pinned version agrees between package.json, the adapter's table and the build script; the bundle path in the table is
 *   where the build writes it; `packageDirsOf` reads esbuild's metafile paths (nested and scoped packages).
 * - After a build (`npm run test:bundle`, the end of `npm run build`): the bundle exists, imports nothing but Node built-ins (nothing is
 *   fetched from npm or a URL when the backend loads it), and every npm package that ended up in it has a section in THIRD_PARTY_NOTICES.md.
 *   Skipped when not built, or when `out/` is older than the build script (a build from before TODO 1315).
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOpenCodeTable } from '../src/main/session/adapter-opencode/compat.js'
// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import { OUT_FILE as OUT_FILE_RAW, PACKAGES_FILE as PACKAGES_FILE_RAW, PROVIDER_PACKAGE as PROVIDER_PACKAGE_RAW, packageDirsOf as packageDirsOfRaw } from '../scripts/build-local-provider.mjs'
import { parseThirdPartyNotices } from '../src/shared/third-party-notices.js'

const OUT_FILE = OUT_FILE_RAW as string
const PACKAGES_FILE = PACKAGES_FILE_RAW as string
const PROVIDER_PACKAGE = PROVIDER_PACKAGE_RAW as string
const packageDirsOf = packageDirsOfRaw as (inputs: readonly string[]) => string[]

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const table = loadOpenCodeTable()
const native = table.ollama.native!
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { devDependencies: Record<string, string>; scripts: Record<string, string> }

describe('local provider: pinning and paths (TODO 1315)', () => {
  it('the version is pinned exactly and is the same in package.json and the table', () => {
    const pinned = pkg.devDependencies[PROVIDER_PACKAGE]
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/)
    expect(native.package).toBe(`${PROVIDER_PACKAGE}@${pinned}`)
  })

  it('the table points at the file the build writes, under the app root, and the build runs it', () => {
    expect(native.bundle).toBe(relative(repoRoot, OUT_FILE).split('\\').join('/'))
    expect(native.bundle.startsWith('out/')).toBe(true)
    expect(native.bundle.split('/')).not.toContain('..')
    expect(pkg.scripts['build:app']).toContain('npm run build:local-provider')
    expect(pkg.scripts['test:bundle']).toContain('test/local-provider-bundle.test.ts')
  })

  it('packageDirsOf: the innermost package of each metafile input, scoped names kept whole', () => {
    expect(
      packageDirsOf([
        'node_modules/zod/v4/classic/schemas.js',
        'node_modules/@ai-sdk/provider-utils/dist/index.mjs',
        'node_modules/@ai-sdk/provider-utils/node_modules/undici/index.js',
        'node_modules/zod/v4/core/core.js',
        'local-provider-entry.js'
      ])
    ).toEqual(['node_modules/@ai-sdk/provider-utils', 'node_modules/@ai-sdk/provider-utils/node_modules/undici', 'node_modules/zod'])
  })
})

const builtScript = join(repoRoot, 'scripts/build-local-provider.mjs')
const mainBundle = join(repoRoot, 'out/main/index.js')
const built = existsSync(mainBundle) && statSync(mainBundle).mtimeMs >= statSync(builtScript).mtimeMs

describe.skipIf(!built)('local provider: the built bundle (TODO 1315)', () => {
  it('exists next to the build output', () => {
    expect(existsSync(OUT_FILE)).toBe(true)
    expect(statSync(OUT_FILE).size).toBeGreaterThan(10_000)
  })

  it('imports nothing but Node built-ins (no package or URL is fetched at load time) and exports the provider factory', () => {
    const text = readFileSync(OUT_FILE, 'utf8')
    const specifiers = [
      ...text.matchAll(/\bfrom\s*["'`]([^"'`]+)["'`]/g),
      ...text.matchAll(/\bimport\s*\(?\s*["'`]([^"'`]+)["'`]/g),
      ...text.matchAll(/\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g)
    ].map((m) => m[1]!)
    const builtins = new Set(builtinModules)
    const outside = specifiers.filter((s) => !(s.startsWith('node:') || builtins.has(s)))
    expect(outside).toEqual([])
    // A dynamic import of a computed specifier would also escape the check above.
    expect(/\bimport\s*\(\s*[^"'`\s)]/.test(text)).toBe(false)
    expect(text).toMatch(/export\s*\{[^}]*\bas createOllama\b/)
  })

  it('every bundled npm package has a section in THIRD_PARTY_NOTICES.md', () => {
    const { provider, packages } = JSON.parse(readFileSync(PACKAGES_FILE, 'utf8')) as {
      provider: string
      packages: { name: string; version: string; license: string | null }[]
    }
    expect(provider).toBe(native.package)
    expect(packages.map((p) => p.name)).toContain(PROVIDER_PACKAGE)
    const headings = parseThirdPartyNotices(readFileSync(join(repoRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8')).map((n) => n.heading)
    const missing = packages.filter((p) => !headings.some((h) => h === p.name || h.includes(`\`${p.name}\``) || h.startsWith(`${p.name} `)))
    expect(missing).toEqual([])
    for (const p of packages) expect(p.license).toMatch(/^(MIT|Apache-2\.0)$/)
  })
})
