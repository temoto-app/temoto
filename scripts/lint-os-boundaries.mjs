#!/usr/bin/env node
/**
 * The machine check of stage 1 of TODO 986 (ARCHITECTURE 3.4 "the OS entry point").
 *
 *   "Points that ask about the OS, and OS-specific tools and APIs, do not exist outside the OS entry points (`src/main/os/` / `src/common/os/`)"
 *
 * Specifically, under `scanDirs` (excluding the entry points and the exceptions), it checks the following:
 *
 *  1. The forms that read the OS that is running: `process.platform`; `platform` imported from the OS / process modules; `.platform`
 *     taken from the namespace of those modules
 *  2. Electron's macOS-only APIs: an import of `systemPreferences`, and members from tables such as `app.dock`
 *  3. The names of OS tools: the string of a name in the table itself (for short names, only the first argument of a call that starts
 *     a child process), strings in the form of a tool's location such as `/usr/bin/…`, and URLs of the OS settings screens
 *
 * The words it checks are written as literals only in `scripts/os-boundaries.json` (the same construction as the constraint 6 / 8 / 8.1
 * lints, so that the lint itself does not violate its own rules). It looks at the syntax tree, so comments are not picked up.
 *
 * The same check is also called from `test/os-boundaries.test.ts`, so it fails in both `npm test` and `npm run lint`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const config = JSON.parse(readFileSync(join(repoRoot, 'scripts/os-boundaries.json'), 'utf8'))

const toolNames = new Set(config.toolNames)
const spawnOnlyToolNames = new Set(config.spawnOnlyToolNames)
const spawnCallees = new Set(config.spawnCallees)
const platformModules = new Set(config.platformModules)
const forbiddenElectronImports = new Set(config.forbiddenElectronImports)
const toolPathPatterns = config.toolPathPatterns.map((p) => new RegExp(p))

/** @param {string} fileName */
function scriptKindOf(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (/\.(ts|mts|cts)$/.test(fileName)) return ts.ScriptKind.TS
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  return ts.ScriptKind.JS
}

function walk(dir) {
  const found = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) found.push(...walk(full))
    else if (config.sourceExtensions.some((ext) => name.endsWith(ext)) && !name.endsWith('.d.ts')) found.push(full)
  }
  return found
}

/** Whether `rel` (relative to the repo, `/`-separated) is inside `dir`. */
function inside(rel, dir) {
  const d = dir.replace(/\/$/, '')
  return rel === d || rel.startsWith(`${d}/`)
}

/** The name of the callee (`execFile(…)` gives execFile; `this.spawn(…)` gives spawn). Returns null if it cannot be obtained. */
function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return null
}

/** Whether the value has the form of a tool's name or location. Returns the reason it matched. */
function toolLiteral(value) {
  if (toolNames.has(value)) return `OS の道具の名前: '${value}'`
  if (toolPathPatterns.some((re) => re.test(value))) return `OS の道具の置き場所: '${value}'`
  return null
}

/**
 * Checks one file.
 * @param {string} text
 * @param {string} fileName
 * @returns {{line: number, message: string}[]}
 */
