#!/usr/bin/env node
/**
 * The machine check for the completion condition of P1 (docs/OPTIMIZATION_BRIEF.md 3.8, ARCHITECTURE.md chapter 3).
 *
 *   "The index and the scan come out of main, and nothing flows back"
 *
 * It looks only at the direction of imports:
 *
 *  1. `src/index-kernel/` and `src/index-host/` import neither `electron` nor `src/main/`
 *  2. `src/common/` imports neither side (it is the foundation for both)
 *  3. `src/main/` touches the index side **only with `import type`**.
 *     The moment a single value is imported, the index's SQLite comes back into main's bundle.
 *
 * The words it checks are written as literals only in `scripts/index-boundaries.json`
 * (the same construction as the constraint 6 lint and the Phase 4 plugin boundary check, so that the lint itself
 * does not violate its own rules).
 *
 * The same check is also called from `test/index-boundaries.test.ts`, so it fails in both `npm test` and `npm run lint`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const config = JSON.parse(readFileSync(join(repoRoot, 'scripts/index-boundaries.json'), 'utf8'))

const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/
/**
 * One import / export statement. The first group takes everything up to `from`, so whether it is `import type` / `export type`
 * can be decided there. It also catches dynamic imports and side-effect imports.
 */
const IMPORT_RE =
  /(?:^|[^\w.])((?:import|export)\s[^;]*?)from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^\w.])import\s*['"]([^'"]+)['"]/g

function walk(dir) {
  const found = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) found.push(...walk(full))
    else if (SOURCE_EXT.test(name)) found.push(full)
  }
  return found
}

/** Whether the relative path points inside `dir` (relative to the repo). */
function inside(relativePath, dir) {
  const normalized = relativePath.split(sep).join('/')
  return normalized === dir || normalized.startsWith(`${dir}/`)
}

/** @returns {{file: string, line: number, message: string}[]} */
export function checkIndexBoundaries(root = repoRoot) {
  const violations = []
  for (const rule of config.rules) {
    for (const dir of rule.scanDirs) {
      const base = join(root, dir)
      let stats
      try {
        stats = statSync(base)
      } catch {
        continue
      }
      if (!stats.isDirectory()) continue

      for (const file of walk(base)) {
        const rel = relative(root, file)
        const text = readFileSync(file, 'utf8')

        for (const match of text.matchAll(IMPORT_RE)) {
          const specifier = match[2] ?? match[3] ?? match[4]
          if (specifier === undefined) continue
          const line = text.slice(0, match.index ?? 0).split('\n').length
          // `import type { X } from` / `export type { X } from` do not bring in a value.
          const typeOnly = /\btype\b/.test(match[1] ?? '')

          if (rule.forbiddenImports.includes(specifier)) {
            violations.push({ file: rel, line, message: `[${rule.name}] 禁止モジュール: ${specifier}` })
            continue
          }

          // Which directory in the repo the target is in. Only relative imports are resolved
          // (`@shared/` is an alias, a foundation that is allowed on both the index side and the main side).
          if (!specifier.startsWith('.')) continue
          const target = relative(root, resolve(dirname(file), specifier))
          for (const forbidden of rule.forbiddenDirs) {
            if (!inside(target, forbidden)) continue
            if (rule.allowTypeOnly && typeOnly) continue
            violations.push({
              file: rel,
              line,
              message: `[${rule.name}] ${forbidden} への${rule.allowTypeOnly ? '値の' : ''}import: ${specifier}`
            })
          }
        }
      }
    }
  }
  return violations
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = checkIndexBoundaries()
  if (violations.length > 0) {
    console.error(`索引プロセスの境界違反が ${violations.length} 件あります (P1 の完了条件):`)
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.message}`)
    process.exit(1)
  }
  console.log('lint:index OK — 索引と走査は main から出ていて、逆流していない')
}
