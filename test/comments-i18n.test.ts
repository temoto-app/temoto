/**
 * Tests for the comment translation tools (TODO 1256 stage 0): scripts/comments-i18n.mjs and
 * scripts/lint-comments.mjs. They never call a model; the "translations" are written by hand.
 *
 * The property that matters most: `apply` must never change anything but comments, and must refuse
 * (not write) when its verification fails.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// @ts-expect-error -- untyped .mjs (scripts/ is outside tsconfig)
import * as core from '../scripts/lib/comments-core.mjs'

const CLI = resolve(__dirname, '../scripts/comments-i18n.mjs')
const LINT = resolve(__dirname, '../scripts/lint-comments.mjs')
// The backend term is read from the lint's own definition so this file never spells it out (constraint 6).
const BACKEND_TERM: string = JSON.parse(readFileSync(resolve(__dirname, '../compat/forbidden-terms.json'), 'utf8')).terms[0]

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comments-i18n-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (name: string, text: string) => {
  mkdirSync(join(dir, name, '..'), { recursive: true })
  writeFileSync(join(dir, name), text)
}
const read = (name: string) => readFileSync(join(dir, name), 'utf8')
const run = (script: string, args: string[]) => spawnSync('node', [script, ...args], { cwd: dir, encoding: 'utf8' })
type Item = { id: string; file: string; src: string; en?: string | null; fixedPrefix?: string; count: number; kind: string; next: string[] }

const extract = (...paths: string[]): any[] => {
  const r = run(CLI, ['extract', '--out', 'items.json', ...paths])
  expect(r.status, r.stderr).toBe(0)
  return JSON.parse(read('items.json'))
}
const apply = (items: any[]) => {
  writeFileSync(join(dir, 'tr.json'), JSON.stringify(items))
  const r = run(CLI, ['apply', 'tr.json'])
  return { ...r, stat: r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop() as string) : null }
}

describe('ts: extract -> apply', () => {
  const SRC = `// 先頭の説明
// 2 行目 (TODO 12)
export const a = '日本語の文字列' // 行末のコメント
const re = /日本語/
/**
 * 関数の説明。\`foo\` を呼ぶ。
 * @param x 引数の説明
 * @returns 結果 {@link bar}
 */
