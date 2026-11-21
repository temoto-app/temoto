#!/usr/bin/env node
/**
 * The lint for constraint 6 (IMPLEMENTATION_BRIEF chapter 3 / ARCHITECTURE.md 4.6.1).
 *
 * It keeps the words specific to a CLI backend out of the app code, and guarantees that the AgentAdapter interface does not leak
 * the vocabulary of any particular backend. The forbidden words themselves are in compat/forbidden-terms.json (compat/ is the allowed area),
 * and this script holds no literals.
 *
 * spikes/ is excluded, since it holds throwaway scripts (it is not in scanGlobs).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const config = JSON.parse(readFileSync(join(repoRoot, 'compat/forbidden-terms.json'), 'utf8'))

const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.git'])
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|html|css|md)$/

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const found = []
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) found.push(...walk(full))
    else if (TEXT_EXT.test(name)) found.push(full)
  }
  return found
}

const files = []
for (const target of config.scanGlobs) {
  const full = join(repoRoot, target)
  let st
  try {
    st = statSync(full)
  } catch {
    continue
  }
  if (st.isDirectory()) files.push(...walk(full))
  else files.push(full)
}

const allowed = config.allowedPaths.map((p) => p.split('/').join(sep))
const patterns = config.terms.map((t) => ({ term: t, re: new RegExp(t, 'gi') }))
const violations = []

for (const file of files) {
  const rel = relative(repoRoot, file)
  if (allowed.some((prefix) => rel.startsWith(prefix))) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const { term, re } of patterns) {
      re.lastIndex = 0
      if (re.test(line)) violations.push({ rel, line: i + 1, term, text: line.trim().slice(0, 100) })
    }
  })
}

if (violations.length > 0) {
  console.error(
    `禁止語が ${config.allowedPaths.join(' / ')} の外に ${violations.length} 件あります (制約 6):`
  )
  for (const v of violations) console.error(`  ${v.rel}:${v.line}  [${v.term}]  ${v.text}`)
  process.exit(1)
}

console.log(
  `lint:terms OK — ${files.length} ファイルを検査、禁止語 ${config.terms.length} 件の違反なし`
)
