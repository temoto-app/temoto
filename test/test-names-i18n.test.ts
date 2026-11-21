import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- untyped .mjs
import { embeds, encodeFor, findTargets, japaneseOnlyQuoted, maskedFingerprint } from '../scripts/lib/test-names-core.mjs'

const ROOT = process.cwd()
const TOOL = join(ROOT, 'scripts/test-names-i18n.mjs')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'test-names-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function run(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync('node', [TOOL, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr }
}

const write = (name: string, text: string): string => {
  mkdirSync(join(dir, 'test'), { recursive: true })
  writeFileSync(join(dir, name), text)
  return name
}
const read = (name: string): string => readFileSync(join(dir, name), 'utf8')
type Item = { file: string; src: string; en: string; kind: string; count: number; parents?: string[]; callee: string }
const extract = (...files: string[]): Item[] => {
  const r = run(['extract', '--out', 'out.json', ...files])
  expect(r.code, r.err).toBe(0)
  return JSON.parse(read('out.json'))
}
const apply = (items: Item[], extra: string[] = []) => {
  writeFileSync(join(dir, 'tr.json'), JSON.stringify(items))
  return run(['apply', ...extra, 'tr.json'])
}

const SAMPLE = `import { describe, expect, it } from 'vitest'
describe('スレッドの一覧', () => {
  it('空のとき空配列を返す', () => {
    expect('日本語のデータ').toBe('日本語のデータ')
  })
  it.skip('飛ばす (項目 55)', () => {})
  it.only(\`バッククォートの名前\`, () => {})
  it.each([1, 2])('値 %i を受け取る', (n) => {
    expect(n).toBeGreaterThan(0)
  })
  for (const fork of [true, false]) {
    it(\`分岐 (fork: \${fork}) を扱う\`, () => {})
  }
  it('already English', () => {})
})
`

describe('test-names-i18n: extract', () => {
  it('picks the first argument of describe / it and their modifiers, and nothing else', () => {
    write('test/a.test.ts', SAMPLE)
    const items = extract('test/a.test.ts')
    expect(items.map((i) => i.src)).toEqual([
      'スレッドの一覧',
      '空のとき空配列を返す',
      '飛ばす (項目 55)',
      'バッククォートの名前',
      '値 %i を受け取る',
      '分岐 (fork: ${fork}) を扱う'
    ])
    expect(items.map((i) => i.callee)).toEqual(['describe', 'it', 'it.skip', 'it.only', 'it.each', 'it'])
    expect(items[1]!.parents).toEqual(['スレッドの一覧'])
    expect(items[5]!.kind).toBe('template-sub')
  })

  it('does not take the table or the condition of a modifier call as a name', () => {
    write('test/b.test.ts', `it.skipIf(process.platform === 'win32')('名前', () => {})\nit.each(['表の中身'])('%s', () => {})\n`)
    const { targets, unpicked } = findTargets('test/b.test.ts', read('test/b.test.ts'))
    expect(targets.map((t: { src: string }) => t.src)).toEqual(['名前', '%s'])
    expect(unpicked.map((u: { category: string }) => u.category)).toEqual(['each-table'])
  })

  it('merges the same name in one file into one item with a count', () => {
    write('test/c.test.ts', `it('同じ', () => {})\ndescribe('x', () => { it('同じ', () => {}) })\n`)
    const items = extract('test/c.test.ts')
    expect(items).toHaveLength(1)
    expect(items[0]!.count).toBe(2)
  })
})