export function f(x: number) {
  return x /* 途中 */ + 1
}
const jsx = <div>日本語の JSX 文字 {/* JSX の注釈 */}</div>
it('テスト名は触らない', () => {})
const tpl = \`テンプレート // これは文字列 /* これも */\`
`
  it('finds only real comments (never strings, regexes, JSX text, test names, templates)', () => {
    write('a.tsx', SRC)
    const items = extract('a.tsx')
    expect(items.map((i) => i.kind)).toEqual(['line', 'trailing', 'jsdoc', 'block', 'block'])
    expect(items[0].src).toBe('// 先頭の説明\n// 2 行目 (TODO 12)')
    expect(items[2].next[0]).toContain('export function f')
  })

  it('round trip: translations land at the right place and code is untouched', () => {
    write('a.tsx', SRC)
    const items = extract('a.tsx')
    items[0].en = '// Leading note\n// Second line (TODO 12)'
    items[1].en = '// trailing comment'
    items[2].en = `/**\n * Describes the function. Calls \`foo\`.\n * @param x the argument\n * @returns the result {@link bar}\n */`
    items[3].en = '/* midway */'
    items[4].en = null // JSX comment slot: deletion is refused, see below
    const r = apply(items)
    expect(r.status).toBe(1) // the JSX slot deletion is an item error
    expect(r.stat.replaced).toBe(4)
    const out = read('a.tsx')
    expect(out).toContain("// Leading note\n// Second line (TODO 12)\nexport const a = '日本語の文字列' // trailing comment")
    expect(out).toContain('/* midway */')
    expect(out).toContain('{/* JSX の注釈 */}') // refused, still Japanese
    expect(out).toContain("const re = /日本語/")
    expect(out).toContain("it('テスト名は触らない'")
    expect(out).toContain('`テンプレート // これは文字列 /* これも */`')
    expect(core.fingerprint('a.tsx', out)).toBe(core.fingerprint('a.tsx', SRC))
  })

  it('is idempotent and accepts partial translation files', () => {
    write('a.ts', '// 一つ目\nconst a = 1\n// 二つ目\nconst b = 2\n')
    const items = extract('a.ts')
    const first = apply([{ ...items[0], en: '// first' }])
    expect(first.stat).toMatchObject({ replaced: 1, pending: 0 })
    const once = read('a.ts')
    expect(once).toBe('// first\nconst a = 1\n// 二つ目\nconst b = 2\n')
    // The same file again: nothing to do (already done).
    const again = apply([{ ...items[0], en: '// first' }])
    expect(again.stat).toMatchObject({ filesWritten: 0, replaced: 0, alreadyDone: 1 })
    // The second item, extracted before the first was applied (stale offsets): matched by text, not position.
    const second = apply([{ ...items[1], en: '// second' }])
    expect(second.stat.replaced).toBe(1)
    expect(read('a.ts')).toBe('// first\nconst a = 1\n// second\nconst b = 2\n')
    // Untranslated items are left alone and counted.
    write('b.ts', '// 未訳\nconst c = 3\n')
    const b = extract('b.ts')
    expect(apply(b).stat).toMatchObject({ pending: 1, replaced: 0, filesWritten: 0 })
    expect(read('b.ts')).toBe('// 未訳\nconst c = 3\n')
  })

  it('translates identical comments in one file with one item (count)', () => {
    write('a.ts', '// 同じ\nconst a = 1\n// 同じ\nconst b = 2\n')
    const items = extract('a.ts')
    expect(items).toHaveLength(1)
    expect(items[0].count).toBe(2)
    items[0].en = '// same'
    apply(items)
    expect(read('a.ts')).toBe('// same\nconst a = 1\n// same\nconst b = 2\n')
  })

  it('re-indents multi-line translations to the comment indent', () => {
    write('a.ts', 'class A {\n  /**\n   * 説明\n   * 二行目\n   */\n  m() {}\n  // 一\n  // 二\n  n() {}\n}\n')
    const items = extract('a.ts')
    items[0].en = '/**\n * Explanation\n * second\n */'
    items[1].en = '// one\n// two'
    expect(apply(items).status).toBe(0)
    expect(read('a.ts')).toBe('class A {\n  /**\n   * Explanation\n   * second\n   */\n  m() {}\n  // one\n  // two\n  n() {}\n}\n')
  })

  it('deletes without leaving double blank lines or trailing spaces', () => {
    write('a.ts', 'const a = 1\n\n// 消す\n\nconst b = 2 // 行末\nfoo(/* 引数 */ 1)\nfunction f() {\n  // 先頭\n\n  return 1\n}\n')
    const items = extract('a.ts')
    items.forEach((i) => (i.en = null))
    expect(apply(items).status).toBe(0)
    expect(read('a.ts')).toBe('const a = 1\n\nconst b = 2\nfoo(1)\nfunction f() {\n  return 1\n}\n')
  })

  it('can delete the first comment of a file and a multi-line inline JSX comment', () => {
    write('a.tsx', '// 先頭の説明\nimport x from "x"\nconst j = <div>{/* 複数行の\n  注釈 */ x}</div>\n')
    const items = extract('a.tsx')
    items[0].en = null
    items[1].en = '/* a multi-line\n   note */'
    expect(apply(items).status).toBe(0)
    expect(read('a.tsx')).toBe('import x from "x"\nconst j = <div>{/* a multi-line\n   note */ x}</div>\n')
  })

  it('never deletes a directive or a JSX comment slot', () => {
    write('a.tsx', 'const x = <div>{/* 注釈 */}</div>\n// @ts-expect-error -- 理由の説明\nconst y: number = "a"\n')
    const items = extract('a.tsx')
    items.forEach((i) => (i.en = null))
    const r = apply(items)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('JSX comment slot')
    expect(r.stderr).toContain('directive comment cannot be deleted')
    expect(read('a.tsx')).toContain('注釈')
  })
})