export function checkOsSource(text, fileName) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindOf(fileName))
  const found = []
  const at = (node, message) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    found.push({ line: line + 1, message })
  }
  /** The names under which the OS / process modules were received, as a namespace or by default (the `os` in `import os from 'node:os'`). */
  const platformNamespaces = new Set()
  /** Literals already reported as the first argument (to avoid reporting a tool's name twice). */
  const reported = new Set()

  // First pass: look at the imports.
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const from = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (clause === undefined) continue
    if (platformModules.has(from)) {
      if (clause.name !== undefined) platformNamespaces.add(clause.name.text)
      const bindings = clause.namedBindings
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) platformNamespaces.add(bindings.name.text)
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const imported = (el.propertyName ?? el.name).text
          if (imported === config.platformMember) at(el, `走っている OS を読む import: ${imported} from '${from}'`)
        }
      }
    }
    if (from === config.electronModule && clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text
        if (forbiddenElectronImports.has(imported)) at(el, `electron の macOS だけの API: ${imported}`)
      }
    }
  }
  const memberOf = (node) => {
    if (ts.isPropertyAccessExpression(node)) return { object: node.expression, property: node.name.text }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      return { object: node.expression, property: node.argumentExpression.text }
    }
    return null
  }

  const visit = (node) => {
    const member = memberOf(node)
    if (member !== null) {
      const objectName = ts.isIdentifier(member.object) ? member.object.text : null
      const isProcess =
        objectName === config.processGlobal ||
        (ts.isPropertyAccessExpression(member.object) && member.object.name.text === config.processGlobal)
      if (member.property === config.platformMember && (isProcess || (objectName !== null && platformNamespaces.has(objectName)))) {
        at(node, `走っている OS を読む形: ${objectName ?? config.processGlobal}.${member.property}`)
      }
      for (const rule of config.forbiddenMembers) {
        if (member.property !== rule.property) continue
        if (rule.object !== null && objectName !== rule.object) continue
        at(node, `macOS だけの API: ${rule.object === null ? '' : `${rule.object}.`}${rule.property} — ${rule.why}`)
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression)
      const first = node.arguments[0]
      if (name !== null && spawnCallees.has(name) && first !== undefined && ts.isStringLiteralLike(first)) {
        const reason = spawnOnlyToolNames.has(first.text) ? `OS の道具の名前: '${first.text}'` : toolLiteral(first.text)
        if (reason !== null) {
          at(first, `${reason} (${name} の第 1 引数)`)
          reported.add(first)
        }
      }
    }
    if (ts.isStringLiteralLike(node) && !reported.has(node)) {
      // The target of an import is not a tool.
      const parent = node.parent
      const isModuleSpecifier =
        parent !== undefined && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent))
      if (!isModuleSpecifier) {
        const reason = toolLiteral(node.text)
        if (reason !== null) at(node, reason)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

/** @returns {{file: string, line: number, message: string}[]} */
export function checkOsBoundaries(root = repoRoot) {
  const violations = []
  for (const dir of config.scanDirs) {
    const base = join(root, dir)
    try {
      if (!statSync(base).isDirectory()) continue
    } catch {
      continue
    }
    for (const file of walk(base)) {
      const rel = relative(root, file).split(sep).join('/')
      if (config.gateDirs.some((gate) => inside(rel, gate))) continue
      if (config.exceptions.some((e) => inside(rel, e.path))) continue
      for (const v of checkOsSource(readFileSync(file, 'utf8'), file)) violations.push({ file: rel, ...v })
    }
  }
  return violations
}

/** Those entries in the exception table that point at files that do not actually exist (to check that the table is not out of date). */
export function staleOsExceptions(root = repoRoot) {
  return config.exceptions.filter((e) => {
    try {
      statSync(join(root, e.path))
      return false
    } catch {
      return true
    }
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = checkOsBoundaries()
  const stale = staleOsExceptions()
  if (violations.length > 0 || stale.length > 0) {
    if (violations.length > 0) {
      console.error(`OS の口の外に OS 固有の口が ${violations.length} 件あります (TODO 986、ARCHITECTURE 3.4):`)
      for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.message}`)
      console.error('  → src/common/os/ (hostPlatform / isMac / OS_TOOLS) か src/main/os/ を通す')
    }
    for (const e of stale) console.error(`  例外の表が無いファイルを指している: ${e.path} (scripts/os-boundaries.json)`)
    process.exit(1)
  }
  const deferred = config.exceptions.filter((e) => e.stage === 2).length
  console.log(`lint:os OK — OS 固有の口は src/main/os/・src/common/os/ の中だけ (段 2 で寄せる例外 ${deferred} 件)`)
}