describe('test-names-i18n: apply', () => {
  it('writes the translations back and changes nothing else', () => {
    write('test/a.test.ts', SAMPLE)
    const items = extract('test/a.test.ts')
    const en = [
      'thread list',
      'returns an empty array when empty',
      'skipped (item 55)',
      'a backtick name',
      'receives the value %i',
      'handles the branch (fork: ${fork})'
    ]
    items.forEach((it, k) => (it.en = en[k]!))
    const r = apply(items)
    expect(r.code, r.err).toBe(0)
    expect(JSON.parse(r.out)).toMatchObject({ replaced: 6, itemErrors: 0, filesWritten: 1, filesSkipped: 0 })
    const out = read('test/a.test.ts')
    expect(out).toContain("describe('thread list'")
    expect(out).toContain('it(`handles the branch (fork: ${fork})`')
    expect(out).toContain("expect('日本語のデータ').toBe('日本語のデータ')")
    expect(out).toContain('it.each([1, 2])(')
    expect(maskedFingerprint('a.ts', out).fp).toBe(maskedFingerprint('a.ts', SAMPLE).fp)
    // Re-applying is a no-op.
    const again = apply(items)
    expect(JSON.parse(again.out)).toMatchObject({ replaced: 0, alreadyDone: 6 })
    expect(read('test/a.test.ts')).toBe(out)
  })

  it('escapes quotes and backslashes so the name reads back exactly', () => {
    write('test/q.test.ts', `it('引用', () => {})\nit("二重", () => {})\nit('両方', () => {})\n`)
    const items = extract('test/q.test.ts')
    items[0]!.en = "does not read the user's file"
    items[1]!.en = 'says "hello"'
    items[2]!.en = `both ' and " and \\ and a backslash`
    const r = apply(items)
    expect(r.code, r.err).toBe(0)
    const read2 = findTargets('q.ts', read('test/q.test.ts')).targets.map((t: { src: string }) => t.src)
    expect(read2).toEqual(["does not read the user's file", 'says "hello"', `both ' and " and \\ and a backslash`])
  })

  it('encodes each occurrence in its own spelling when one name is written with different quotes', () => {
    write('test/m.test.ts', "it('同じ名前', () => {})\nit(\"同じ名前\", () => {})\nit(`同じ名前`, () => {})\n")
    const items = extract('test/m.test.ts')
    expect(items).toHaveLength(1)
    expect(items[0]!.count).toBe(3)
    items[0]!.en = `it's "same"`
    const r = apply(items)
    expect(r.code, r.err).toBe(0)
    expect(JSON.parse(r.out)).toMatchObject({ replaced: 1, itemErrors: 0, filesWritten: 1 })
    const srcs = findTargets('m.ts', read('test/m.test.ts')).targets.map((t: { src: string }) => t.src)
    expect(srcs).toEqual([`it's "same"`, `it's "same"`, `it's "same"`])
  })

  it('rejects a translation whose placeholders differ, and leaves the file alone', () => {
    write('test/p.test.ts', SAMPLE)
    const items = extract('test/p.test.ts')
    items[4]!.en = 'receives the value' // %i dropped
    items[5]!.en = 'handles the branch (fork: ${other})'
    items[1]!.en = 'returns an empty array'
    const r = apply(items)
    expect(r.code).toBe(1)
    expect(r.err).toContain('placeholders changed')
    expect(read('test/p.test.ts')).toBe(SAMPLE)
  })

  it('rejects placeholders in a different order and a missing reference number', () => {
    write('test/o.test.ts', `it('値 %s と %d (項目 55)', () => {})\n`)
    const items = extract('test/o.test.ts')
    items[0]!.en = 'value %d and %s (item 55)'
    expect(apply(items).err).toContain('placeholders changed')
    items[0]!.en = 'value %s and %d'
    expect(apply(items).err).toContain('reference number 55')
    items[0]!.en = 'value %s and %d (item 55)'
    expect(apply(items).code).toBe(0)
  })

  it('rejects a translation that brings in a backend term', () => {
    write('test/t.test.ts', `it('名前', () => {})\n`)
    const items = extract('test/t.test.ts')
    items[0]!.en = ['clau', 'de'].join('') + ' starts'
    expect(apply(items).err).toContain('backend term')
  })

  it('does not write a file when the tokens outside the name literals would change', () => {
    write('test/v.test.ts', `it('名前', () => {\n  run()\n})\n`)
    const items = extract('test/v.test.ts')
    // A name that closes the literal and the call and starts new code is escaped by the encoder, so it stays a name.
    items[0]!.en = "x', () => {}); evil(); it('y"
    const r = apply(items)
    expect(r.code, r.err).toBe(0)
    expect(findTargets('v.ts', read('test/v.test.ts')).targets).toHaveLength(1)
    expect(findTargets('v.ts', read('test/v.test.ts')).targets[0].src).toBe(items[0]!.en)
  })

  it('fails the verification when a rewrite would alter other tokens (the check itself)', () => {
    const before = `it('名前', () => { run() })\n`
    const tampered = `it('name', () => { run(); extra() })\n`
    expect(maskedFingerprint('a.ts', tampered).fp).not.toBe(maskedFingerprint('a.ts', before).fp)
    expect(maskedFingerprint('a.ts', `it('name', () => { run() })\n`).fp).toBe(maskedFingerprint('a.ts', before).fp)
    // A literal added or removed changes the count.
    expect(maskedFingerprint('a.ts', `it('a', () => {})\nit('b', () => {})\n`).count).toBe(2)
  })

  it('warns when Japanese remains and when two names collide in one describe', () => {
    write('test/w.test.ts', `describe('x', () => {\n  it('一つ目', () => {})\n  it('二つ目', () => {})\n  it('三つ目', () => {})\n})\n`)
    const items = extract('test/w.test.ts')
    items[0]!.en = 'same'
    items[1]!.en = 'same'
    items[2]!.en = 'third 日本語'
    const r = apply(items)
    expect(r.code).toBe(0)
    expect(r.err).toContain('duplicate name after translation: "same"')
    expect(r.err).toContain('Japanese remains')
  })

  it('leaves items with an empty en pending and reports stale items', () => {
    write('test/s.test.ts', `it('一', () => {})\nit('二', () => {})\n`)
    const items = extract('test/s.test.ts')
    items[0]!.en = 'one'
    items.push({ ...items[1]!, src: 'もう無い', en: 'gone' })
    const r = apply(items)
    expect(JSON.parse(r.out)).toMatchObject({ replaced: 1, pending: 1, stale: 1 })
  })
})