describe('apply refuses bad translations (the file is left as is)', () => {
  const cases: Array<[string, string, string, string]> = [
    ['Japanese remains', '// 説明\nconst a = 1\n', '// 説明 remains', 'Japanese remains'],
    ['block without */', '/* 説明 */\nconst a = 1\n', '/* text', 'block comment must end'],
    ['extra */ inside', '/* 説明 */\nconst a = 1\n', '/* a */ b() /* c */', 'block comment must end'],
    ['line comment with a code line', '// 説明\nconst a = 1\n', '// ok\nfoo()', 'must be a // comment'],
    ['block opener changed', '/** 説明 */\nconst a = 1\n', '/* text */', 'block comment must open with'],
    ['@param renamed', '/**\n * 説明\n * @param x 引数\n */\nfunction f(x: number) {}\n', '/**\n * text\n * @param y arg\n */', 'JSDoc tags changed'],
    ['code span dropped', '// `foo` を呼ぶ\nconst a = 1\n', '// calls it', 'code span `foo`'],
    ['reference number dropped', '// 項目 123 の件\nconst a = 1\n', '// the matter', 'reference number 123'],
    ['trailing comment made multi-line', 'const a = 1 // 説明\n', '// a\n// b', 'trailing comment must stay on one line'],
    ['inline block made multi-line', 'foo(/* 説明 */ 1)\n', '/*\n * a\n */', 'inline block comment'],
    ['backend term (constraint 6)', '// 説明\nconst a = 1\n', `// the ${BACKEND_TERM} thing`, 'backend term'],
  ]
  for (const [name, src, en, why] of cases) {
    it(name, () => {
      write('a.ts', src)
      const items = extract('a.ts')
      items[0].en = en
      const r = apply(items)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(why)
      expect(read('a.ts')).toBe(src)
    })
  }

  it('"loose" skips the content checks only', () => {
    write('a.ts', '// 項目 123 の件\nconst a = 1\n')
    const items = extract('a.ts')
    items[0].en = '// the matter'
    items[0] = { ...items[0], loose: true } as Item
    expect(apply(items).status).toBe(0)
  })

  it('the fingerprint catches any change of a non-comment token (and a changed line break)', () => {
    const f = core.fingerprint
    expect(f('a.ts', 'const a = 1 // x\n')).toBe(f('a.ts', 'const a = 1\n'))
    expect(f('a.ts', 'const a = 1\n')).not.toBe(f('a.ts', 'const a = 2\n'))
    expect(f('a.ts', 'const s = "// x"\n')).not.toBe(f('a.ts', 'const s = ""\n'))
    expect(f('a.ts', 'return\nx\n')).not.toBe(f('a.ts', 'return x\n')) // ASI-relevant line break
    expect(f('a.css', 'a { color: red; } /* x */')).toBe(f('a.css', 'a { color: red; }'))
    expect(f('a.css', 'a { color: red; }')).not.toBe(f('a.css', 'a { color: blue; }'))
  })
})

describe('directive comments', () => {
  it('are excluded when plain and extracted with a fixed prefix when they carry Japanese', () => {
    write(
      'a.ts',
      '#!/usr/bin/env node\n// eslint-disable-next-line no-control-regex -- 制御文字\nconst a = 1\n// @ts-expect-error\nconst b: number = "x"\n/* v8 ignore next 2 */\nconst c = 1\n//# sourceMappingURL=a.js.map\n',
    )
    const items = extract('a.ts')
    expect(items).toHaveLength(1)
    expect(items[0].fixedPrefix).toBe('// eslint-disable-next-line no-control-regex -- ')
    items[0].en = '// something else'
    expect(apply(items).status).toBe(1)
    items[0].en = '// eslint-disable-next-line no-control-regex -- control characters'
    expect(apply(items).status).toBe(0)
    expect(read('a.ts')).toContain('-- control characters\nconst a = 1')
  })

  it('stats lists them', () => {
    write('a.ts', '// eslint-disable-next-line no-x -- 理由\nconst a = 1\n')
    const r = run(CLI, ['stats', '--json', '.'])
    expect(JSON.parse(r.stdout).total.directives).toBe(1)
  })
})

