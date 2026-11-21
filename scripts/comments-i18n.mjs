#!/usr/bin/env node
// Translate Japanese source comments to English (or delete them) without touching code (TODO 1256).
//
//   node scripts/comments-i18n.mjs stats   [--depth N] [--json] [--list-directives] [paths...]
//   node scripts/comments-i18n.mjs extract --out <dir|file.json> [--per-file | --chunk-chars N] [paths...]
//   node scripts/comments-i18n.mjs apply   [--dry-run] <translations.json | dir>...
//
// Workflow: `extract` writes JSON items (one per distinct Japanese comment per file, with the code that
// follows it); a translator fills `en` in each item (a string = translation, null = delete, "" or missing =
// not done yet); `apply` writes the translations back at the exact comment positions and verifies that
// nothing but comments changed. Items are matched by (file, src), not by offset, so partial JSON files can
// be applied in any order and re-applying is a no-op (idempotent).
//
// Safety net: after the edits of a file, its comment-free fingerprint must equal the original's (see
// scripts/lib/comments-core.mjs). If not, that file is not written and the exit code is 1.
// Languages: ts/tsx/js/mjs..., css, sh, py. Others are only counted by `stats`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  JA,
  defaultInputs,
  describeGroup,
  directiveLines,
  directivePrefix,
  fingerprint,
  groupsOf,
  hash8,
  isDirective,
  LINE_BREAK,
  langOf,
  linePrefixOf,
  listFiles,
  syntaxProblem,
} from './lib/comments-core.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const forbidden = JSON.parse(fs.readFileSync(path.join(repoRoot, 'compat/forbidden-terms.json'), 'utf8'))
const toPosix = (p) => p.split(path.sep).join('/')

function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

// ---------------------------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------------------------

function cmdStats(args) {
  const opts = parseFlags(args, { depth: 'value', json: 'bool', 'list-directives': 'bool' })
  const depth = Number(opts.depth ?? 2)
  const inputs = opts.rest.length ? opts.rest : defaultInputs()
  const rows = new Map()
  const row = (key) => {
    if (!rows.has(key)) rows.set(key, { dir: key, files: 0, filesJa: 0, groups: 0, lines: 0, chars: 0, directives: 0, jaOutsideLines: 0 })
    return rows.get(key)
  }
  const directives = []
  for (const f of listFiles(inputs)) {
    const text = fs.readFileSync(f, 'utf8')
    const rel = toPosix(path.relative(process.cwd(), f))
    const segs = rel.split('/').slice(0, -1).slice(0, depth)
    const r = row(segs.length ? segs.join('/') : '.')
    r.files++
    const gs = groupsOf(f, text)
    const ja = gs.filter((g) => JA.test(text.slice(g.pos, g.end)))
    if (ja.length) r.filesJa++
    for (const g of ja) {
      const src = text.slice(g.pos, g.end)
      if (g.directive) {
        r.directives++
        directives.push(`${rel}:${lineOf(text, g.pos)}  ${src.split('\n')[0].slice(0, 120)}`)
        continue
      }
      r.groups++
      r.lines += src.split('\n').length
      r.chars += src.length
    }
    // Japanese that is NOT in a comment (UI strings, regexes, test data): never touched.
    const masked = gs.reduce((t, g) => t.slice(0, g.pos) + ' '.repeat(g.end - g.pos) + t.slice(g.end), text)
    r.jaOutsideLines += masked.split('\n').filter((l) => JA.test(l)).length
  }
  const unsupported = {}
  for (const f of listFiles(inputs, 'unsupported')) {
    if (!JA.test(fs.readFileSync(f, 'utf8'))) continue
    const ext = path.extname(f)
    unsupported[ext] ??= []
    unsupported[ext].push(toPosix(path.relative(process.cwd(), f)))
  }
  const list = [...rows.values()].sort((a, b) => a.dir.localeCompare(b.dir))
  const total = list.reduce(
    (a, r) => ({ ...a, files: a.files + r.files, filesJa: a.filesJa + r.filesJa, groups: a.groups + r.groups, lines: a.lines + r.lines, chars: a.chars + r.chars, directives: a.directives + r.directives, jaOutsideLines: a.jaOutsideLines + r.jaOutsideLines }),
    { dir: 'TOTAL', files: 0, filesJa: 0, groups: 0, lines: 0, chars: 0, directives: 0, jaOutsideLines: 0 },
  )
  if (opts.json) {
    console.log(JSON.stringify({ rows: list, total, unsupportedFilesWithJa: unsupported, directivesWithJa: opts['list-directives'] ? directives : directives.length }, null, 2))
    return
  }
  const cols = ['dir', 'files', 'filesJa', 'groups', 'lines', 'chars', 'directives', 'jaOutsideLines']
  const all = [...list, total]
  const width = (c) => Math.max(c.length, ...all.map((r) => String(r[c]).length))
  const fmt = (r) => cols.map((c, i) => (i === 0 ? String(r[c]).padEnd(width(c)) : String(r[c]).padStart(width(c)))).join('  ')
  console.log(fmt(Object.fromEntries(cols.map((c) => [c, c]))))
  all.forEach((r) => console.log(fmt(r)))
  console.log('\n(groups = Japanese comment units still to do, directives excluded; jaOutsideLines = lines with Japanese outside comments, never touched)')
  for (const [ext, files] of Object.entries(unsupported)) console.log(`unsupported ${ext}: ${files.length} file(s) with Japanese: ${files.join(', ')}`)
  if (opts['list-directives']) {
    console.log(`\ndirective comments with Japanese (${directives.length}); extracted with fixedPrefix:`)
    directives.forEach((d) => console.log('  ' + d))
  } else if (directives.length) console.log(`directive comments with Japanese: ${directives.length} (--list-directives to show)`)
}