describe('test-names-i18n: check and plan', () => {
  it('counts the remaining Japanese names per file and allows quoted-only names', () => {
    write('test/k.test.ts', `it('残り', () => {})\nit('shows 「承認待ち」', () => {})\nit('English', () => {})\n`)
    const r = run(['check', 'test'])
    expect(r.code).toBe(1)
    expect(r.out).toContain('test/k.test.ts')
    expect(r.out).toContain('remaining Japanese test names: 1 in 1 file(s); quoted-only (allowed): 1')
    write('test/k.test.ts', `it('shows 「承認待ち」', () => {})\n`)
    expect(run(['check', 'test']).code).toBe(0)
  })

  it('splits the files into bundles of about the same size', () => {
    for (let i = 0; i < 6; i++) write(`test/f${i}.test.ts`, `it('一', () => {})\nit('二', () => {})\n`)
    const r = run(['plan', '--bundles', '3', 'test'])
    expect(r.out).toContain('bundle A: 4 names, 2 files')
    expect(r.out).toContain('total 12 names in 6 files')
  })
})

describe('test-names-i18n: helpers', () => {
  it('lists placeholders in order', () => {
    expect(embeds('%s と ${a.b} と $name と 100%')).toEqual(['%s', '${a.b}', '$name'])
  })

  it('encodes a template with its substitutions byte for byte', () => {
    const t = { kind: 'template-sub', quote: '`', exprs: [' x ', 'y'] }
    expect(encodeFor(t, 'a ${ x } b ${y} c`d').text).toBe('`a ${ x } b ${y} c\\`d`')
    expect(encodeFor(t, 'a ${y} b ${ x }').error).toContain('missing or out of order')
  })

  it('treats a name whose Japanese is only inside quotes as quoted-only', () => {
    expect(japaneseOnlyQuoted('shows 「承認待ち」')).toBe(true)
    expect(japaneseOnlyQuoted('shows "承認待ち" badge')).toBe(true)
    expect(japaneseOnlyQuoted('承認待ちを出す')).toBe(false)
    expect(japaneseOnlyQuoted('plain')).toBe(false)
  })
})
