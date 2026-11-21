#!/usr/bin/env node
/**
 * Builds the plugins (ARCHITECTURE.md 7.1 / 7.8).
 *
 * **Vite runs once per plugin.** If everything were built in one run, shared chunks would come out in `out/plugins/chunks/`,
 * and they would fall outside the serving range of `aios-plugin://<id>/...` (the inside of the plugin's directory).
 * With one bundle per plugin, serving and process isolation share the same boundary.
 *
 * The manifest is copied, not built (it is the source of truth that main reads).
 */
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const pluginsDir = resolve(repoRoot, 'plugins')
const outRoot = resolve(repoRoot, 'out/plugins')

function pluginDirs() {
  return readdirSync(pluginsDir).filter((name) => {
    const full = resolve(pluginsDir, name)
    if (!statSync(full).isDirectory()) return false
    try {
      statSync(resolve(full, 'manifest.json'))
      return true
    } catch {
      return false
    }
  })
}

/**
 * The files of an external package to bundle (TODO 405; the pdf.js worker / CMap / glyphs / wasm of `aios.pdf`).
 * If `plugins/<id>/vendor.json` exists, it copies `{ "copy": [{ "from": "<relative to node_modules>", "to": "<relative to the output>" }] }`.
 * The manifest is `.strict()`, so a key cannot be added to it; that is why this is a separate file. Neither `from` nor `to` can point
 * outside `node_modules` / the output directory (`..` is rejected).
 */
function copyVendor(root, outDir) {
  const spec = resolve(root, 'vendor.json')
  let copies
  try {
    copies = JSON.parse(readFileSync(spec, 'utf8')).copy
  } catch (err) {
    if (err?.code === 'ENOENT') return
    throw err
  }
  const nodeModules = resolve(repoRoot, 'node_modules')
  for (const { from, to } of copies) {
    if ([from, to].some((p) => typeof p !== 'string' || p.split(/[\\/]/).includes('..') || isAbsolute(p))) {
      throw new Error(`vendor.json: bad path in ${spec}`)
    }
    const target = resolve(outDir, to)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(resolve(nodeModules, from), target, { recursive: true, dereference: true })
  }
}

for (const id of pluginDirs()) {
  const root = resolve(pluginsDir, id)
  const outDir = resolve(outRoot, id)
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))

  const alias = {
    '@shared': resolve(repoRoot, 'src/shared'),
    '@pluginshared': resolve(pluginsDir, '_shared')
  }
  const common = (extra) => ({
    root,
    base: './',
    logLevel: 'warn',
    resolve: { alias },
    build: {
      outDir,
      target: 'es2022',
      minify: false,
      rollupOptions: {
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]'
        }
      },
      ...extra
    }
  })

  // 1) viewer (iframe). A normal app build, with the HTML as the entry point.
  if (manifest.viewer !== undefined) {
    const config = common({ emptyOutDir: true })
    config.build.rollupOptions.input = { 'viewer/index': resolve(root, manifest.viewer.entry) }
    await build(config)
  }

  // 2) Code that runs in plugin-host. It is an ESM **read by Node**, so the entry's exports
  // must be kept (`preserveEntrySignatures`). With the default app build it is treated as an "entry with side effects only", and
  // its default export is tree-shaken away along with everything, leaving an empty file.
  // There is one entry (review C-4). `host.entry` is the source of truth; the old-form `command.entry` and the like are aligned to
  // the same file by validation, so the duplicates are dropped and it is built only once.
  const hostEntries = new Set(
    ['host', 'command', 'mcp', 'indexer']
      .map((key) => manifest[key]?.entry)
      .filter((entry) => entry !== undefined)
  )
  for (const entry of hostEntries) {
    const config = common({ emptyOutDir: false, ssr: true })
    // The manifest points at a .js file. The actual file is .ts, so it is swapped in as the input.
    config.build.rollupOptions.input = {
      [entry.replace(/\.js$/, '')]: resolve(root, entry.replace(/\.js$/, '.ts'))
    }
    config.build.rollupOptions.preserveEntrySignatures = 'strict'
    await build(config)
  }

  mkdirSync(outDir, { recursive: true })
  copyVendor(root, outDir)
  copyFileSync(resolve(root, 'manifest.json'), resolve(outDir, 'manifest.json'))
  // The icon (TODO 524). Copies the manifest's `icon` to the same relative position. Validation (relative, extension, inside) is done by main when it loads it.
  if (typeof manifest.icon === 'string') {
    if (manifest.icon.split(/[\\/]/).includes('..') || isAbsolute(manifest.icon)) {
      throw new Error(`manifest.icon: bad path in ${id}`)
    }
    const target = resolve(outDir, manifest.icon)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(resolve(root, manifest.icon), target)
  }
  console.log(`plugins: built ${id}`)
}
