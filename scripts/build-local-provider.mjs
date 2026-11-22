#!/usr/bin/env node
/**
 * Bundles the local-model provider into one file (TODO 1315, ARCHITECTURE 4.6.1).
 *
 * The second backend loads an AI SDK provider package at run time to talk to Ollama's own `/api/chat` (so the context length,
 * `num_ctx`, goes with every request). Left alone, the backend installs that package from npm on first use, which hangs without a
 * network. The app therefore ships it: `ollama-ai-provider-v2` (version pinned in package.json) and the parts of its dependencies it
 * imports are bundled by esbuild into `out/local-provider/ollama-provider.mjs`, and handed over as a `file://` URL.
 *
 * Also writes `out/local-provider/packages.json`: the npm packages whose files ended up in the bundle (from esbuild's metafile), with
 * their version and license. `test/local-provider-bundle.test.ts` checks that each has a section in THIRD_PARTY_NOTICES.md and that
 * the bundle imports nothing but Node built-ins (no package or URL is fetched at load time).
 *
 * The output path is fixed here and in the adapter's table (the test checks they agree). Nothing outside the repository is read.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const PROVIDER_PACKAGE = 'ollama-ai-provider-v2'
export const OUT_DIR = resolve(repoRoot, 'out/local-provider')
export const OUT_FILE = join(OUT_DIR, 'ollama-provider.mjs')
export const PACKAGES_FILE = join(OUT_DIR, 'packages.json')

/**
 * The npm packages that contributed files to the bundle (a pure function over the metafile's input paths).
 * A path is `node_modules/<name>/…` or `node_modules/@scope/<name>/…`, possibly nested (`…/node_modules/<dep>/…`); the innermost wins.
 * @param {readonly string[]} inputs
 * @returns {string[]} the package directories relative to the repository (`node_modules/zod`, …), sorted, unique
 */
export function packageDirsOf(inputs) {
  const dirs = new Set()
  for (const input of inputs) {
    const parts = input.split(/[\\/]/)
    const at = parts.lastIndexOf('node_modules')
    if (at < 0 || at + 1 >= parts.length) continue
    const name = parts[at + 1].startsWith('@') ? parts.slice(at + 1, at + 3) : [parts[at + 1]]
    dirs.add([...parts.slice(0, at + 1), ...name].join('/'))
  }
  return [...dirs].sort()
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const pinned = pkg.devDependencies?.[PROVIDER_PACKAGE]
  if (typeof pinned !== 'string' || !/^\d+\.\d+\.\d+$/.test(pinned)) {
    throw new Error(`${PROVIDER_PACKAGE} must be pinned to an exact version in devDependencies (found ${String(pinned)})`)
  }
  let installed
  try {
    installed = JSON.parse(readFileSync(join(repoRoot, 'node_modules', PROVIDER_PACKAGE, 'package.json'), 'utf8')).version
  } catch {
    throw new Error(`${PROVIDER_PACKAGE} is not installed; run npm install`)
  }
  if (installed !== pinned) throw new Error(`${PROVIDER_PACKAGE} ${installed} is installed but ${pinned} is pinned; run npm install`)

  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  const result = await build({
    stdin: { contents: `export * from '${PROVIDER_PACKAGE}'`, resolveDir: repoRoot, loader: 'js', sourcefile: 'local-provider-entry.js' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    minify: true,
    metafile: true,
    // The metafile's paths are relative to this directory; without it the script only worked from the repository root.
    absWorkingDir: repoRoot,
    // Keep the libraries' own license comments at the end of the file.
    legalComments: 'eof',
    outfile: OUT_FILE,
    logLevel: 'warning'
  })

  const inputs = Object.keys(result.metafile.inputs)
  const packages = packageDirsOf(inputs).map((dir) => {
    const meta = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'))
    return { name: meta.name, version: meta.version, license: meta.license ?? null }
  })
  writeFileSync(PACKAGES_FILE, `${JSON.stringify({ provider: `${PROVIDER_PACKAGE}@${pinned}`, packages }, null, 2)}\n`)
  const bytes = result.metafile.outputs[relative(repoRoot, OUT_FILE).split(sep).join('/')]?.bytes ?? 0
  console.log(
    `build:local-provider: ${relative(repoRoot, OUT_FILE)} (${Math.round(bytes / 1024)} KB) from ${packages.map((p) => `${p.name}@${p.version}`).join(', ')}`
  )
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((err) => {
    console.error(`build:local-provider failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