describe('css / sh / py', () => {
  it('css: comments only, strings and url() are skipped', () => {
    const css = '/* 見出し */\n.a { content: "/* 文字列 */"; background: url(a/*b.png); }\n.b { color: red; /* 行末 */ }\n'
    write('a.css', css)
    const items = extract('a.css')
    expect(items.map((i) => i.src)).toEqual(['/* 見出し */', '/* 行末 */'])
    items[0].en = '/* heading */'
    items[1].en = null
    expect(apply(items).status).toBe(0)
    expect(read('a.css')).toBe('/* heading */\n.a { content: "/* 文字列 */"; background: url(a/*b.png); }\n.b { color: red; }\n')
  })

  it('sh: `#` only at a word start; quotes, $#, ${#x}, heredocs are not comments', () => {
    const sh = `#!/bin/sh
# 先頭の説明
echo "# 文字列" '# これも' $# \${#x} a#b
cat <<'EOF'
# ヒアドキュメントの中 (コメントではない)
EOF
cat <<EOT > out # 本物のコメント
本文の # 日本語
EOT
x=$(echo hi) # 末尾
`
    write('a.sh', sh)
    const items = extract('a.sh')
    expect(items.map((i) => i.src)).toEqual(['# 先頭の説明', '# 本物のコメント', '# 末尾'])
    items[0].en = '# leading note'
    items[1].en = '# a real comment'
    items[2].en = null
    expect(apply(items).status).toBe(0)
    const out = read('a.sh')
    expect(out).toContain('# leading note')
    expect(out).toContain('cat <<EOT > out # a real comment\n本文の # 日本語\nEOT')
    expect(out).toContain('x=$(echo hi)\n')
    expect(out).toContain('# ヒアドキュメントの中 (コメントではない)')
  })

  it('py: comments come from the tokenizer, verification is the AST', () => {
    const py = '# 説明\nx = "# 文字列"  # 行末\n"""# docstring 日本語"""\n'
    write('a.py', py)
    const items = extract('a.py')
    expect(items.map((i) => i.src)).toEqual(['# 説明', '# 行末'])
    items[0].en = '# note'
    items[1].en = '# trailing'
    expect(apply(items).status).toBe(0)
    expect(read('a.py')).toBe('# note\nx = "# 文字列"  # trailing\n"""# docstring 日本語"""\n')
  })
})

