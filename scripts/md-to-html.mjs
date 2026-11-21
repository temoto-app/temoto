#!/usr/bin/env node
// Render a Markdown note as one self-contained HTML file (no external assets).
// The .md stays the canonical copy; the .html is a generated reading view.
//
// usage: node scripts/md-to-html.mjs <in.md> [out.html]
//
// Supported subset: # / ## / ### headings, paragraphs, "- " lists (with indented
// continuation lines), pipe tables, fenced code, and a ```flow fence that is drawn as
// an SVG diagram. Each flow line is "from -> to : label" (the label is optional).
import { readFileSync, writeFileSync } from 'node:fs'

const [inPath, outArg] = process.argv.slice(2)
if (!inPath) {
  console.error('usage: node scripts/md-to-html.mjs <in.md> [out.html]')
  process.exit(2)
}
const outPath = outArg ?? inPath.replace(/\.md$/, '.html')

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Inline: `code`, **bold**, bare URLs. Code spans are lifted out first so bold may wrap them.
function inline(src) {
  const codes = []
  const lifted = src.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  let t = esc(lifted)
  t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
  // eslint-disable-next-line no-control-regex -- NUL is the placeholder that marks a lifted code span
  return t.replace(/\u0000(\d+)\u0000/g, (_, n) => codes[Number(n)])
}

function joinLines(lines) {
  let out = ''
  for (const l of lines) {
    if (out === '') out = l
    // eslint-disable-next-line no-control-regex -- the ASCII range is intended
    else out += /[\x00-\x7f]$/.test(out) ? ' ' + l : l
  }
  return out
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

function cellHtml(c) {
  if (c === 'private') return '<span class="tag priv">private</span>'
  if (c === 'public') return '<span class="tag pub">public</span>'
  if (/^\(存在しない\)$/.test(c)) return '<span class="tag none">存在しない</span>'
  return inline(c)
}

// ---- flow diagram -> SVG ----
function textWidth(s) {
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) > 255 ? 13 : 7.4
  return w
}

function flowSvg(lines) {
  const edges = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^(.+?)\s+->\s+(.+?)(?:\s+:\s+(.+))?$/)
    if (!m) throw new Error(`bad flow line: ${line}`)
    edges.push({ from: m[1].trim(), to: m[2].trim(), label: (m[3] ?? '').trim() })
  }
  const names = []
  for (const e of edges) for (const n of [e.from, e.to]) if (!names.includes(n)) names.push(n)
  // Layer = longest path from a root (cycles are not expected).
  const layer = new Map(names.map((n) => [n, 0]))
  for (let i = 0; i < names.length; i++) {
    for (const e of edges) layer.set(e.to, Math.max(layer.get(e.to), layer.get(e.from) + 1))
  }
  const layers = []
  for (const n of names) (layers[layer.get(n)] ??= []).push(n)
  // Top-to-bottom layout: one row per layer, nodes side by side inside a row.
  const NODE_H = 38
  const NODE_GAP = 40
  const ROW_GAP = 96
  const PAD = 16
  const widths = new Map(names.map((n) => [n, textWidth(n) + 28]))
  const rowW = layers.map((ns) => ns.reduce((sum, n) => sum + widths.get(n), 0) + (ns.length - 1) * NODE_GAP)
  const width = Math.max(...rowW) + PAD * 2
  const height = PAD * 2 + layers.length * NODE_H + (layers.length - 1) * ROW_GAP
  const pos = new Map()
  layers.forEach((ns, li) => {
    let x = (width - rowW[li]) / 2
    const y = PAD + li * (NODE_H + ROW_GAP)
    for (const n of ns) {
      pos.set(n, { x, y, w: widths.get(n) })
      x += widths.get(n) + NODE_GAP
    }
  })
  // Edges leaving the same node carry their label near the target end, where they have fanned out.
  const siblings = new Map()
  for (const e of edges) siblings.set(e.from, (siblings.get(e.from) ?? 0) + 1)
  let body = ''
  for (const e of edges) {
    const a = pos.get(e.from)
    const b = pos.get(e.to)
    const x1 = a.x + a.w / 2
    const y1 = a.y + NODE_H
    const x2 = b.x + b.w / 2
    const y2 = b.y
    const ym = (y1 + y2) / 2
    body += `<path class="fe" d="M${x1},${y1} C${x1},${ym} ${x2},${ym} ${x2},${y2 - 2}" marker-end="url(#ah)"/>`
    if (e.label) {
      const n = siblings.get(e.from)
      const t = n > 1 ? 0.72 : 0.5
      const u = 1 - t
      const lx = x1 + (x2 - x1) * (3 * t * t - 2 * t * t * t)
      const ly = y1 * u * u * u + 3 * ym * u * u * t + 3 * ym * u * t * t + y2 * t * t * t
      const lw = textWidth(e.label) + 12
      body += `<rect class="fl" x="${lx - lw / 2}" y="${ly - 11}" width="${lw}" height="22" rx="4"/>`
      body += `<text class="ft" x="${lx}" y="${ly + 4}" text-anchor="middle">${esc(e.label)}</text>`
    }
  }
  for (const [n, p] of pos) {
    body += `<rect class="fn" x="${p.x}" y="${p.y}" width="${p.w}" height="${NODE_H}" rx="8"/>`
    body += `<text class="fx" x="${p.x + p.w / 2}" y="${p.y + NODE_H / 2 + 4.5}" text-anchor="middle">${esc(n)}</text>`
  }
  return (
    `<div class="flow"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">` +
    `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">` +
    `<path d="M0,0 L10,5 L0,10 z" class="fa"/></marker></defs>${body}</svg></div>`
  )
}

