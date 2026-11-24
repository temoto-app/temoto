/**
 * TODO 1324: `build` / `dist` / `target` / `venv` are excluded only when their parent holds a project marker.
 *
 * The pure verdict (`classify` with `parentHasMarker`), the one disk helper (`project-marker.ts`), and that the scan, the watch sieve,
 * the listing, the read gate (`resolvePath`), the Broker-side gate (`FsAccess`) and create all give the same answer on a real temporary tree.
 * Case: names and markers are compared case-insensitively like every other name rule (`foldPath`).
 * The model is not called.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import {
  PROJECT_MARKERS,
  classify,
  classifyAccess,
  createMacosExclusions,
  hasProjectMarker
} from '../src/common/exclusions.js'
import { resolvePath } from '../src/common/fs-policy.js'
import { runMigrations } from '../src/common/migrations.js'
import { classifyAccessOnDisk, classifyOnDisk, dirHasProjectMarker } from '../src/common/project-marker.js'
import { pathToUri } from '../src/common/uri.js'
import { FsIndexer } from '../src/index-kernel/indexer.js'
import { walk, type ScanCounters } from '../src/index-kernel/scanner.js'
import { IndexStore } from '../src/index-kernel/store.js'
import { ProjectMarkerCache, isExcludedEvent, sieveEvents, watchPlan } from '../src/index-kernel/watcher.js'
import { FsAccess } from '../src/main/fs/access.js'
import { createEntry } from '../src/main/fs/create.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

const HOME = '/Users/tester'
const rules = createMacosExclusions(HOME)

describe('classify: pure, the parent answer is an argument', () => {
  it('the four names are excluded only with a marker beside them; the other ten stay name-only', () => {
    for (const name of ['build', 'dist', 'target', 'venv']) {
      const path = `${HOME}/p/${name}`
      expect(classify(path, name, true, rules, true), name).toEqual({ excluded: true, reason: 'generated' })
      expect(classify(path, name, true, rules, false).excluded, name).toBe(false)
      expect(classify(path, name, true, rules).excluded, `${name} default`).toBe(false)
      // A file with that name is never excluded.
      expect(classify(path, name, false, rules, true).excluded, `${name} file`).toBe(false)
    }
    for (const name of [
      'node_modules',
      '__pycache__',
      '.venv',
      '.next',
      '.nuxt',
      '.turbo',
      '.gradle',
      '.tox',
      '.mypy_cache',
      '.pytest_cache'
    ]) {
      expect(classify(`${HOME}/p/${name}`, name, true, rules, false).excluded, name).toBe(true)
    }
  })

  it('names are folded: Build / DIST count, and a marker spelled Package.json counts', () => {
    expect(classify(`${HOME}/p/Build`, 'Build', true, rules, true).excluded).toBe(true)
    expect(classify(`${HOME}/p/DIST`, 'DIST', true, rules, true).excluded).toBe(true)
    expect(hasProjectMarker(['readme.md', 'Package.json'], rules)).toBe(true)
    expect(hasProjectMarker(['MAKEFILE'], rules)).toBe(true)
    expect(hasProjectMarker(['.GIT'], rules)).toBe(true)
    expect(hasProjectMarker(['readme.md', 'notes.txt', 'package.json.bak'], rules)).toBe(false)
  })

  it('the marker table has the ten agreed names in one place', () => {
    expect([...PROJECT_MARKERS].sort()).toEqual(
      [
        '.git',
        'CMakeLists.txt',
        'Cargo.toml',
        'Makefile',
        'build.gradle',
        'build.gradle.kts',
        'package.json',
        'pom.xml',
        'pyproject.toml',
        'setup.py'
      ].sort()
    )
  })

  it('the native ignore globs no longer carry the four names, and still carry the rest', () => {
    const ignore = watchPlan(HOME, rules)[0]?.ignore ?? []
    for (const name of ['build', 'dist', 'target', 'venv']) expect(ignore, name).not.toContain(`**/${name}`)
    for (const name of ['node_modules', '.venv', '__pycache__', '.next']) expect(ignore, name).toContain(`**/${name}`)
  })
})

describe('on a real tree: scan, watch sieve, listing, gates and create agree', () => {
  let home: string
  let rulesHere: ReturnType<typeof createMacosExclusions>
  const p = (...parts: string[]): string => join(home, ...parts)

  beforeAll(() => {
    home = makeTestDir('project-marker')
    rulesHere = createMacosExclusions(home)
    // A real project, a plain folder with the same names, a nested project, and a marker spelled in capitals.
    mkdirSync(p('proj', 'build'), { recursive: true })
    mkdirSync(p('proj', 'dist'))
    mkdirSync(p('proj', 'src'))
    writeFileSync(p('proj', 'package.json'), '{}')
    writeFileSync(p('proj', 'build', 'out.js'), '')
    writeFileSync(p('proj', 'src', 'a.ts'), '')
    mkdirSync(p('docs', 'build'), { recursive: true })
    mkdirSync(p('docs', 'target'))
    writeFileSync(p('docs', 'build', 'plan.md'), '')
    // Nested: packages/a has a marker, packages/b has none.
    mkdirSync(p('proj', 'packages', 'a', 'build'), { recursive: true })
    mkdirSync(p('proj', 'packages', 'b', 'build'), { recursive: true })
    writeFileSync(p('proj', 'packages', 'a', 'package.json'), '{}')
    writeFileSync(p('proj', 'packages', 'a', 'build', 'x.js'), '')
    writeFileSync(p('proj', 'packages', 'b', 'build', 'y.js'), '')
    // Case: a `Build` folder beside `Package.json`, and a `Build` folder beside nothing.
    mkdirSync(p('caps', 'Build'), { recursive: true })
    writeFileSync(p('caps', 'Package.json'), '{}')
    mkdirSync(p('plain', 'Build'), { recursive: true })
    // A marker that is a symlink and a marker that is a directory (`.git`): the name alone counts, nothing is followed or opened.
    mkdirSync(p('linked', 'dist'), { recursive: true })
    symlinkSync('/nonexistent-target', p('linked', 'Makefile'))
    mkdirSync(p('gitdir', '.git'), { recursive: true })
    mkdirSync(p('gitdir', 'target'))
  })
  afterAll(() => removeTestDir(home))

  async function scanned(): Promise<Set<string>> {
    const counters: ScanCounters = { seen: 0, excluded: 0, denied: 0, pruned: 0 }
    const paths = new Set<string>()
    for await (const batch of walk(home, rulesHere, counters)) for (const entry of batch) paths.add(entry.path)
    return paths
  }

  const cases: { path: string; excluded: boolean; why: string }[] = [
    { path: 'proj/build', excluded: true, why: 'marker beside it' },
    { path: 'proj/dist', excluded: true, why: 'marker beside it' },
    { path: 'docs/build', excluded: false, why: 'no marker' },
    { path: 'docs/target', excluded: false, why: 'no marker' },
    { path: 'proj/packages/a/build', excluded: true, why: 'nested, parent a has a marker' },
    { path: 'proj/packages/b/build', excluded: false, why: 'nested, parent b has none (the project root above does not count)' },
    { path: 'caps/Build', excluded: true, why: 'case: Build beside Package.json' },
    { path: 'plain/Build', excluded: false, why: 'case: Build, no marker' },
    { path: 'linked/dist', excluded: true, why: 'a symlink marker counts by name' },
    { path: 'gitdir/target', excluded: true, why: '.git counts' }
  ]

  it('the disk helper answers from names only', () => {
    expect(dirHasProjectMarker(p('proj'), rulesHere)).toBe(true)
    expect(dirHasProjectMarker(p('caps'), rulesHere)).toBe(true)
    expect(dirHasProjectMarker(p('linked'), rulesHere)).toBe(true)
    expect(dirHasProjectMarker(p('gitdir'), rulesHere)).toBe(true)
    expect(dirHasProjectMarker(p('docs'), rulesHere)).toBe(false)
    expect(dirHasProjectMarker(p('proj', 'packages'), rulesHere)).toBe(false)
    expect(dirHasProjectMarker(p('missing'), rulesHere)).toBe(false)
  })

  it('scan: pruned exactly where the marker is, and the contents of a kept folder are walked', async () => {
    const seen = await scanned()
    for (const { path, excluded, why } of cases) {
      expect(seen.has(p(path)), `${path}: ${why}`).toBe(!excluded)
    }
    expect(seen.has(p('docs', 'build', 'plan.md'))).toBe(true)
    expect(seen.has(p('proj', 'build', 'out.js'))).toBe(false)
    expect(seen.has(p('proj', 'packages', 'b', 'build', 'y.js'))).toBe(true)
    expect(seen.has(p('proj', 'packages', 'a', 'build', 'x.js'))).toBe(false)
  })

  it('classifyOnDisk gives the same verdict as the scan for every case', async () => {
    const seen = await scanned()
    for (const { path } of cases) {
      const name = path.slice(path.lastIndexOf('/') + 1)
      expect(classifyOnDisk(p(path), name, true, rulesHere).excluded, path).toBe(!seen.has(p(path)))
      expect(classifyAccessOnDisk(p(path), name, true, rulesHere, 'read').excluded, `${path} read`).toBe(!seen.has(p(path)))
    }
  })

  it('watch sieve: a diff under a marked build is dropped, an unmarked one passes (nested too)', () => {
    const markers = new ProjectMarkerCache(rulesHere)
    for (const [path, dropped] of [
      ['proj/build/out.js', true],
      ['proj/build/deep/er/f.o', true],
      ['proj/packages/a/build/x.js', true],
      ['proj/packages/b/build/y.js', false],
      ['docs/build/plan.md', false],
      ['caps/Build/z.js', true],
      ['plain/Build/z.js', false],
      ['proj/src/a.ts', false]
    ] as const) {
      expect(isExcludedEvent(p(path), rulesHere, home, markers), path).toBe(dropped)
      expect(isExcludedEvent(p(path), rulesHere, home), `${path} (uncached)`).toBe(dropped)
    }
    // The ten name-only folders are dropped with no lookup.
    expect(isExcludedEvent(p('docs', 'node_modules', 'pkg', 'i.js'), rulesHere, home, { has: () => false })).toBe(true)
  })

  it('watch sieve: a marker appearing or disappearing drops the cached answer at once', () => {
    const dir = p('flip')
    mkdirSync(join(dir, 'build'), { recursive: true })
    const markers = new ProjectMarkerCache(rulesHere, 60_000)
    const event = { type: 'create' as const, path: join(dir, 'build', 'a.o') }
    expect(sieveEvents([event], rulesHere, home, markers)).toHaveLength(1)
    // `git init` / `npm init`: the marker is created, and its own event arrives in the same round as build output.
    writeFileSync(join(dir, 'package.json'), '{}')
    const round = [
      { type: 'create' as const, path: join(dir, 'package.json') },
      { type: 'create' as const, path: join(dir, 'build', 'b.o') }
    ]
    expect(sieveEvents(round, rulesHere, home, markers).map((e) => e.path)).toEqual([join(dir, 'package.json')])
    // And back: the marker is deleted.
    writeFileSync(join(dir, 'package.json'), '{}')
    const removed = [{ type: 'delete' as const, path: join(dir, 'package.json') }]
    // The cache holds `true` for 60 s, but the marker event for the directory clears it, then the disk is read again (still present here).
    expect(sieveEvents(removed, rulesHere, home, markers)).toHaveLength(1)
    expect(markers.has(dir)).toBe(true)
  })

  it('watch sieve: the cache answers from memory within the TTL and re-reads after it', () => {
    let at = 1000
    const dir = p('ttl')
    mkdirSync(join(dir, 'build'), { recursive: true })
    const markers = new ProjectMarkerCache(rulesHere, 100, () => at)
    expect(markers.has(dir)).toBe(false)
    writeFileSync(join(dir, 'Makefile'), '')
    expect(markers.has(dir)).toBe(false) // still cached
    at += 101
    expect(markers.has(dir)).toBe(true)
    expect(markers.size).toBe(1)
  })

  it('the read gate (resolvePath) is unchanged: it looks only at the final name, with the new parent rule for the four names', () => {
    const scope = { rules: rulesHere }
    // A file inside a marked build is still reachable by direct path (the owner decision: no per-level check here).
    expect(() => resolvePath(p('proj', 'build', 'out.js'), scope, false, 'read')).not.toThrow()
    // The marked folder itself is refused, the unmarked one is not.
    expect(() => resolvePath(p('proj', 'build'), scope, true, 'read')).toThrow()
    expect(() => resolvePath(p('docs', 'build'), scope, true, 'read')).not.toThrow()
    expect(() => resolvePath(p('docs', 'build', 'plan.md'), scope, false, 'read')).not.toThrow()
    // The name-only folders are refused as before, whatever is beside them.
    expect(() => resolvePath(p('docs', 'node_modules'), scope, true, 'read')).toThrow()
    // classifyAccess alone, with no argument, never excludes the four names.
    expect(classifyAccess(p('proj', 'build'), 'build', true, rulesHere, 'read').excluded).toBe(false)
  })

  it('FsAccess (the main-side gate) and the default reference dirs follow the same answer', () => {
    mkdirSync(p('dist'), { recursive: true })
    const gate = new FsAccess(home, [home])
    expect(() => gate.assertAllowed(pathToUri(p('proj', 'dist')), true)).toThrow()
    expect(() => gate.assertAllowed(pathToUri(p('docs', 'target')), true)).not.toThrow()
    expect(gate.isReferenceable(p('proj', 'build'))).toBe(false)
    expect(gate.isReferenceable(p('docs', 'build'))).toBe(true)
    // Directly under the home there is no marker, so a home-level `dist` is a reference dir; with a marker in the home it is not.
    expect(gate.defaultReferenceDirs()).toContain(p('dist'))
    writeFileSync(p('Makefile'), '')
    expect(gate.defaultReferenceDirs()).not.toContain(p('dist'))
  })

  it('create: an unmarked build/ can be created in and under; a marked build/ and node_modules are still refused', () => {
    const gate = new FsAccess(home, [home])
    expect(createEntry(gate, 'file', pathToUri(p('docs')), 'build/new.md').reason).toBeNull()
    expect(createEntry(gate, 'file', pathToUri(p('docs', 'build')), 'more.md').reason).toBeNull()
    expect(createEntry(gate, 'file', pathToUri(p('proj')), 'build/new.js').reason).toBe('path-excluded')
    expect(createEntry(gate, 'file', pathToUri(p('proj', 'build')), 'x.js').reason).toBe('path-excluded')
    expect(createEntry(gate, 'file', pathToUri(p('docs')), 'node_modules/x.js').reason).toBe('path-excluded')
    // A folder to be created next to a marker that does not exist yet is judged as if it had none.
    expect(createEntry(gate, 'folder', pathToUri(p('docs')), 'fresh/build').reason).toBeNull()
  })

  it('the listing (FsIndexer.listDirectory) hides a marked build and shows an unmarked one', async () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const indexer = new FsIndexer(db, { onScanStatus: () => {}, onFileChanges: () => {} }, new IndexStore(db), home, [home])
    try {
      const names = async (dir: string): Promise<string[]> =>
        (await indexer.listDirectory(pathToUri(dir))).entries.map((entry) => entry.name).sort()
      expect(await names(p('proj'))).toEqual(['package.json', 'packages', 'src'])
      expect(await names(p('docs'))).toEqual(['build', 'fresh', 'target'])
      expect(await names(p('proj', 'packages', 'a'))).toEqual(['package.json'])
      expect(await names(p('proj', 'packages', 'b'))).toEqual(['build'])
      expect(await names(p('caps'))).toEqual(['Package.json'])
      expect(await names(p('plain'))).toEqual(['Build'])
    } finally {
      db.close()
    }
  })
})
