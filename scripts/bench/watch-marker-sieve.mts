/**
 * TODO 1324: flow and cost of the watch sieve now that `build` / `dist` / `target` / `venv` are not in the native ignore globs.
 *
 * Builds a throwaway tree under `~/.aios-test/` (never anything real), subscribes with `@parcel/watcher` **twice** - once with the
 * old ignore (the four names as globs) and once with the new one (no globs for them) - and writes N files into `proj/build/`
 * (a project with `package.json`). Prints, per mode: native events delivered to JS, events that survive the sieve (should be 0),
 * the time the sieve spent, and the marker lookups (readdir calls). Then a micro-measure of `isExcludedEvent` per event, cached
 * and uncached. It calls no model and starts no app.
 *
 *   npx vite-node -c vitest.config.ts scripts/bench/watch-marker-sieve.mts -- [files, default 20000]
 */
import watcher from '@parcel/watcher'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createMacosExclusions } from '../../src/common/exclusions.js'
import { ProjectMarkerCache, isExcludedEvent, sieveEvents, watchPlan } from '../../src/index-kernel/watcher.js'

const files = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg)) ?? 20000)
const root = join(homedir(), '.aios-test', `bench-marker-${process.pid}`)
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function run(label: string, dropFourGlobs: boolean): Promise<void> {
  const proj = join(root, label, 'proj')
  mkdirSync(join(proj, 'build', 'deep'), { recursive: true })
  writeFileSync(join(proj, 'package.json'), '{}')
  const rules = createMacosExclusions(root)
  const base = join(root, label)
  const oldGlobs = ['build', 'dist', 'target', 'venv'].map((name) => `**/${name}`)
  const plan = watchPlan(base, rules)[0]!
  const ignore = dropFourGlobs ? [...plan.ignore] : [...plan.ignore, ...oldGlobs]
  const markers = new ProjectMarkerCache(rules)
  let delivered = 0
  let survived = 0
  let sieveMs = 0
  const subscription = await watcher.subscribe(
    base,
    (_err, events) => {
      delivered += events.length
      const start = performance.now()
      survived += sieveEvents(events, rules, base, markers).filter((event) => event.path.includes('/build/')).length
      sieveMs += performance.now() - start
    },
    { ignore }
  )
  const wrote = performance.now()
  for (let i = 0; i < files; i += 1) writeFileSync(join(proj, 'build', 'deep', `f${i}.o`), '')
  const writeMs = performance.now() - wrote
  await sleep(2500)
  await subscription.unsubscribe()
  console.log(
    JSON.stringify({
      mode: label,
      files,
      writeMs: Math.round(writeMs),
      delivered,
      survivedUnderBuild: survived,
      sieveMs: Math.round(sieveMs),
      cachedParents: markers.size
    })
  )
}

try {
  mkdirSync(root, { recursive: true })
  await run('old-globs', false)
  await run('new-sieve', true)

  // Micro: per-event cost of the sieve judgement.
  const rules = createMacosExclusions(root)
  const base = join(root, 'new-sieve')
  const path = join(base, 'proj', 'build', 'deep', 'f1.o')
  const n = 200_000
  const cached = new ProjectMarkerCache(rules)
  let t = performance.now()
  for (let i = 0; i < n; i += 1) isExcludedEvent(path, rules, base, cached)
  const cachedUs = ((performance.now() - t) * 1000) / n
  const m = 20_000
  t = performance.now()
  for (let i = 0; i < m; i += 1) isExcludedEvent(path, rules, base)
  const uncachedUs = ((performance.now() - t) * 1000) / m
  console.log(JSON.stringify({ microPerEventUs: { cached: Number(cachedUs.toFixed(2)), uncached: Number(uncachedUs.toFixed(2)) } }))
} finally {
  rmSync(root, { recursive: true, force: true })
}