describe('extract output and exclusions', () => {
  it('skips node_modules, dot-dirs, spikes/ and test/fixtures/', () => {
    for (const p of ['node_modules/x/a.ts', '.hidden/a.ts', 'spikes/a.ts', 'test/fixtures/a.ts', 'src/a.ts']) write(p, '// 日本語\nconst a = 1\n')
    const items = extract('.')
    expect(items.map((i) => i.file)).toEqual(['src/a.ts'])
  })

  it('splits into small chunks with an index', () => {
    for (let i = 0; i < 6; i++) write(`src/f${i}.ts`, `// ${'説明'.repeat(30)}\nconst a = 1\n`)
    const r = run(CLI, ['extract', '--out', 'chunks', '--chunk-chars', '130', 'src'])
    expect(r.status).toBe(0)
    const files = readdirSync(join(dir, 'chunks')).filter((f) => f !== 'index.json')
    expect(files.length).toBeGreaterThan(1)
    const all = files.flatMap((f) => JSON.parse(read(`chunks/${f}`)))
    expect(all).toHaveLength(6)
    const pf = run(CLI, ['extract', '--out', 'perfile', '--per-file', 'src'])
    expect(pf.status).toBe(0)
    expect(readdirSync(join(dir, 'perfile')).filter((f) => f !== 'index.json')).toHaveLength(6)
    // A directory of chunk files can be given to apply (here only the first chunk is translated).
    const first = JSON.parse(read(`chunks/${files[0]!}`)) as Item[]
    writeFileSync(join(dir, "chunks", files[0]!), JSON.stringify(first.map((i) => ({ ...i, en: '// translated' }))))
    const ap = run(CLI, ['apply', 'chunks'])
    expect(ap.status, ap.stderr).toBe(0)
    expect(JSON.parse(ap.stdout).replaced).toBe(first.length)
  })

  it('stats counts what is left', () => {
    write('src/a.ts', '// 日本語\nconst s = "日本語"\n')
    const r = JSON.parse(run(CLI, ['stats', '--json', 'src']).stdout)
    expect(r.total).toMatchObject({ groups: 1, jaOutsideLines: 1 })
  })
})

describe('lint-comments', () => {
  it('fails on Japanese in a comment only, honours the allow-list', () => {
    write('src/a.ts', 'const s = "日本語"\nconst re = /日本語/\n// English only\n')
    expect(run(LINT, ['src']).status).toBe(0)
    write('src/b.ts', 'const a = 1 // 日本語\n')
    const bad = run(LINT, ['src'])
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('src/b.ts:1')
    writeFileSync(join(dir, 'allow.json'), JSON.stringify([{ file: 'src/b.ts', includes: '日本語' }]))
    expect(run(LINT, ['--allow', 'allow.json', 'src']).status).toBe(0)
    writeFileSync(join(dir, 'allow.json'), JSON.stringify([{ file: 'src/b.ts', includes: 'other' }]))
    expect(run(LINT, ['--allow', 'allow.json', 'src']).status).toBe(1)
  })

  it('also reports directive comments with Japanese', () => {
    write('src/a.ts', '// eslint-disable-next-line no-x -- 理由\nconst a = 1\n')
    expect(run(LINT, ['src']).status).toBe(1)
  })
})

describe('lint-comments: swift / html / svg / plist / escapes', () => {
  const bad = (name: string, text: string) => {
    write(name, text)
    const r = run(LINT, [name.split('/')[0] ?? ''])
    expect(r.status, r.stdout).toBe(1)
    expect(r.stderr).toContain(name + ':')
    rmSync(join(dir, name))
  }
  const ok = (name: string, text: string) => {
    write(name, text)
    const r = run(LINT, [name.split('/')[0] ?? ''])
    expect(r.status, r.stderr).toBe(0)
    rmSync(join(dir, name))
  }

  it('swift: line and block comments are caught, strings are not', () => {
    bad('tools/a.swift', 'let a = 1 // 日本語\n')
    bad('tools/a.swift', '/* 日本語 */\nlet a = 1\n')
    bad('tools/a.swift', '/* outer /* inner */ 日本語 */\nlet a = 1\n')
    ok('tools/a.swift', 'let s = "日本語 // not a comment"\nlet t = "x \\("a") 日本語"\n')
    ok('tools/a.swift', 'let m = """\n  日本語 // here\n  """\nlet r = #"日本語 // raw "# + "x"\n// English\n')
  })

  it('html / svg / plist: only <!-- --> is a comment', () => {
    bad('res/a.html', '<p>x</p>\n<!-- 日本語 -->\n')
    bad('res/a.svg', '<svg><!--\n 日本語\n--></svg>\n')
    bad('res/a.plist', '<?xml version="1.0"?>\n<plist><!-- 日本語 --></plist>\n')
    ok('res/a.html', '<p title="x">日本語</p>\n<!-- English -->\n')
    ok('res/a.svg', '<svg><text>日本語</text></svg>\n')
  })

  it('escaped Japanese in a comment is caught, in a string it is not', () => {
    bad('src/a.ts', '// \\u3053\\u3093\\u306b\\u3061\\u306f\nconst a = 1\n')
    bad('src/a.ts', '/* \\u{65e5}\\u{672c} */\nconst a = 1\n')
    ok('src/a.ts', 'const s = "\\u3053\\u3093"\n// \\u0041 is plain ASCII\n')
  })

  it('the default scan set covers the directories that hold these files', async () => {
    // @ts-expect-error plain .mjs without types
    const { ROOT_DIRS, langOf } = await import('../scripts/lib/comments-core.mjs')
    for (const d of ['tools', 'build', 'resources', 'plugins', 'src']) expect(ROOT_DIRS).toContain(d)
    expect(['a.swift', 'a.html', 'a.svg', 'a.plist'].map(langOf)).toEqual(['swift', 'xml', 'xml', 'xml'])
  })
})

