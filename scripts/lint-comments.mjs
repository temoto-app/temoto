#!/usr/bin/env node
// lint:comments (TODO 1256 stage 2): source comments must not contain Japanese.
//
//   node scripts/lint-comments.mjs [--allow <file>] [paths...]     default: src test plugins scripts tools compat + top-level configs
//
// Uses the same lexers and exclusions as scripts/comments-i18n.mjs (scripts/lib/comments-core.mjs), so string
// literals, regexes, template text, JSX text and test names are never reported - only real comments.
// Kinds: ts / js, css, sh, py, swift (`//` and `/* */`) and html / svg / plist (`<!-- -->`); `\uXXXX` escapes inside a comment count as Japanese.
// Exceptions: scripts/comments-allow.json, a list of { "file": "<repo-relative path>", "includes": "<substring>" }
// ("includes" optional: omit it to allow the whole file). Not part of `npm run lint` yet.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JA, defaultInputs, groupsOf, listFiles } from './lib/comments-core.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const allowIdx = args.indexOf('--allow')
const allowFile = allowIdx >= 0 ? args.splice(allowIdx, 2)[1] : path.join(repoRoot, 'scripts/comments-allow.json')
const allow = JSON.parse(fs.readFileSync(allowFile, 'utf8'))
const inputs = args

// A comment can carry Japanese as escape sequences (backslash-u, braced or not): decode them before testing.
const decodeEscapes = (src) =>
  src.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g, (m, a, b) => {
    const cp = parseInt(a ?? b, 16)
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m
  })
const hasJapanese = (src) => JA.test(src) || JA.test(decodeEscapes(src))

const violations = []
for (const f of listFiles(inputs.length ? inputs : defaultInputs())) {
  const rel = path.relative(process.cwd(), f).split(path.sep).join('/')
  const text = fs.readFileSync(f, 'utf8')
  for (const g of groupsOf(f, text)) {
    const src = text.slice(g.pos, g.end)
    if (!hasJapanese(src)) continue
    if (allow.some((a) => a.file === rel && (a.includes === undefined || src.includes(a.includes)))) continue
    const line = text.slice(0, g.pos).split('\n').length
    const first = src.split('\n').find((l) => hasJapanese(l)) ?? src
    violations.push(`${rel}:${line}: ${first.trim().slice(0, 100)}`)
  }
}
if (violations.length) {
  console.error(`lint:comments: ${violations.length} comment(s) contain Japanese (translate them, or list them in scripts/comments-allow.json):`)
  violations.slice(0, 200).forEach((v) => console.error('  ' + v))
  if (violations.length > 200) console.error(`  ... and ${violations.length - 200} more`)
  process.exit(1)
}
console.log('lint:comments: no Japanese in comments')