// ---- block parser ----
const lines = readFileSync(inPath, 'utf8').split('\n')
const out = []
const toc = []
let title = ''
let i = 0
while (i < lines.length) {
  const line = lines[i]
  if (line.trim() === '') {
    i++
    continue
  }
  const fence = line.match(/^```(\w*)/)
  if (fence) {
    const buf = []
    i++
    while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++])
    i++
    out.push(fence[1] === 'flow' ? flowSvg(buf) : `<pre>${esc(buf.join('\n'))}</pre>`)
    continue
  }
  const h = line.match(/^(#{1,3})\s+(.*)$/)
  if (h) {
    const level = h[1].length
    const text = h[2]
    if (level === 1) {
      title = text
      out.push(`<h1>${inline(text)}</h1>`)
    } else if (level === 2) {
      const id = `s${toc.length + 1}`
      toc.push({ id, text })
      const num = text.match(/^(\d+)\.\s*(.*)$/)
      out.push(num ? `<h2 id="${id}"><span class="n">${num[1]}.</span>${inline(num[2])}</h2>` : `<h2 id="${id}">${inline(text)}</h2>`)
    } else {
      out.push(`<h3>${inline(text)}</h3>`)
    }
    i++
    continue
  }
  if (line.startsWith('|')) {
    const rows = []
    while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++])
    const head = splitRow(rows[0])
    const bodyRows = rows.slice(2).map(splitRow)
    const th = head.map((c) => `<th>${inline(c)}</th>`).join('')
    const tr = bodyRows.map((r) => `<tr>${r.map((c) => `<td>${cellHtml(c)}</td>`).join('')}</tr>`).join('')
    out.push(`<div class="tw"><table><tr>${th}</tr>${tr}</table></div>`)
    continue
  }
  if (/^- /.test(line)) {
    const items = []
    while (i < lines.length && /^- /.test(lines[i])) {
      const parts = [lines[i].slice(2)]
      i++
      while (i < lines.length && /^ {2,}\S/.test(lines[i])) parts.push(lines[i++].trim())
      items.push(`<li>${inline(joinLines(parts))}</li>`)
    }
    out.push(`<ul>${items.join('')}</ul>`)
    continue
  }
  const para = []
  while (i < lines.length && lines[i].trim() !== '' && !/^(#|```|\||- )/.test(lines[i])) para.push(lines[i++])
  const html = inline(joinLines(para))
  out.push(para[0].startsWith('**') ? `<div class="card key"><p>${html}</p></div>` : `<p>${html}</p>`)
}

const nav = `<nav class="toc">${toc.map((t) => `<a href="#${t.id}">${esc(t.text)}</a>`).join('')}</nav>`
const firstH1 = out.findIndex((s) => s.startsWith('<h1>'))
out.splice(firstH1 + 1, 0, nav)

const css = `
:root{--bg:#f7f7f5;--card:#fff;--fg:#1f2328;--muted:#656d76;--line:#d8dee4;--accent:#0b6bcb;--ok:#1a7f37;--warn:#9a6700;--bad:#cf222e;--code:#eef1f4}
:root[data-theme="dark"]{--bg:#0d1117;--card:#161b22;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#58a6ff;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--code:#21262d}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0d1117;--card:#161b22;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--accent:#58a6ff;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--code:#21262d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 -apple-system,"Hiragino Sans","Segoe UI",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:26px;margin:0 0 6px}
h2{font-size:19px;margin:40px 0 12px;padding-bottom:6px;border-bottom:2px solid var(--line)}
h2 .n{color:var(--accent);margin-right:6px}
h3{font-size:15px;margin:22px 0 8px;color:var(--muted)}
p{margin:8px 0}
a{color:var(--accent)}
code{background:var(--code);padding:1px 6px;border-radius:4px;font:13px ui-monospace,"SF Mono",Menlo,monospace}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px 18px;margin:12px 0}
.card.key{border-left:4px solid var(--accent)}
.tw{overflow-x:auto;margin:10px 0}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:14px}
th,td{text-align:left;vertical-align:top;padding:9px 12px;border-bottom:1px solid var(--line)}
th{background:var(--code);font-weight:600;white-space:nowrap}
tr:last-child td{border-bottom:0}
td:first-child code{white-space:nowrap}
.tag{display:inline-block;padding:0 8px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid currentColor;white-space:nowrap}
.tag.pub{color:var(--ok)}.tag.priv{color:var(--warn)}.tag.none{color:var(--bad)}
ul{margin:6px 0;padding-left:22px}
li{margin:3px 0}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;overflow-x:auto;font:13px/1.6 ui-monospace,"SF Mono",Menlo,monospace}
.toc{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
.toc a{text-decoration:none;background:var(--card);border:1px solid var(--line);padding:3px 12px;border-radius:999px;font-size:13px}
.flow{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px;overflow-x:auto;margin:12px 0}
.flow svg{display:block;margin:0 auto;max-width:none}
.fn{fill:var(--code);stroke:var(--accent);stroke-width:1.5}
.fx{fill:var(--fg);font:13px -apple-system,"Hiragino Sans",sans-serif}
.fe{fill:none;stroke:var(--muted);stroke-width:1.5}
.fa{fill:var(--muted)}
.fl{fill:var(--card);stroke:var(--line)}
.ft{fill:var(--muted);font:12px -apple-system,"Hiragino Sans",sans-serif}
`.trim()

const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${css}
</style>
</head>
<body>
<div class="wrap">
${out.join('\n')}
</div>
</body>
</html>
`
writeFileSync(outPath, html)
console.log(`md-to-html: ${inPath} -> ${outPath}`)