function lineOf(text, pos) {
  return text.slice(0, pos).split('\n').length
}

// ---------------------------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------------------------

function itemsOfFile(f) {
  const text = fs.readFileSync(f, 'utf8')
  const rel = toPosix(path.relative(process.cwd(), f))
  const bySrc = new Map()
  for (const g of groupsOf(f, text)) {
    const src = text.slice(g.pos, g.end)
    if (!JA.test(src)) continue
    const prev = bySrc.get(src)
    if (prev) {
      prev.count++
      continue
    }
    const d = describeGroup(text, g)
    const item = { id: `${rel}#${hash8(src)}`, file: rel, kind: d.kind, line: lineOf(text, g.pos), count: 1, src }
    if (d.codeBefore) item.codeBefore = d.codeBefore
    item.next = d.next
    if (g.directive) item.fixedPrefix = directivePrefix(src)
    item.en = ''
    bySrc.set(src, item)
  }
  return [...bySrc.values()]
}

function cmdExtract(args) {
  const opts = parseFlags(args, { out: 'value', 'per-file': 'bool', 'chunk-chars': 'value' })
  if (!opts.out) die('extract: --out <dir|file.json> is required')
  const inputs = opts.rest.length ? opts.rest : defaultInputs()
  const perFile = listFiles(inputs).map((f) => ({ f, items: itemsOfFile(f) })).filter((x) => x.items.length)
  const total = perFile.reduce((a, x) => a + x.items.length, 0)
  if (opts.out.endsWith('.json')) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true })
    fs.writeFileSync(opts.out, JSON.stringify(perFile.flatMap((x) => x.items), null, 1) + '\n')
    console.log(`wrote ${total} items from ${perFile.length} files to ${opts.out}`)
    return
  }
  fs.mkdirSync(opts.out, { recursive: true })
  const chunks = [] // [{name, items}]
  if (opts['per-file']) {
    for (const x of perFile) chunks.push({ name: x.items[0].file.replace(/\//g, '__') + '.json', items: x.items })
  } else {
    const budget = Number(opts['chunk-chars'] ?? 12000)
    let cur = []
    let chars = 0
    const flush = () => {
      if (cur.length) chunks.push({ name: String(chunks.length + 1).padStart(4, '0') + '.json', items: cur })
      cur = []
      chars = 0
    }
    for (const x of perFile) {
      const size = x.items.reduce((a, i) => a + i.src.length, 0)
      if (cur.length && chars + size > budget) flush() // keep a file together when it fits
      for (const it of x.items) {
        if (cur.length && chars + it.src.length > budget) flush()
        cur.push(it)
        chars += it.src.length
      }
    }
    flush()
  }
  for (const c of chunks) fs.writeFileSync(path.join(opts.out, c.name), JSON.stringify(c.items, null, 1) + '\n')
  const index = chunks.map((c) => ({ file: c.name, items: c.items.length, chars: c.items.reduce((a, i) => a + i.src.length, 0), sources: [...new Set(c.items.map((i) => i.file))].length }))
  fs.writeFileSync(path.join(opts.out, 'index.json'), JSON.stringify(index, null, 1) + '\n')
  console.log(`wrote ${total} items from ${perFile.length} files as ${chunks.length} chunk(s) to ${opts.out}/ (index.json lists them)`)
}

// ---------------------------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------------------------

const lines = (s) => s.split('\n')

function tagList(s) {
  const out = []
  for (const m of s.matchAll(/(?:^|\n)[ \t]*\*?[ \t]*@(\w+)((?:[ \t]+\{[^}\n]*\})?[ \t]+\[?([\w.$:-]+)\]?)?/g)) {
    const named = /^(param|arg|argument|property|prop|template|typedef|callback)$/.test(m[1])
    out.push(m[1] + (named && m[3] ? ' ' + m[3] : ''))
  }
  return out
}
const linkList = (s) => [...s.matchAll(/\{@link\w*\s+([^\s|}]+)/g)].map((m) => m[1]).sort()

function spans(s) {
  const m = new Map()
  for (const x of s.matchAll(/`([^`\n]+)`/g)) {
    if (JA.test(x[1])) continue
    m.set(x[1], (m.get(x[1]) ?? 0) + 1)
  }
  return m
}

function refNumbers(s) {
  const out = new Set()
  for (const m of s.matchAll(/(?:TODO|項目|item|ARCHITECTURE|制約|constraint)[ \t]*#?[ \t]*(\d[\d.-]*\d|\d)/g)) out.add(m[1])
  for (const m of s.matchAll(/\d+\.\d+(?:\.\d+)*/g)) out.add(m[0])
  return [...out]
}

// Anything but a tab and a line feed: other line terminators (CR, U+2028, U+2029, U+0085) would end a line comment
// early so that the rest of the translation is read as code, and NUL and friends have no place in a comment.
const hasForbiddenChar = (text) => {
  for (const ch of text) {
    const c = ch.codePointAt(0)
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true
  }
  return false
}

/**
 * A directive comment keeps its tool-facing part verbatim. Everything is computed from the original `src` (never from
 * the translation JSON): the fixed prefix, and for each directive line its head (rule names, `@ts-expect-error`...).
 * The translation may only change the free text after the head. Returns an error string or null.
 */
function checkDirective(lang, src, en) {
  const prefix = directivePrefix(src)
  if (!en.startsWith(prefix)) return `directive comment: the text must start with the fixed prefix ${JSON.stringify(prefix)}`
  const a = directiveLines(src, lang)
  const b = directiveLines(en, lang)
  if (a.length === 0) {
    // Whole-comment directives (shebang, legal /*! */, triple-slash): same shape, and no directive line appears.
    if (b.length > 0) return 'the translation adds a directive line'
    if (src.split(LINE_BREAK).length !== en.split(LINE_BREAK).length) return 'a directive comment must keep its number of lines'
    return null
  }
  if (a.length !== b.length) return `the translation has ${b.length} directive line(s), the original has ${a.length}`
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (!x.ja) {
      if (x.body !== y.body) return `directive line changed: ${JSON.stringify(x.body)}`
      continue
    }
    // Without a ` -- ` separator there is no boundary between the directive's own words (rule names...) and the
    // free text, so a translation could add to the directive. Such lines are not translated by this tool.
    if (!x.sep) return 'directive line without a " -- " separator: leave this item untranslated (en: "") and report it'
    const tail = y.body.startsWith(x.head) ? y.body.slice(x.head.length) : null
    const ok = tail !== null && /^\s+--(\s|$)/.test(tail)
    if (!ok) return `directive line must keep ${JSON.stringify(x.head + (x.sep ? ' --' : ''))} and change only the text after it`
  }
  return null
}

/** Returns an error string, or null when `en` is an acceptable replacement for the comment `src`. */
function checkTranslation(rel, lang, g, src, item) {
  const en = item.en
  if (typeof en !== 'string' || typeof src !== 'string') return 'en and src must be strings'
  if (/\r/.test(en)) return 'contains a carriage return'
  if (hasForbiddenChar(en)) return 'contains a control character or a line separator (only tab and line feed are allowed)'
  if (JA.test(en) && !item.keepJa) return 'Japanese remains (use ASCII punctuation; set "keepJa": true only for a quoted UI string)'
  const allowedPath = forbidden.allowedPaths.some((p) => rel.startsWith(p))
  if (!allowedPath) {
    for (const t of forbidden.terms) {
      const re = new RegExp(t, 'i')
      if (re.test(en) && !re.test(src)) return `contains the backend term /${t}/ (constraint 6: write "the CLI" instead)`
    }
  }
  // A translation must never turn an ordinary comment into a tool directive (eslint-disable, @ts-nocheck, a Python
  // coding declaration, a shebang...): the token stream would be unchanged, but the tools would read the file differently.
  if (!g.directive) {
    const becomesDirective = isDirective(en, lang) || en.split(LINE_BREAK).some((l) => isDirective(l.trim(), lang))
    if (becomesDirective) return 'the translation reads as a tool directive (reword it so it does not start like one)'
    if (lang === 'py' && /coding[:=]/.test(en) && !/coding[:=]/.test(src)) return 'the translation must not contain a Python coding declaration'
  }
  if (g.directive) {
    const bad = checkDirective(lang, src, en)
    if (bad) return bad
  }
  const enLines = lines(en)
  if (g.block) {
    const opener = (s) => /^\/\*[*!]?/.exec(s)?.[0] ?? null
    if (opener(en) === null || opener(en) !== opener(src)) return `block comment must open with ${opener(src)}`
    if (!en.endsWith('*/') || en.indexOf('*/') !== en.length - 2) return 'block comment must end with exactly one */ (and contain no other */)'
    if (!g.standalone && enLines.length > 1 && !src.includes('\n')) return 'a single-line inline block comment must stay on one line'
    const srcLines = lines(src)
    const starStyle = srcLines.length > 1 ? srcLines.slice(1).every((l) => /^[ \t]*\*/.test(l)) : true
    if (enLines.length > 1 && starStyle && !enLines.slice(1).every((l) => /^[ \t]*\*/.test(l))) return 'every line after the first must start with * (JSDoc style)'
  } else {
    const prefix = linePrefixOf(rel)
    if (!prefix) return 'line comments are not valid in this language'
    if (!enLines.every((l) => l.trim().startsWith(prefix))) return `every line must be a ${prefix} comment`
    if (src.startsWith('///') && !en.startsWith('///')) return 'a /// comment must stay a /// comment'
    if (!g.standalone && enLines.length > 1) return 'a trailing comment must stay on one line'
  }
  if (!item.loose) {
    if (g.block) {
      if (JSON.stringify(tagList(src)) !== JSON.stringify(tagList(en))) return `JSDoc tags changed: ${JSON.stringify(tagList(src))} -> ${JSON.stringify(tagList(en))} (keep @tag names, order and @param names)`
      if (JSON.stringify(linkList(src)) !== JSON.stringify(linkList(en))) return '{@link ...} targets changed'
    }
    const a = spans(src)
    const b = spans(en)
    for (const [k, v] of a) if ((b.get(k) ?? 0) < v) return `code span \`${k}\` must be kept as is`
    for (const n of refNumbers(src)) if (!en.includes(n)) return `reference number ${n} is missing (TODO / item / ARCHITECTURE numbers must be kept; "loose": true to skip this check)`
  }
  return null
}

