#!/usr/bin/env node
/**
 * The machine check for the completion condition of Phase 4 (IMPLEMENTATION_BRIEF chapter 6, ARCHITECTURE.md chapter 7).
 *
 *   "The standard plugins do not call main's API directly"
 *
 * Specifically, under `plugins/` it checks the following:
 *
 *  1. It does not import `src/main/` (or the renderer / gateway / plugin-host)
 *  2. Privileged modules such as `electron`, `node:fs`, and `node:net` do not appear
 *  3. Forms that could bypass isolation, such as `require(` / `process.parentPort` / `window.aios`, do not appear
 *  4. An import target is either an allowed prefix or an allowed external package
 *
 * The words it checks are written as literals only in `scripts/plugin-boundaries.json` (the same construction as the constraint 6 lint,
 * so that the lint itself does not violate its own rules).
 *
 * The same check is also called from `test/plugin-boundaries.test.ts`, so it fails in both `npm test` and `npm run lint`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const config = JSON.parse(readFileSync(join(repoRoot, 'scripts/plugin-boundaries.json'), 'utf8'))

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/

/** @param {string} fileName */
function scriptKindOf(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.ts')) return ts.ScriptKind.TS
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  return ts.ScriptKind.JS
}

/**
 * Takes only the targets of import / export-from / dynamic import, from the actual syntax tree.
 * A regular expression mistakes `import` / `from` inside comments or string literals for import statements (TODO 695),
 * so it is replaced by TypeScript's parser.
 *
 * @param {string} text
 * @param {string} fileName
 * @returns {{specifier: string, line: number}[]}
 */
function extractImportSpecifiers(text, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKindOf(fileName)
  )
  const results = []
  const push = (specifierNode, pos) => {
    if (!ts.isStringLiteralLike(specifierNode)) return
    const { line } = sourceFile.getLineAndCharacterOfPosition(pos)
    results.push({ specifier: specifierNode.text, line: line + 1 })
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
      push(node.moduleSpecifier, node.getStart(sourceFile))
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      push(node.moduleSpecifier, node.getStart(sourceFile))
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      push(node.moduleReference.expression, node.getStart(sourceFile))
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      push(node.arguments[0], node.getStart(sourceFile))
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      // `typeof import('electron')` / `import('…').T` (an import in a type position).
      // It is a path that depends on main's types even when only types are involved, so it gets the same check as the other imports
      // (code-review, TODO 695).
      push(node.argument.literal, node.getStart(sourceFile))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return results
}

function walk(dir) {
  const found = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) found.push(...walk(full))
    else if (SOURCE_EXT.test(name)) found.push(full)
  }
  return found
}

/** @returns {{file: string, line: number, message: string}[]} */
export function checkPluginBoundaries(root = repoRoot) {
  const violations = []
  for (const dir of config.scanDirs) {
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
      const lines = text.split('\n')

      // Check the import targets
      for (const { specifier, line } of extractImportSpecifiers(text, file)) {
        if (config.forbiddenImports.includes(specifier)) {
          violations.push({ file: rel, line, message: `禁止モジュール: ${specifier}` })
          continue
        }
        // It catches the forms both as a prefix and as a form that appears in the middle of a relative path
        // (`../../src/main/...` is not caught by startsWith).
        if (
          config.forbiddenImportPrefixes.some(
            (p) => specifier.startsWith(p) || specifier.includes(`/${p}`)
          )
        ) {
          violations.push({ file: rel, line, message: `アプリ内部への import: ${specifier}` })
          continue
        }
        // A relative import must **never go outside plugins/**.
        // It blocks the routes that climb with `../` into a directory that is not in the list of prefixes.
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(file), specifier)
          const inside = relative(base, target)
          if (inside.startsWith('..') || isAbsolute(inside)) {
            violations.push({
              file: rel,
              line,
              message: `plugins/ の外への相対 import: ${specifier}`
            })
            continue
          }
        }
        const allowedPrefix = config.allowedImportPrefixes.some((p) => specifier.startsWith(p))
        const allowedBare = config.allowedBarePackages.includes(specifier)
        if (!allowedPrefix && !allowedBare) {
          violations.push({ file: rel, line, message: `許可されていない import: ${specifier}` })
        }
      }

      // Check the forms that could bypass
      for (const pattern of config.forbiddenPatterns) {
        const re = new RegExp(pattern, 'g')
        lines.forEach((text, i) => {
          re.lastIndex = 0
          if (re.test(text)) {
            violations.push({ file: rel, line: i + 1, message: `禁止された形: /${pattern}/` })
          }
        })
      }
    }
  }
  return violations
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = checkPluginBoundaries()
  if (violations.length > 0) {
    console.error(`plugins/ の境界違反が ${violations.length} 件あります (Phase 4 の完了条件):`)
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.message}`)
    process.exit(1)
  }
  console.log('lint:plugins OK — plugins/ から main の API への経路は無し')
}
