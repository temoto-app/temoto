// Before/after comparison of re-reading transcript snippets (item 78). It calls no model and does not start the app.
//
//   npx vite-node -c vitest.config.ts scripts/bench/transcript-read.mjs -- [MB] [hit count]
//
// The default is 50 hits against a synthetic transcript of 16 MB (= the limit of one file).
//   old:                 for each hit, read the whole file, JSON.parse every line, and find (before item 78)
//   new (location known): read only one line by a partial read using the metadata's offset / length, + one JSON.parse
//   new (no location):    lines from before item 78. It falls back to parsing every line, but with the LRU, 50 hits = one parse
// It also prints the time of one ingest (readMessages) side by side, since the parsing was changed to a per-line buffer.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBackendPaths } from '../../src/main/session/adapter/compat.ts'
import { TranscriptReader } from '../../src/main/session/adapter/transcript.ts'

const MB = Number(process.argv[2] ?? 16)
const HITS = Number(process.argv[3] ?? 50)
const FILE_ID = 'bench/session.jsonl'

let seed = 11
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const WORDS = ['承認', 'インボックス', '索引', '転写', 'search', 'index', 'thread', '🎉', '設計', 'offset']
const sentence = (n) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ')

// Made to resemble a real transcript: utterances, answers (with thinking), and large tool_result entries are mixed in.
const home = mkdtempSync(join(tmpdir(), 'aios-bench-transcript-'))
const configured = loadBackendPaths().transcriptDir
const root = configured.startsWith('~/') ? join(home, configured.slice(2)) : configured
mkdirSync(join(root, 'bench'), { recursive: true })
const path = join(root, FILE_ID)
const lines = []
let bytes = 0
let n = 0
while (bytes < MB * 1024 * 1024 - 64 * 1024) {
  const kind = n % 3
  const uuid = `m-${n}`
  let line
  if (kind === 0) {
    line = { type: 'user', uuid, timestamp: '2026-09-23T00:00:00.000Z', sessionId: 's', message: { role: 'user', content: [{ type: 'text', text: sentence(40) }] } }
  } else if (kind === 1) {
    line = { type: 'assistant', uuid, timestamp: '2026-09-23T00:00:01.000Z', sessionId: 's', message: { role: 'assistant', content: [{ type: 'thinking', thinking: sentence(200) }, { type: 'text', text: sentence(300) }] } }
  } else {
    line = { type: 'user', uuid, message: { content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: sentence(1500) }] } }
  }
  const text = JSON.stringify(line)
  lines.push(text)
  bytes += Buffer.byteLength(text, 'utf8') + 1
  n += 1
}
writeFileSync(path, lines.join('\n') + '\n')
const size = readFileSync(path).length

// ---- Old (the readMessages + find from before item 78, copied as is) ----
async function oldReadMessageText(messageId) {
  const raw = readFileSync(path).subarray(0, 16 * 1024 * 1024).toString('utf8')
  for (const l of raw.split('\n')) {
    if (l.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(l)
    } catch {
      continue
    }
    if ((parsed.type === 'user' || parsed.type === 'assistant') && parsed.uuid === messageId) {
      const parts = []
      for (const block of parsed.message?.content ?? []) {
        if (block.type === 'text') parts.push(block.text)
      }
      const text = parts.join('\n').trim()
      if (text !== '') return text
    }
  }
  return null
}

const reader = new TranscriptReader(home)
let t = performance.now()
const content = await reader.readMessages(FILE_ID)
const importMs = performance.now() - t
const messages = content.messages
const picks = Array.from({ length: HITS }, () => messages[Math.floor(rnd() * messages.length)])
const locator = (m) => ({ offset: m.offset, length: m.length, version: content.version })

const time = async (label, fn) => {
  const started = performance.now()
  let worst = 0
  for (const m of picks) {
    const one = performance.now()
    const text = await fn(m)
    worst = Math.max(worst, performance.now() - one)
    if (text !== m.text) throw new Error(`${label}: 本文が一致しない (${m.id})`)
  }
  const total = performance.now() - started
  console.log(`${label.padEnd(22)} 合計 ${total.toFixed(1).padStart(8)} ms  1 件の最大 ${worst.toFixed(2).padStart(7)} ms`)
  return total
}

console.log(`合成転写 ${(size / 1024 / 1024).toFixed(1)} MB / ${lines.length} 行 / 本文のあるメッセージ ${messages.length} 件 / ヒット ${HITS} 件`)
console.log(`取り込み (readMessages 1 回)  ${importMs.toFixed(1)} ms`)
const before = await time('旧 (全行解析 × ヒット)', (m) => oldReadMessageText(m.id))
const parsesBefore = reader.fullParseCount
const after = await time('新 (在りか)', async (m) => (await reader.readMessageText(FILE_ID, m.id, locator(m))).text)
if (reader.fullParseCount !== parsesBefore) throw new Error('在りかの経路で全行解析が走った')
const fallback = await time('新 (在りか無し + LRU)', async (m) => (await reader.readMessageText(FILE_ID, m.id, null)).text)
console.log(`全行解析の回数: 在りか 0 回 / 在りか無し ${reader.fullParseCount - parsesBefore} 回`)
console.log(`在りか / 旧 = 1/${Math.round(before / after)}、在りか無し / 旧 = 1/${Math.round(before / fallback)}`)

rmSync(home, { recursive: true, force: true })