/** Re-indent the translation to the comment's own indent so translators need not care. */
function normalize(en, g, src) {
  const ls = lines(en)
  if (ls.length === 1) return en.trim()
  if (g.block) {
    const star = lines(src).slice(1).every((l) => /^[ \t]*\*/.test(l))
    if (!star) return en
    return ls.map((l, i) => (i === 0 ? l.trimEnd() : g.indent + ' ' + l.trim())).join('\n')
  }
  return ls.map((l, i) => (i === 0 ? l.trim() : g.indent + l.trim())).join('\n')
}

function deleteGroup(text, g) {
  const ls = text.lastIndexOf('\n', g.pos - 1) + 1
  let le = text.indexOf('\n', g.end)
  if (le < 0) le = text.length
  const before = text.slice(ls, g.pos)
  const after = text.slice(g.end, le)
  if (before.trim() === '' && after.trim() === '') {
    let end = Math.min(le + 1, text.length)
    // Do not leave a double blank line (or a blank line right after an opening bracket).
    const prevStart = ls === 0 ? 0 : text.lastIndexOf('\n', ls - 2) + 1
    const prevLine = text.slice(prevStart, Math.max(ls - 1, 0))
    const prevBlankOrOpen = ls === 0 || prevLine.trim() === '' || /[{([]\s*$/.test(prevLine)
    const nextEnd = text.indexOf('\n', end)
    const nextLine = text.slice(end, nextEnd < 0 ? text.length : nextEnd)
    if (prevBlankOrOpen && end < text.length && nextLine.trim() === '') end = nextEnd < 0 ? text.length : nextEnd + 1
    return text.slice(0, ls) + text.slice(end)
  }
  let head = text.slice(0, g.pos)
  let tail = text.slice(g.end)
  if (after.trim() === '') {
    head = head.replace(/[ \t]+$/, '')
    tail = tail.replace(/^[ \t]+(?=\n|$)/, '')
  } else {
    const L = head.slice(-1)
    if (/[\s([{]/.test(L)) tail = tail.replace(/^[ \t]+/, '')
    else if (/^\S/.test(tail)) tail = ' ' + tail
  }
  return head + tail
}

function loadItems(inputs) {
  const files = []
  for (const p of inputs) {
    if (fs.statSync(p).isDirectory()) fs.readdirSync(p).filter((n) => n.endsWith('.json') && n !== 'index.json').sort().forEach((n) => files.push(path.join(p, n)))
    else files.push(p)
  }
  const items = []
  const problems = []
  for (const f of files) {
    let list
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'))
      list = Array.isArray(data) ? data : data?.items
      if (!Array.isArray(list)) throw new Error('expected an array of items (or {"items": [...]})')
    } catch (e) {
      problems.push(`ERROR ${f}: cannot read the translation file: ${e.message}`)
      continue
    }
    list.forEach((it, n) => {
      // One malformed item must not stop the others: it is reported and left out.
      if (it === null || typeof it !== 'object' || Array.isArray(it) || typeof it.file !== 'string' || typeof it.src !== 'string') {
        problems.push(`ERROR ${f}[${n}]: an item needs string "file" and "src"`)
        return
      }
      items.push({ ...it, _from: f })
    })
  }
  return { items, problems }
}

function cmdApply(args) {
  const opts = parseFlags(args, { 'dry-run': 'bool' })
  if (!opts.rest.length) die('apply: give one or more translation JSON files or directories')
  const byFile = new Map()
  const loaded = loadItems(opts.rest)
  for (const it of loaded.items) {
    if (!byFile.has(it.file)) byFile.set(it.file, new Map())
    byFile.get(it.file).set(it.src, it) // later wins
  }
  const stat = { filesWritten: 0, filesSkipped: 0, replaced: 0, deleted: 0, pending: 0, alreadyDone: 0, stale: 0, itemErrors: loaded.problems.length }
  const report = [...loaded.problems]
  // Item paths come from JSON an agent wrote: only files the default scan would list, under the directory the tool
  // runs in (the repository root), are written. Absolute paths and `..` are refused.
  const root = path.resolve(process.cwd())
  const writable = new Set(listFiles(defaultInputs()).map((p) => path.resolve(p)))
  for (const [rel, map] of byFile) {
    const f = path.resolve(root, String(rel))
    const inside = typeof rel === 'string' && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..') && f.startsWith(root + path.sep)
    if (!inside || !writable.has(f)) {
      report.push(`SKIP ${rel}: not a file this tool may write (outside the repository or the scan set)`)
      stat.filesSkipped++
      continue
    }
    if (!fs.existsSync(f) || !langOf(f)) {
      report.push(`SKIP ${rel}: not a supported file`)
      stat.filesSkipped++
      continue
    }
    // swift and xml (html / svg / plist) are lint-only: their fingerprint comes from the same hand-written lexer that finds
    // the comments, so it cannot catch a mis-lexed comment (a regex literal, `<!--` inside a script or CDATA). Never write them.
    if (langOf(f) === 'swift' || langOf(f) === 'xml') {
      report.push(`SKIP ${rel}: ${langOf(f)} files are checked by the lint only and are edited by hand`)
      stat.filesSkipped++
      continue
    }
    const text = fs.readFileSync(f, 'utf8')
    if (text.includes('\r')) {
      report.push(`SKIP ${rel}: CRLF files are not supported`)
      stat.filesSkipped++
      continue
    }
    const lang = langOf(f)
    const edits = []
    const used = new Set()
    for (const g of groupsOf(f, text)) {
      const src = text.slice(g.pos, g.end)
      const item = map.get(src)
      if (!item || !JA.test(src)) continue
      used.add(src)
      if (item.en === undefined || item.en === '') {
        stat.pending++
        continue
      }
      if (item.en === null) {
        if (g.directive) {
          report.push(`ERROR ${rel}:${lineOf(text, g.pos)}: a directive comment cannot be deleted; translate the explanation instead`)
          stat.itemErrors++
          continue
        }
        const ls = text.lastIndexOf('\n', g.pos - 1) + 1
        if (text.slice(ls, g.pos).trimEnd().endsWith('{') && text.slice(g.end).trimStart().startsWith('}')) {
          report.push(`ERROR ${rel}:${lineOf(text, g.pos)}: cannot delete a comment that is the only content of { } (JSX comment slot); translate it`)
          stat.itemErrors++
          continue
        }
        edits.push({ g, del: true })
        continue
      }
      if (typeof item.en !== 'string') {
        report.push(`ERROR ${rel}:${lineOf(text, g.pos)}: en must be a string, null (delete) or ""`)
        stat.itemErrors++
        continue
      }
      let why
      try {
        why = checkTranslation(rel, lang, g, src, item)
      } catch (e) {
        why = `the check itself failed (${e.message})`
      }
      if (why) {
        report.push(`ERROR ${rel}:${lineOf(text, g.pos)}: ${why}\n    src: ${src.split('\n')[0].slice(0, 100)}`)
        stat.itemErrors++
        continue
      }
      edits.push({ g, en: normalize(item.en, g, src) })
    }
    for (const [src, item] of map) {
      if (used.has(src)) continue
      // Not found: already translated (idempotent re-run) or the file changed since extract.
      if (typeof item.en === 'string' && item.en !== '' && text.includes(item.en.split('\n')[0].trim())) stat.alreadyDone++
      else if (item.en === null || item.en === '' || item.en === undefined) {
        if (item.en === null) stat.alreadyDone++ // a deletion that already happened (or never matches): nothing to do
        else stat.pending++
      } else {
        stat.stale++
        report.push(`STALE ${rel}: comment not found any more: ${src.split('\n')[0].slice(0, 80)}`)
      }
    }
    if (!edits.length) continue
    let next = text
    for (const e of edits.sort((a, b) => b.g.pos - a.g.pos)) {
      next = e.del ? deleteGroup(next, e.g) : next.slice(0, e.g.pos) + e.en + next.slice(e.g.end)
    }
    let problem = null
    try {
      if (fingerprint(f, text) !== fingerprint(f, next)) problem = 'non-comment tokens changed (verification failed)'
      else {
        const before = syntaxProblem(f, text)
        const after = syntaxProblem(f, next)
        if (after && !before) problem = `syntax check failed after edit: ${after}`
      }
    } catch (e) {
      problem = `verification crashed: ${e.message}`
    }
    if (problem) {
      report.push(`SKIP ${rel}: ${problem}`)
      stat.filesSkipped++
      continue
    }
    if (!opts['dry-run']) writeAtomic(f, next)
    stat.filesWritten++
    stat.replaced += edits.filter((e) => !e.del).length
    stat.deleted += edits.filter((e) => e.del).length
  }
  report.forEach((l) => console.error(l))
  console.log(JSON.stringify(stat))
  if (stat.filesSkipped || stat.itemErrors) process.exitCode = 1
}

// ---------------------------------------------------------------------------------------------

function parseFlags(args, spec) {
  const out = { rest: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      if (!spec[k]) die(`unknown option ${a}`)
      out[k] = spec[k] === 'value' ? args[++i] : true
    } else out.rest.push(a)
  }
  return out
}

function die(msg) {
  console.error(msg)
  process.exit(2)
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'stats') cmdStats(rest)
else if (cmd === 'extract') cmdExtract(rest)
else if (cmd === 'apply') cmdApply(rest)
else die('usage: stats [--depth N] [--json] [--list-directives] [paths] | extract --out <dir|file.json> [--per-file|--chunk-chars N] [paths] | apply [--dry-run] <json|dir>...')
