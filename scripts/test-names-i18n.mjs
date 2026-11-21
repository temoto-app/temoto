#!/usr/bin/env node
// Translate Japanese test names (the first argument of describe / it / test calls) to English (TODO 1262).
//
//   node scripts/test-names-i18n.mjs extract --out <dir|file.json> [--chunk-items N | --per-file] <dir|file>...
//   node scripts/test-names-i18n.mjs apply   [--dry-run] <translations.json | dir>...
//   node scripts/test-names-i18n.mjs check   [--list] [--json] [--allow <file>] <dir|file>...   (exit 1 while Japanese names or unlisted unextractable names remain)
//   node scripts/test-names-i18n.mjs plan    --bundles N [--out <dir>] <dir|file>...
//
// Same workflow as scripts/comments-i18n.mjs: `extract` writes JSON items (one per distinct name per file); a
// translator fills `en`; `apply` writes the translations back into the exact literals and proves, by re-parsing,
// that nothing but the name literals changed. The model never rewrites a source file.
//
// Safety net (a file that fails any of these is not written, exit code 1):
//   - the token stream with every name literal masked is identical to the original's;
//   - the number of name literals is the same;
//   - every name literal reads back (cooked) as exactly the expected text (the translation, or the original for
//     names that were not translated);
//   - the placeholders (%s %d ... $name ${expr}) of a name are the same list, in the same order, before and after.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listFiles } from './lib/comments-core.mjs'
import { JA, duplicates, embeds, encodeFor, findTargets, japaneseOnlyQuoted, maskedFingerprint } from './lib/test-names-core.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const forbidden = JSON.parse(fs.readFileSync(path.join(repoRoot, 'compat/forbidden-terms.json'), 'utf8'))
const toPosix = (p) => p.split(path.sep).join('/')
const rel = (f) => toPosix(path.relative(process.cwd(), f))

function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

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

const filesOf = (inputs) => listFiles(inputs.length ? inputs : ['test'])
// The key that identifies a name inside a file (the same text in different kinds of literal is the same name).
const keyOf = (t) => (t.kind === 'template-sub' ? 'S:' : 'P:') + t.src

// ---------------------------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------------------------

function itemsOfFile(f) {
  const text = fs.readFileSync(f, 'utf8')
  const { targets } = findTargets(f, text)
  const by = new Map()
  for (const t of targets) {
    if (!JA.test(t.src)) continue
    const k = keyOf(t)
    const prev = by.get(k)
    if (prev) {
      prev.count++
      continue
    }
    const item = { id: `${rel(f)}:${t.start}`, file: rel(f), kind: t.kind, callee: t.callee, quote: t.quote, start: t.start, end: t.end, line: t.line, count: 1 }
    if (t.parents.length) item.parents = t.parents
    item.src = t.src
    item.en = ''
    by.set(k, item)
  }
  return [...by.values()]
}