// Security review (wave 92): the translation JSON is written by an agent, so apply must not trust it.
describe('apply: refusals', () => {
  it('refuses a translation that turns a comment into a tool directive', () => {
    write('d.ts', `// 説明\nexport const a: number = 1\n// もう 1 つ\nexport const b = 2\n`)
    const items = extract('d.ts')
    items[0].en = '// @ts-nocheck'
    items[1].en = '// note\n// eslint-disable-next-line no-var'
    const r = apply(items)
    expect(r.status).not.toBe(0)
    expect(r.stat.itemErrors).toBe(2)
    expect(read('d.ts')).toContain('// 説明')
    expect(read('d.ts')).not.toContain('ts-nocheck')
  })
  it('refuses a Python coding declaration', () => {
    write('p.py', `# 説明\nx = 1\n`)
    const items = extract('p.py')
    items[0].en = '# -*- coding: utf-7 -*-'
    const r = apply(items)
    expect(r.status).not.toBe(0)
    expect(read('p.py')).toContain('# 説明')
  })
  it('refuses to write outside the directory it runs in or outside the scan set', () => {
    write('e.ts', `// 説明\nexport const a = 1\n`)
    write('node_modules/x/n.ts', `// 説明\nexport const a = 1\n`)
    const [item] = extract('e.ts')
    const r = apply([
      { ...item, file: '../e.ts', en: '// x' },
      { ...item, file: join(dir, 'e.ts'), en: '// x' },
      { ...item, file: 'node_modules/x/n.ts', en: '// x' }
    ])
    expect(r.status).not.toBe(0)
    expect(r.stat.filesSkipped).toBe(3)
    expect(read('e.ts')).toContain('// 説明')
    expect(read('node_modules/x/n.ts')).toContain('// 説明')
  })
})

