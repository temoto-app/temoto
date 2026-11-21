/**
 * Measures re-applying the redaction to an exported conversation (`redactExportHtml`, TODO 875 item 3 / 866).
 *
 * It builds a synthetic HTML close to the print HTML that the renderer assembles: the styles.css inline (`<style>`) at the top,
 * then question-and-answer sections (Japanese and English paragraphs, highlighted code blocks + `data-code`, tables, links) repeated up to
 * the target size. A few secret-looking strings are mixed in too, so the masking path is exercised. With `BENCH_IMAGES=1`,
 * a few base64 images (1 MB each) are added to `src`. The HTML export applies the redaction before the images are embedded, not after,
 * but this serves as the upper bound for when the renderer sends `data:` images.
 *
 * `redactExportHtml` runs synchronously on main's JS thread, so the total time = the time main is held.
 * It does not start the app and calls no model.
 *
 *   npx vite-node -c vitest.config.ts scripts/bench/export-redaction.mts -- [MB...]
 *
 * The default is 1 / 5 / 20 / 64 MB (64 MB is `EXPORT_HTML_MAX_BYTES`).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXPORT_HTML_MAX_BYTES } from '../../src/shared/conversation-export.js'
import { redactExportHtml } from '../../src/main/export/conversation-pdf.js'

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
const SIZES_MB = argv.length > 0 ? argv.map(Number) : [1, 5, 20, 64]
const IMAGES = process.env['BENCH_IMAGES'] === '1'
const REPEAT = 3

const styles = readFileSync(join(import.meta.dirname, '../../src/renderer/src/styles.css'), 'utf8')

function turn(i: number): string {
  const code = [
    `<span class="hljs-keyword">export</span> <span class="hljs-keyword">function</span> <span class="hljs-title">widget${i}</span>(value: <span class="hljs-type">number</span>): <span class="hljs-type">number</span> {`,
    `  <span class="hljs-keyword">const</span> token = readToken(<span class="hljs-string">'config.json'</span>)`,
    `  <span class="hljs-keyword">return</span> value * <span class="hljs-number">2</span>`,
    '}'
  ].join('\n')
  const raw = `export function widget${i}(value: number): number {\n  const token = readToken('config.json')\n  return value * 2\n}`
  // Once in 400 items, a secret-like string (to exercise the masking path).
  const secret = i % 400 === 0 ? `<p>設定は <code>api_key=sk-${'a'.repeat(32)}</code> と <code>password: hunter22hunter</code></p>` : ''
  return `<section class="export-turn" id="turn-${i}">
<h2>質問 ${i}</h2>
<div class="user-message"><p>承認インボックスの設計について、索引プロセスの再起動の待ちで何が落ちるかを調べて。Authorization ヘッダの扱いも。</p></div>
<div class="assistant-message">
<p>The index client keeps removals in an ordered map and flushes them when the child becomes ready. 復元の作り直しは同じ列に並びます。See <a href="https://example.com/docs/${i}?page=2&amp;ref=export">the docs</a>.</p>
<div class="code-block" data-code="${raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"><pre><code class="language-ts">${code}</code></pre></div>
<table><thead><tr><th>項目</th><th>値</th></tr></thead><tbody><tr><td>件数</td><td>${i}</td></tr><tr><td>時間</td><td>${i % 97} ms</td></tr></tbody></table>
${secret}
</div>
</section>
`
}

function build(targetBytes: number): string {
  const parts = [`<!doctype html><html><head><meta charset="utf-8"><style>${styles}</style></head><body>`]
  let size = Buffer.byteLength(parts[0] ?? '', 'utf8')
  if (IMAGES) {
    const image = Buffer.alloc(1024 * 1024, 7).toString('base64')
    for (let k = 0; k < 4; k += 1) {
      const tag = `<p><img alt="x" src="data:image/png;base64,${image}"></p>`
      parts.push(tag)
      size += tag.length
    }
  }
  for (let i = 0; size < targetBytes; i += 1) {
    const t = turn(i)
    parts.push(t)
    size += Buffer.byteLength(t, 'utf8')
  }
  parts.push('</body></html>')
  return parts.join('')
}

console.log(`styles.css ${(styles.length / 1024).toFixed(0)} KB / 上限 ${(EXPORT_HTML_MAX_BYTES / 1024 / 1024).toFixed(0)} MB${IMAGES ? ' / 画像 4 MB' : ''}`)
for (const mb of SIZES_MB) {
  const html = build(mb * 1024 * 1024)
  const times: number[] = []
  let out = ''
  for (let r = 0; r < REPEAT; r += 1) {
    const at = performance.now()
    out = redactExportHtml(html)
    times.push(performance.now() - at)
  }
  times.sort((a, b) => a - b)
  console.log(
    `${mb} MB (${(Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(1)} MB): 中央値 ${(times[Math.floor(REPEAT / 2)] ?? 0).toFixed(0)} ms / ` +
      `最大 ${(times[REPEAT - 1] ?? 0).toFixed(0)} ms / 伏せた後 ${(Buffer.byteLength(out, 'utf8') / 1024 / 1024).toFixed(1)} MB`
  )
}
