// Measures how much the cost of a one-character prefix match differs between writing systems (P6).
//
// A prefix match `"x"*` looks up **every word in the vocabulary that starts with x**, so its cost is proportional to that share.
// Latin script has only 26 letters, but kanji and kana have over a thousand. Both are built with the same vocabulary size and the
// same number of chunks, and a one-character exact match, a one-character prefix match and a two-character prefix match are compared.
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DOCS = Number(process.argv[2] ?? 25000)
const CHUNKS = 8
const WORDS = 40
const VOCAB = 30000

let seed = 7
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const pick = (s) => s[Math.floor(rnd() * s.length)]

const LATIN = 'abcdefghijklmnopqrstuvwxyz'
// A part of the joyo kanji + hiragana + katakana. Real Japanese word starts draw from a wider set (the joyo kanji alone number 2,136),
// so this pool is an estimate that is **unfavorable to the Japanese side**.
const KANJI =
  '日一国会人年大十二本中長出三同時政事自行社見月分議後前民生連五発間対上部東者党地合市業内相方四定今回新場金員九入選立開手'
+ '米力学問高代明実円関決子動京全目表戦経通外最言氏現理調体化田当八六約主題下首意法不来作性的要用制治度務強気小七成期公持野協取'
+ '都和統以機平総加山思心電業線前実市田町村山川石田村原野'
const KANA = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ'
const KATA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワンガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポ'
const JA_HEADS = [...new Set([...KANJI, ...KANA, ...KATA])].join('')

function build(label, heads, tail, wordLen) {
  const dir = mkdtempSync(join(tmpdir(), `aios-pfx-${label}-`))
  const db = new Database(join(dir, 's.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('cache_size = -65536')
  db.exec(`CREATE VIRTUAL TABLE chunk_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2', content = '', contentless_delete = 1)`)
  const vocab = Array.from({ length: VOCAB }, () => {
    const n = wordLen()
    return pick(heads) + Array.from({ length: n - 1 }, () => pick(tail)).join('')
  })
  const text = () => Array.from({ length: WORDS }, () => pick(vocab)).join(' ')
  const ins = db.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)`)
  const t0 = performance.now()
  db.transaction(() => {
    for (let i = 1; i <= DOCS * CHUNKS; i += 1) ins.run(i, text())
  })()
  db.exec(`INSERT INTO chunk_fts(chunk_fts) VALUES('optimize')`)
  return { db, vocab, dir, ms: Math.round(performance.now() - t0) }
}

function report(label, built, probes) {
  const q = built.db.prepare(`SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY bm25(chunk_fts) LIMIT 250`)
  console.log(`\n== ${label} (${DOCS * CHUNKS} chunks, vocab ${VOCAB}, built ${built.ms} ms) ==`)
  for (const ch of probes) {
    const share = built.vocab.filter((w) => w.startsWith(ch)).length
    const row = []
    for (const m of [`"${ch}"`, `"${ch}"*`]) {
      const t = performance.now()
      let n = 0
      try { n = q.all(m).length } catch { n = -1 }
      row.push(`${m.padEnd(6)} ${String(Math.round(performance.now() - t)).padStart(5)} ms (${n})`)
    }
    console.log(`  ${ch}  語彙 ${String(share).padStart(5)} / ${VOCAB}  |  ${row.join('  |  ')}`)
  }
}

const en = build('en', LATIN, LATIN, () => 3 + Math.floor(rnd() * 6))
report(`ラテン文字 (語頭 ${LATIN.length} 種)`, en, ['a', 'e', 'z'])
en.db.close()

const ja = build('ja', JA_HEADS, JA_HEADS, () => 1 + Math.floor(rnd() * 3))
report(`日本語 (語頭 ${JA_HEADS.length} 種)`, ja, ['日', 'の', '青'])
ja.db.close()

// Whether a one-character word itself, when it is **very frequent** (English "a" / "I", and the Japanese particle "no"), makes even the exact match slow.
// The synthetic vocabulary above has no one-character words, so this is measured separately.
{
  const dir = mkdtempSync(join(tmpdir(), 'aios-pfx-freq-'))
  const db = new Database(join(dir, 's.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('cache_size = -65536')
  db.exec(`CREATE VIRTUAL TABLE chunk_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2', content = '', contentless_delete = 1)`)
  const vocab = Array.from({ length: VOCAB }, () =>
    Array.from({ length: 3 + Math.floor(rnd() * 6) }, () => pick(LATIN)).join('')
  )
  // Makes 5% of the words "a" (about the frequency of an English article).
  const word = () => (rnd() < 0.05 ? 'a' : pick(vocab))
  const ins = db.prepare(`INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)`)
  db.transaction(() => {
    for (let i = 1; i <= DOCS * CHUNKS; i += 1)
      ins.run(i, Array.from({ length: WORDS }, word).join(' '))
  })()
  db.exec(`INSERT INTO chunk_fts(chunk_fts) VALUES('optimize')`)
  const q = db.prepare(`SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY bm25(chunk_fts) LIMIT 250`)
  console.log(`\n== ラテン文字 + 高頻度の 1 文字語 "a" (語の 5%) ==`)
  for (const m of ['"a"', '"a"*', '"ab"', '"ab"*']) {
    const t = performance.now()
    const n = q.all(m).length
    console.log(`  ${m.padEnd(6)} ${String(Math.round(performance.now() - t)).padStart(5)} ms (${n})`)
  }
  db.close()
}