function cmdExtract(args) {
  const opts = parseFlags(args, { out: 'value', 'per-file': 'bool', 'chunk-items': 'value' })
  if (!opts.out) die('extract: --out <dir|file.json> is required')
  const perFile = filesOf(opts.rest).map((f) => ({ f, items: itemsOfFile(f) })).filter((x) => x.items.length)
  const total = perFile.reduce((a, x) => a + x.items.length, 0)
  if (opts.out.endsWith('.json')) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true })
    fs.writeFileSync(opts.out, JSON.stringify(perFile.flatMap((x) => x.items), null, 1) + '\n')
    console.log(`wrote ${total} items from ${perFile.length} files to ${opts.out}`)
    return
  }
  fs.mkdirSync(opts.out, { recursive: true })
  const chunks = []
  if (opts['per-file']) {
    for (const x of perFile) chunks.push({ name: x.items[0].file.replace(/\//g, '__') + '.json', items: x.items })
  } else {
    const budget = Number(opts['chunk-items'] ?? 150)
    let cur = []
    const flush = () => {
      if (cur.length) chunks.push({ name: String(chunks.length + 1).padStart(4, '0') + '.json', items: cur })
      cur = []
    }
    for (const x of perFile) {
      if (cur.length && cur.length + x.items.length > budget) flush() // keep a file together when it fits
      for (const it of x.items) {
        if (cur.length >= budget) flush()
        cur.push(it)
      }
    }
    flush()
  }
  for (const c of chunks) fs.writeFileSync(path.join(opts.out, c.name), JSON.stringify(c.items, null, 1) + '\n')
  const index = chunks.map((c) => ({ file: c.name, items: c.items.length, sources: new Set(c.items.map((i) => i.file)).size }))
  fs.writeFileSync(path.join(opts.out, 'index.json'), JSON.stringify(index, null, 1) + '\n')
  console.log(`wrote ${total} items from ${perFile.length} files as ${chunks.length} chunk(s) to ${opts.out}/ (index.json lists them)`)
}

// ---------------------------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------------------------

const hasForbiddenChar = (text) => {
  for (const ch of text) {
    const c = ch.codePointAt(0)
    if ((c < 0x20 && c !== 0x09) || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true
  }
  return false
}

function refNumbers(s) {
  const out = new Set()
  for (const m of s.matchAll(/(?:TODO|項目|item|ARCHITECTURE|制約|constraint)[ \t]*#?[ \t]*(\d[\d.-]*\d|\d)/g)) out.add(m[1])
  return [...out]
}

/** Returns an error string, or null when `en` is an acceptable replacement for the name `t`. */
function checkTranslation(relPath, t, item) {
  const en = item.en
  if (typeof en !== 'string') return 'en must be a string (a test name cannot be deleted)'
  if (hasForbiddenChar(en)) return 'contains a control character or a line separator'
  if (en.trim() !== en) return 'leading or trailing whitespace'
  const src = t.src
  const a = embeds(src)
  const b = embeds(en)
  if (JSON.stringify(a) !== JSON.stringify(b)) return `placeholders changed: ${JSON.stringify(a)} -> ${JSON.stringify(b)} (keep %s / %d / $name / \${expr} as they are, in the same order)`
  if (!forbidden.allowedPaths.some((p) => relPath.startsWith(p))) {
    for (const term of forbidden.terms) {
      const re = new RegExp(term, 'i')
      if (re.test(en) && !re.test(src)) return `contains the backend term /${term}/ (constraint 6: write "the CLI" instead)`
    }
  }
  if (!item.loose) for (const n of refNumbers(src)) if (!en.includes(n)) return `reference number ${n} is missing ("loose": true to skip this check)`
  return null
}

function loadItems(inputs) {
  const files = []
  for (const i of inputs) {
    if (!fs.existsSync(i)) die(`no such file: ${i}`)
    if (fs.statSync(i).isDirectory()) fs.readdirSync(i).filter((n) => n.endsWith('.json') && n !== 'index.json').sort().forEach((n) => files.push(path.join(i, n)))
    else files.push(i)
  }
  return files.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
}

/** Applies the items of one file. Returns { text|null, stats, errors, warnings }. */
function applyToFile(file, items) {
  const stats = { replaced: 0, pending: 0, alreadyDone: 0, stale: 0, itemErrors: 0 }
  const errors = []
  const warnings = []
  const original = fs.readFileSync(file, 'utf8')
  const { targets, calls } = findTargets(file, original)
  const r = rel(file)
  const byKey = new Map()
  for (const t of targets) {
    const k = keyOf(t)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(t)
  }
  const edits = [] // { target, text, en }
  const seen = new Set()
  for (const item of items) {
    if (typeof item.src !== 'string') {
      stats.itemErrors++
      errors.push(`${r}: item without src`)
      continue
    }
    const k = (item.kind === 'template-sub' ? 'S:' : 'P:') + item.src
    if (seen.has(k)) continue // the same item in two chunk files: the first one wins
    seen.add(k)
    if (item.en === '' || item.en === undefined) {
      stats.pending++
      continue
    }
    const ts = byKey.get(k)
    if (!ts) {
      // Already applied (a current name equals the translation) or the source changed since extract.
      const done = typeof item.en === 'string' && targets.some((t) => t.src === item.en)
      if (done) stats.alreadyDone++
      else stats.stale++
      continue
    }
    // One spelling per target: the same name may be written as a string and as a template (or with ' and ") in one file.
    let failed = false
    const encoded = []
    for (const t of ts) {
      const bad = checkTranslation(r, t, item)
      const enc = bad ? null : encodeFor(t, item.en)
      const problem = bad || enc.error
      if (problem) {
        stats.itemErrors++
        errors.push(`${r}:${t.line}: ${JSON.stringify(item.src)}: ${problem}`)
        failed = true
        break
      }
      encoded.push({ target: t, text: enc.text, en: item.en })
    }
    if (failed) continue
    if (JA.test(item.en) && !japaneseOnlyQuoted(item.en)) warnings.push(`${r}:${ts[0].line}: Japanese remains: ${JSON.stringify(item.en)}`)
    edits.push(...encoded)
    stats.replaced += 1
  }
  if (!edits.length) return { text: null, stats, errors, warnings }
  if (errors.length) return { text: null, stats, errors, warnings }
  // Splice from the end so earlier offsets stay valid.
  edits.sort((x, y) => y.target.start - x.target.start)
  let text = original
  for (const e of edits) text = text.slice(0, e.target.start) + e.text + text.slice(e.target.end)
  // Verify by re-parsing.
  const before = maskedFingerprint(file, original)
  const after = maskedFingerprint(file, text)
  const expected = new Map(edits.map((e) => [e.target.start, e.en]))
  if (before.count !== after.count) errors.push(`${r}: the number of name literals changed (${before.count} -> ${after.count})`)
  else if (before.fp !== after.fp) errors.push(`${r}: tokens other than the name literals changed`)
  else {
    // Every literal must read back as expected (in order).
    const orig = findTargets(file, original).targets
    const want = orig.map((t) => expected.get(t.start) ?? t.src)
    after.srcs.forEach((s, i) => {
      if (s !== want[i]) errors.push(`${r}:${orig[i].line}: the literal reads back as ${JSON.stringify(s)}, expected ${JSON.stringify(want[i])}`)
    })
  }
  if (errors.length) return { text: null, stats, errors, warnings }
  // Duplicate names that the translation introduced (same scope, same kind): report, do not refuse.
  const dupBefore = duplicates(calls)
  const dupAfter = duplicates(findTargets(file, text).calls)
  const introduced = [...dupAfter].filter(([k, n]) => n > (dupBefore.get(k) ?? 0))
  for (const [k] of introduced) warnings.push(`${r}: duplicate name after translation: ${JSON.stringify(k.split('|').slice(2).join('|'))}`)
  return { text, stats, errors, warnings }
}

function cmdApply(args) {
  const opts = parseFlags(args, { 'dry-run': 'bool' })
  if (!opts.rest.length) die('apply: give a translations .json or a directory of them')
  const items = loadItems(opts.rest)
  const byFile = new Map()
  for (const it of items) {
    if (typeof it.file !== 'string') continue
    if (!byFile.has(it.file)) byFile.set(it.file, [])
    byFile.get(it.file).push(it)
  }
  const total = { replaced: 0, pending: 0, alreadyDone: 0, stale: 0, itemErrors: 0, filesWritten: 0, filesSkipped: 0 }
  const warnings = []
  let failed = false
  for (const [file, its] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    const abs = path.resolve(file)
    if (!fs.existsSync(abs)) {
      total.stale += its.length
      continue
    }
    const res = applyToFile(abs, its)
    for (const k of ['replaced', 'pending', 'alreadyDone', 'stale', 'itemErrors']) total[k] += res.stats[k]
    warnings.push(...res.warnings)
    res.errors.forEach((e) => console.error(e))
    if (res.errors.length) {
      failed = true
      total.filesSkipped++
      continue
    }
    if (res.text !== null && !opts['dry-run']) {
      writeAtomic(abs, res.text)
      total.filesWritten++
    }
  }
  warnings.forEach((w) => console.error('warning: ' + w))
  console.log(JSON.stringify({ ...total, warnings: warnings.length, dryRun: !!opts['dry-run'] }))
  if (failed) process.exit(1)
}

// ---------------------------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------------------------

function cmdCheck(args) {
  const opts = parseFlags(args, { list: 'bool', json: 'bool', allow: 'value' })
  // TODO 1285: names the tool cannot extract (each-tables whose Japanese is test data, not a name) must be listed in the allow file,
  // otherwise `check` fails on them too. Entries: { file, category?, includes?, reason } - `includes` is matched against the call's first 100 chars.
  const allowFile = opts.allow ?? path.join(repoRoot, 'scripts/test-names-allow.json')
  const allow = fs.existsSync(allowFile) ? JSON.parse(fs.readFileSync(allowFile, 'utf8')) : []
  const isAllowed = (file, u) => allow.some((a) => a.file === file && (a.category === undefined || a.category === u.category) && (a.includes === undefined || u.example.includes(a.includes)))
  const rows = []
  const total = { files: 0, remaining: 0, quotedOnly: 0, unpicked: 0 }
  for (const f of filesOf(opts.rest)) {
    const { targets, unpicked } = findTargets(f, fs.readFileSync(f, 'utf8'))
    const ja = targets.filter((t) => JA.test(t.src))
    const quoted = ja.filter((t) => japaneseOnlyQuoted(t.src))
    const unp = unpicked.filter((u) => u.count > 0 && !isAllowed(rel(f), u))
    if (!ja.length && !unp.length) continue
    rows.push({ file: rel(f), remaining: ja.length - quoted.length, quotedOnly: quoted.length, unpicked: unp.length, lines: opts.list ? [...ja.filter((t) => !japaneseOnlyQuoted(t.src)).map((t) => `${t.line}: ${t.src}`), ...unp.map((u) => `${u.line}: [not extractable, ${u.category}] ${u.example.split('\n')[0]}`)] : undefined })
    total.files++
    total.remaining += ja.length - quoted.length
    total.quotedOnly += quoted.length
    total.unpicked += unp.length
  }
  if (opts.json) console.log(JSON.stringify({ total, rows }, null, 1))
  else {
    for (const r of rows) {
      // Files with nothing left to fix are only listed with --list (keeps `npm run lint` quiet).
      if (!opts.list && !r.remaining && !r.unpicked) continue
      console.log(`${String(r.remaining).padStart(5)}  ${r.file}${r.quotedOnly ? `  (+${r.quotedOnly} quoted-only)` : ''}${r.unpicked ? `  (+${r.unpicked} not extractable)` : ''}`)
      r.lines?.forEach((l) => console.log('         ' + l))
    }
    console.log(`\nremaining Japanese test names: ${total.remaining} in ${total.files} file(s); quoted-only (allowed): ${total.quotedOnly}; names the tool cannot extract and the allow file does not list (tables, concatenations): ${total.unpicked}`)
  }
  if (total.remaining > 0 || total.unpicked > 0) process.exit(1)
}

// ---------------------------------------------------------------------------------------------
// plan: split the files into N bundles of about the same number of names (file units, name order)
// ---------------------------------------------------------------------------------------------

function cmdPlan(args) {
  const opts = parseFlags(args, { bundles: 'value', out: 'value' })
  const n = Number(opts.bundles)
  if (!n || n < 1) die('plan: --bundles N is required')
  const rows = []
  for (const f of filesOf(opts.rest)) {
    const c = itemsOfFile(f).length
    if (c) rows.push({ file: rel(f), items: c })
  }
  rows.sort((a, b) => a.file.localeCompare(b.file))
  const total = rows.reduce((a, r) => a + r.items, 0)
  const target = total / n
  const bundles = [[]]
  let acc = 0
  for (const r of rows) {
    const cur = bundles[bundles.length - 1]
    const sum = cur.reduce((a, x) => a + x.items, 0)
    // Close the bundle when adding the file would overshoot the target by more than leaving it short does.
    if (cur.length && bundles.length < n && sum + r.items / 2 > target) bundles.push([])
    bundles[bundles.length - 1].push(r)
    acc += r.items
  }
  bundles.forEach((b, i) => {
    const sum = b.reduce((a, x) => a + x.items, 0)
    console.log(`bundle ${String.fromCharCode(65 + i)}: ${sum} names, ${b.length} files (${b[0].file} .. ${b[b.length - 1].file})`)
  })
  console.log(`total ${acc} names in ${rows.length} files`)
  if (opts.out) {
    fs.mkdirSync(opts.out, { recursive: true })
    bundles.forEach((b, i) => fs.writeFileSync(path.join(opts.out, `bundle-${String.fromCharCode(65 + i)}.txt`), b.map((x) => x.file).join('\n') + '\n'))
    console.log(`wrote ${bundles.length} file lists to ${opts.out}/ (one path per line; pass them to extract as arguments)`)
  }
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'extract') cmdExtract(rest)
else if (cmd === 'apply') cmdApply(rest)
else if (cmd === 'check') cmdCheck(rest)
else if (cmd === 'plan') cmdPlan(rest)
else die('usage: extract --out <dir|file.json> [--chunk-items N|--per-file] [paths] | apply [--dry-run] <json|dir>... | check [--list] [--json] [--allow file] [paths] | plan --bundles N [--out dir] [paths]')