// Wave 92 fix X: the directive prefix and heads come from the original source, not from the JSON an agent wrote.
describe('apply: directive translations and malformed items', () => {
  const DIRECTIVE = `// eslint-disable-next-line no-control-regex -- 制御文字\nconst a = /\\x00/\n`
  it('does not trust fixedPrefix from the JSON and refuses a different directive', () => {
    write('a.ts', DIRECTIVE)
    const [item] = extract('a.ts')
    for (const en of ['// @ts-nocheck', '// eslint-disable-next-line no-var -- x', '// eslint-disable-next-line no-control-regex, no-var -- x', '// eslint-disable-next-line no-control-regex x']) {
      const r = apply([{ ...item, fixedPrefix: '', en }])
      expect(r.status, en).not.toBe(0)
      expect(read('a.ts')).toBe(DIRECTIVE)
    }
    expect(apply([{ ...item, fixedPrefix: '', en: '// eslint-disable-next-line no-control-regex -- control character' }]).status).toBe(0)
  })
  it('does not let the explanation add a directive line to a multi-line directive comment', () => {
    write('b.ts', `/** @vitest-environment node\n * 説明 */\nexport const a = 1\n`)
    const [item] = extract('b.ts')
    expect(apply([{ ...item, en: '/** @vitest-environment node\n * @vitest-environment jsdom */' }]).status).not.toBe(0)
    expect(apply([{ ...item, en: '/** @vitest-environment node\n * note */' }]).status).toBe(0)
  })
  it('refuses a line separator or control character in a translation', () => {
    write('c.ts', `// 説明\nexport const a = 1\n`)
    const [item] = extract('c.ts')
    for (const sep of ['\u2028', '\u2029', '\u0085', '\r', '\u0000', '\u000b']) {
      const r = apply([{ ...item, en: `// note${sep}export const a = 2` }])
      expect(r.status, JSON.stringify(sep)).not.toBe(0)
      expect(read('c.ts')).toBe(`// 説明\nexport const a = 1\n`)
    }
  })
  it('a bad item is an item error: the report and the totals are still printed', () => {
    write('d.ts', `/** 説明 */\nexport const a = 1\n// もう 1 つ\nexport const b = 2\n`)
    const [first, second] = extract('d.ts')
    const r = apply([
      { ...first, en: 'not a comment' },
      { ...second, en: 7 },
      { ...second, file: 5, en: '// x' },
      { src: 3 },
      null,
      { ...second, en: '// another one' }
    ])
    expect(r.status).not.toBe(0)
    expect(r.stat).not.toBeNull()
    expect(r.stderr).toContain('block comment must open with')
    expect(read('d.ts')).toContain('// another one')
  })
})

// Security review (wave 92, 4th): no separator = no boundary between rule names and free text.
describe('apply: directive without a separator', () => {
  it('is never rewritten (a translation could extend the rule list)', () => {
    write('s.ts', `// eslint-disable-next-line no-var 理由\nvar a = 1\nexport { a }\n`)
    const items = extract('s.ts')
    items[0].en = '// eslint-disable-next-line no-var no-console reason'
    const r = apply(items)
    expect(r.status).not.toBe(0)
    expect(read('s.ts')).toContain('no-var 理由')
    items[0].en = '// eslint-disable-next-line no-var reason'
    expect(apply(items).status).not.toBe(0)
  })
})

describe('apply: directive with ASCII words between the separator and the Japanese', () => {
  it('translates the reason and keeps the directive', () => {
    write('x.ts', `// eslint-disable-next-line no-control-regex -- XML 1.0 に書けない文字\nexport const re = /\\u0000/\n`)
    const items = extract('x.ts')
    items[0].en = '// eslint-disable-next-line no-control-regex -- characters XML 1.0 cannot carry'
    expect(apply(items).status).toBe(0)
    expect(read('x.ts')).toContain('-- characters XML 1.0 cannot carry')
    write('y.ts', `// eslint-disable-next-line no-control-regex -- XML 1.0 に書けない文字\nexport const re = /\\u0000/\n`)
    const bad = extract('y.ts')
    bad[0].en = '// eslint-disable-next-line no-control-regex, no-var -- reason'
    expect(apply(bad).status).not.toBe(0)
  })
})

// Security review (wave 94): swift / xml have no independent check of the hand-written lexer, so `apply` never writes them.
describe('apply: swift and xml are lint-only', () => {
  it('skips them even when the item matches a comment', () => {
    const swift = `// 説明\nlet a = 1\n`
    const plist = `<!-- 説明 -->\n<plist><dict/></plist>\n`
    write('tools/a.swift', swift)
    write('build/a.plist', plist)
    const r = apply([
      { file: 'tools/a.swift', src: '// 説明', en: '// note' },
      { file: 'build/a.plist', src: '<!-- 説明 -->', en: '<!-- note -->' }
    ])
    expect(r.stdout + r.stderr).toContain('lint only')
    expect(read('tools/a.swift')).toBe(swift)
    expect(read('build/a.plist')).toBe(plist)
  })
})
