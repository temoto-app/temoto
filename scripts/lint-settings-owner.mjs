#!/usr/bin/env node
/**
 * The machine check for the completion condition of TODO 85.
 *
 *   "A key of `app_settings` is written or removed only by the process that is its owner"
 *
 * `owner` (`'main'` | `'index'`) appears only as the second argument of `defineKey(key, owner, …)` / `integerKey(key, owner)` in
 * `src/common/settings-keys.ts`. This script reads that table to build "which identifier belongs to which owner", then searches, in each
 * directory that `scripts/settings-owner.json` names, for `settings.writeTyped(<identifier>, …)` / `settings.removeTyped(<identifier>)`,
 * and checks whether the identifier's owner is allowed to do it (`readTyped` for reading is free from both sides).
 *
 * `test/settings-owner.test.ts` calls the same function, so `npm test` fails as well
 * (it is also confirmed there that the check really catches planted violations).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const config = JSON.parse(readFileSync(join(repoRoot, 'scripts/settings-owner.json'), 'utf8'))

const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/

/** `export const NAME = defineKey('key', 'owner', …)` / `= integerKey('key', 'owner')`. */
const KEY_DEFINITION_RE =
  /export const (\w+)(?::\s*[^=]+)? = (?:defineKey|integerKey)\s*(?:<[^(]*>)?\(\s*[^,]*,\s*'(main|index)'/g

/**
 * `featureCacheKey` / `backendModelsKey` are functions (they build a key for each version and backend),
 * but their owner is always fixed.
 */
const KNOWN_FUNCTION_OWNERS = { featureCacheKey: 'main', backendModelsKey: 'main' }

function walk(dir) {
  const found = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) found.push(...walk(full))
    else if (SOURCE_EXT.test(name)) found.push(full)
  }
  return found
}

/** Reads `settings-keys.ts` and builds `{ identifier: owner }`. */
function loadOwnerTable(root) {
  const text = readFileSync(join(root, config.settingsKeysFile), 'utf8')
  const table = { ...KNOWN_FUNCTION_OWNERS }
  for (const match of text.matchAll(KEY_DEFINITION_RE)) {
    const name = match[1]
    const owner = match[2]
    if (name === undefined || owner === undefined) continue
    table[name] = owner
  }
  return table
}

/** `{ local name: original name }` for `import { A, B as C } from '….settings-keys.js'`. */
function importedAliases(text, specifierSuffix) {
  const aliases = {}
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  for (const match of text.matchAll(importRe)) {
    const specifier = match[2]
    if (specifier === undefined || !specifier.endsWith(specifierSuffix)) continue
    const names = match[1] ?? ''
    for (const part of names.split(',')) {
      const trimmed = part.trim().replace(/^type\s+/, '')
      if (trimmed === '') continue
      const asMatch = /^(\w+)\s+as\s+(\w+)$/.exec(trimmed)
      if (asMatch) {
        const [, original, local] = asMatch
        if (original !== undefined && local !== undefined) aliases[local] = original
      } else {
        aliases[trimmed] = trimmed
      }
    }
  }
  return aliases
}

const WRITE_CALL_RE = /\.(writeTyped|removeTyped)\(\s*(\w+)/g

/** @returns {{file: string, line: number, message: string}[]} */
export function checkSettingsOwner(root = repoRoot) {
  const violations = []
  const ownerTable = loadOwnerTable(root)

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
        const rel = relative(root, file).split(sep).join('/')
        const text = readFileSync(file, 'utf8')
        const aliases = importedAliases(text, config.settingsKeysSpecifier)
        if (Object.keys(aliases).length === 0) continue

        for (const match of text.matchAll(WRITE_CALL_RE)) {
          const method = match[1]
          const local = match[2]
          if (local === undefined) continue
          const original = aliases[local]
          if (original === undefined) continue
          const owner = ownerTable[original]
          if (owner === undefined || owner !== rule.forbiddenOwner) continue
          const line = text.slice(0, match.index ?? 0).split('\n').length
          violations.push({
            file: rel,
            line,
            message: `[${rule.name}] owner: '${owner}' の鍵 ${original} を .${method}() で書いている`
          })
        }
      }
    }
  }
  return violations
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = checkSettingsOwner()
  if (violations.length > 0) {
    console.error(`app_settings の owner 違反が ${violations.length} 件あります (TODO 85):`)
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.message}`)
    process.exit(1)
  }
  console.log("lint:settings-owner OK — 鍵は owner の書いたプロセスでしか write / remove していない")
}
