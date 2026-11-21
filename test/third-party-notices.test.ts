/**
 * TODO 438 (wave 22 bundle G): the 'third-party material licenses' in Settings' About are built from one place, `THIRD_PARTY_NOTICES.md` (they are not kept twice).
 *
 * - How `parseThirdPartyNotices` (`src/shared/third-party-notices.ts`) splits headings and takes license names
 * - The number of headings in `THIRD_PARTY_NOTICES.md` matches the number of parsed entries (the number of rows in About's collapsed view is this number)
 * - `BuildInfoSection.tsx` has no Seti-specific table and shows the list through `thirdPartyNotices()`
 * - No heading is missing for libraries that plugins bundle (the ones that need a license among aios.pdf's vendor.json and the allowedBarePackages in plugin-boundaries.json)
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  localizedHeading,
  metaBody,
  noticesForExtension,
  parseInlineMarkdown,
  parseThirdPartyNotices
} from '../src/shared/third-party-notices.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8')

describe('parseThirdPartyNotices (純関数)', () => {
  const sample = `# 見出し

## alpha (alpha-pkg 1.0.0) — 説明

- 版: 1.0.0
- ライセンス: MIT
- 使う場所: テスト

\`\`\`text
Copyright (c) 2020 Alpha
Permission is hereby granted...
\`\`\`

## beta

- 許諾: BSD-2-Clause

\`\`\`
Copyright (c) 2021 Beta
\`\`\`

## gamma (no license line, no code block)
`

  it('見出し (## ) ごとに分ける', () => {
    const notices = parseThirdPartyNotices(sample)
    expect(notices).toHaveLength(3)
    expect(notices.map((n) => n.heading)).toEqual(['alpha (alpha-pkg 1.0.0) — 説明', 'beta', 'gamma (no license line, no code block)'])
  })

  it('「- ライセンス:」「- 許諾:」の行からライセンス名を取る', () => {
    const [alpha, beta] = parseThirdPartyNotices(sample)
    expect(alpha?.license).toBe('MIT')
    expect(beta?.license).toBe('BSD-2-Clause')
  })

  it('ライセンス行が無ければ全文 (fenced code block) の先頭行に落ちる', () => {
    const [, beta] = parseThirdPartyNotices(sample)
    expect(beta?.text.split('\n')[0]).toBe('Copyright (c) 2021 Beta')
  })

  it('ライセンス行も code block も無ければ空文字列 (落ちない)', () => {
    const [, , gamma] = parseThirdPartyNotices(sample)
    expect(gamma?.license).toBe('')
    expect(gamma?.text).toBe('')
  })

  it('fenced code block の中身を全文として取る', () => {
    const [alpha] = parseThirdPartyNotices(sample)
    expect(alpha?.text).toContain('Copyright (c) 2020 Alpha')
    expect(alpha?.text).not.toContain('```')
  })

  it('CRLF でも同じ結果になる', () => {
    const crlf = sample.replace(/\n/g, '\r\n')
    expect(parseThirdPartyNotices(crlf)).toEqual(parseThirdPartyNotices(sample))
  })

  it('見出しが無ければ空の一覧', () => {
    expect(parseThirdPartyNotices('見出しの無い本文')).toEqual([])
  })

  it('455-1: 字下げの続きの行は直前の説明行に繋ぎ、ライセンス名は「。」の前まで、全文の中の箇条書きは拾わない', () => {
    const md = `## delta
- 許諾: Apache License 2.0 (Copyright X)。同梱の字形と、
  wasm は各自の許諾に従う。
- 使う場所: one
  two

\`\`\`
- not meta
\`\`\`
`
    const [delta] = parseThirdPartyNotices(md)
    expect(delta?.license).toBe('Apache License 2.0 (Copyright X)')
    expect(delta?.meta).toEqual([
      '- 許諾: Apache License 2.0 (Copyright X)。同梱の字形と、wasm は各自の許諾に従う。',
      '- 使う場所: one two'
    ])
  })
})

describe('TODO 622: 見出しの英語版 (- English: の行)', () => {
  const md = `## alpha (alpha-pkg 1.0.0) — 説明

- English: alpha (alpha-pkg 1.0.0) — the description
- ライセンス: MIT
- 使う場所: テスト

\`\`\`text
Copyright (c) 2020 Alpha
\`\`\`

## beta

- ライセンス: MIT
`

  it('- English: の行から headingEn を取り、説明の箇条書きからは外す', () => {
    const [alpha, beta] = parseThirdPartyNotices(md)
    expect(alpha?.headingEn).toBe('alpha (alpha-pkg 1.0.0) — the description')
    expect(alpha?.meta.some((line) => line.startsWith('- English:'))).toBe(false)
    expect(alpha?.meta).toEqual(['- ライセンス: MIT', '- 使う場所: テスト'])
    // If there is no row, it falls back to the Japanese heading as is.
    expect(beta?.headingEn).toBe('beta')
  })

  it('localizedHeading: en なら headingEn、ja なら heading', () => {
    const [alpha] = parseThirdPartyNotices(md)
    if (alpha === undefined) throw new Error('alpha missing')
    expect(localizedHeading(alpha, 'en')).toBe('alpha (alpha-pkg 1.0.0) — the description')
    expect(localizedHeading(alpha, 'ja')).toBe('alpha (alpha-pkg 1.0.0) — 説明')
  })

  it('実物: 日本語を含む見出しは全部 - English: の行を持つ (EN 表示で日本語が残らない)', () => {
    const notices = parseThirdPartyNotices(read('THIRD_PARTY_NOTICES.md'))
    const hasJapanese = (text: string): boolean => /[぀-ヿ一-鿿]/.test(text)
    for (const notice of notices) {
      if (hasJapanese(notice.heading)) {
        expect(hasJapanese(notice.headingEn), notice.heading).toBe(false)
      }
    }
  })
})

describe('使う拡張 (TODO 459、拡張ごとに同梱ライブラリを引く)', () => {
  const md = `## a
- ライセンス: MIT
- 使う拡張: \`aios.text\` / \`aios.markdown\` (本体にも)

\`\`\`
x
\`\`\`

## b
- 使う拡張: なし (本体だけ)

## c
- ライセンス: MIT
`

  it('「- 使う拡張:」の行の `id` を並べる。「なし」や行が無ければ空', () => {
    const [a, b, c] = parseThirdPartyNotices(md)
    expect(a?.extensions).toEqual(['aios.text', 'aios.markdown'])
    expect(b?.extensions).toEqual([])
    expect(c?.extensions).toEqual([])
  })

  it('noticesForExtension はその拡張の分だけをファイルの順で返す', () => {
    const notices = parseThirdPartyNotices(md)
    expect(noticesForExtension(notices, 'aios.markdown').map((n) => n.heading)).toEqual(['a'])
    expect(noticesForExtension(notices, 'aios.image')).toEqual([])
  })

  const notices = parseThirdPartyNotices(read('THIRD_PARTY_NOTICES.md'))
  const ids = (id: string): string[] => noticesForExtension(notices, id).map((n) => n.heading.split(' ')[0] ?? '')

  it('実物: 全部の見出しが「- 使う拡張:」の行を持ち、挙げた id は全部 plugins/<id>/manifest.json がある', () => {
    for (const notice of notices) {
      expect(notice.meta.some((line) => line.startsWith('- 使う拡張:')), notice.heading).toBe(true)
      for (const id of notice.extensions) expect(existsSync(join(repoRoot, 'plugins', id, 'manifest.json')), id).toBe(true)
    }
  })

  it('実物: 拡張ごとの同梱ライブラリ (bundle の中身と揃っている)', () => {
    expect(ids('aios.pdf')).toEqual(['pdf.js'])
    expect(ids('aios.office')).toEqual(expect.arrayContaining(['mammoth', 'fflate', 'dompurify', 'jszip', 'pako', '@xmldom/xmldom']))
    expect(ids('aios.office')).not.toContain('CodeMirror')
    expect(ids('aios.markdown')).toEqual(
      expect.arrayContaining(['dompurify', 'CodeMirror', 'Lezer', 'markdown-it', 'highlight.js', 'style-mod'])
    )
    expect(ids('aios.text')).toEqual(['CodeMirror', 'Lezer', 'style-mod', 'w3c-keyname', 'crelt', '@marijn/find-cluster-break'])
    expect(ids('aios.diff')).toContain('CodeMirror')
    expect(ids('aios.html')).toEqual(expect.arrayContaining(['dompurify', 'CodeMirror']))
    // An extension with no bundled library.
    expect(ids('aios.image')).toEqual([])
    expect(ids('aios.video')).toEqual([])
    // Seti is the main app only.
    expect(notices.find((n) => n.heading.startsWith('Seti'))?.extensions).toEqual([])
  })
})

describe('THIRD_PARTY_NOTICES.md 自体', () => {
  const noticesText = read('THIRD_PARTY_NOTICES.md')
  const notices = parseThirdPartyNotices(noticesText)
  const headingCount = (noticesText.match(/^## /gm) ?? []).length

  it('見出しの数と parse した一覧の数が一致する (About の折りたたみの行数はこの数)', () => {
    expect(headingCount).toBeGreaterThan(0)
    expect(notices).toHaveLength(headingCount)
  })

  it('全部の見出しがライセンス名か全文のどちらかを持つ (空の節が無い)', () => {
    for (const notice of notices) {
      expect(notice.license !== '' || notice.text !== '').toBe(true)
    }
  })

  it('aios.pdf/vendor.json が指す pdfjs-dist の見出しがある', () => {
    const vendor = JSON.parse(read('plugins/aios.pdf/vendor.json')) as { readonly copy: ReadonlyArray<{ readonly from: string }> }
    const packages = new Set(vendor.copy.map((entry) => entry.from.split('/')[0]))
    expect(packages).toContain('pdfjs-dist')
    expect(noticesText).toContain('pdfjs-dist')
  })

  it('plugin-boundaries.json の allowedBarePackages のうち許諾が要るライブラリに見出しがある (足し忘れを防ぐ)', () => {
    const boundaries = JSON.parse(read('scripts/plugin-boundaries.json')) as {
      readonly allowedBarePackages: readonly string[]
    }
    // The entries added in TODO 405 / 438, and CodeMirror / Lezer from TODO 453.
    const requiresNotice = [
      'mammoth',
      'fflate',
      'dompurify',
      'pdfjs-dist',
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/commands',
      '@codemirror/language',
      '@codemirror/language-data',
      '@codemirror/search',
      '@codemirror/merge',
      '@lezer/highlight'
    ]
    for (const pkg of requiresNotice) {
      expect(boundaries.allowedBarePackages).toContain(pkg)
      // The families (`@codemirror/*` / `@lezer/*`) are grouped under one heading (TODO 453), so a heading with `@scope/*` is enough.
      const scope = pkg.startsWith('@') ? `${pkg.split('/')[0]}/*` : null
      const lower = noticesText.toLowerCase()
      expect(lower.includes(pkg.toLowerCase()) || (scope !== null && lower.includes(scope))).toBe(true)
    }
    // The reverse: all of allowedBarePackages are in the 'needs a notice' list (prevents adding a package and forgetting its license).
    expect([...boundaries.allowedBarePackages].sort()).toEqual([...requiresNotice].sort())
  })

  it('TODO 453: CodeMirror / Lezer と、view / state の依存 (style-mod / w3c-keyname / crelt / find-cluster-break) の見出しがある', () => {
    const headings = notices.map((notice) => notice.heading)
    expect(headings.some((h) => h.startsWith('CodeMirror 6'))).toBe(true)
    expect(headings.some((h) => h.startsWith('Lezer'))).toBe(true)
    for (const name of ['style-mod', 'w3c-keyname', 'crelt', '@marijn/find-cluster-break']) expect(headings).toContain(name)
    for (const notice of notices.filter((n) => /CodeMirror|Lezer|style-mod|w3c-keyname|crelt|find-cluster/.test(n.heading))) {
      expect(notice.license).toBe('MIT')
      expect(notice.text).toContain('Marijn Haverbeke')
    }
  })

  it('許諾の全文に合流の印と紛れる行 (`=======` で始まる行) を新たに足さない (jszip の既存の 1 行だけ)', () => {
    const offenders = notices.filter((notice) => /^={7}/m.test(notice.text)).map((notice) => notice.heading)
    expect(offenders).toEqual(['jszip'])
  })
})

describe('parseInlineMarkdown / metaBody (TODO 453、見出しと説明行の記号を生のまま見せない)', () => {
  it('code / 太字 / リンクを分け、残りは文字', () => {
    expect(parseInlineMarkdown('使う場所: `aios.office` の **bundle** と [pdf.js](https://example.test/x)。')).toEqual([
      { kind: 'text', text: '使う場所: ' },
      { kind: 'code', text: 'aios.office' },
      { kind: 'text', text: ' の ' },
      { kind: 'strong', text: 'bundle' },
      { kind: 'text', text: ' と ' },
      { kind: 'link', text: 'pdf.js', href: 'https://example.test/x' },
      { kind: 'text', text: '。' }
    ])
  })

  it('閉じていない記号はそのまま文字。記号が無ければ 1 つの文字', () => {
    expect(parseInlineMarkdown('a `b **c')).toEqual([{ kind: 'text', text: 'a `b **c' }])
    expect(parseInlineMarkdown('MIT')).toEqual([{ kind: 'text', text: 'MIT' }])
    expect(parseInlineMarkdown('')).toEqual([])
  })

  it('metaBody は頭の「- 」だけを落とす', () => {
    expect(metaBody('- 版: 1.0.0')).toBe('版: 1.0.0')
    expect(metaBody('版 - 1')).toBe('版 - 1')
  })

  it('実物の説明行を描くと生の ` と ** が残らない', () => {
    for (const notice of parseThirdPartyNotices(read('THIRD_PARTY_NOTICES.md'))) {
      for (const line of [notice.heading, ...notice.meta.map(metaBody)]) {
        const plain = parseInlineMarkdown(line)
          .filter((span) => span.kind === 'text')
          .map((span) => span.text)
          .join('')
        expect(plain).not.toContain('`')
        expect(plain).not.toContain('**')
      }
    }
  })
})

describe('本体 (renderer / main / gateway) が使うライブラリの見出し (TODO 470)', () => {
  const noticesText = read('THIRD_PARTY_NOTICES.md')
  const notices = parseThirdPartyNotices(noticesText)
  const lower = noticesText.toLowerCase()
  const pkg = JSON.parse(read('package.json')) as {
    readonly dependencies: Record<string, string>
    readonly devDependencies: Record<string, string>
  }

  // Every entry in `dependencies` of `package.json` (it goes into the node_modules of the distributed build as is, TODO 492) needs a heading.
  // `@codemirror/search` is a family also used in plugins/_shared, and the 'CodeMirror 6' heading from TODO 453 already covers it.
  it('package.json の dependencies 全部に見出しがある', () => {
    for (const name of Object.keys(pkg.dependencies)) {
      const scope = name.startsWith('@') ? `${name.split('/')[0]}/*` : null
      expect(lower.includes(name.toLowerCase()) || (scope !== null && lower.includes(scope)), name).toBe(true)
    }
  })

  // Of the devDependencies, the ones that actually go into the out/ bundle, not build tools (vite / eslint / typescript / type definitions, ...). The plugin-only ones (dompurify / markdown-it / highlight.js / mammoth / fflate / pdfjs-dist / CodeMirror / the Lezer family) are already checked for headings by the 'extensions that use it' test above, so this only adds what the main app alone brings in.
  const mainOnlyBundled = ['react', 'react-dom', 'zustand', '@tanstack/react-virtual']

  it('本体だけが bundle に入れる devDependencies に見出しがある', () => {
    for (const name of mainOnlyBundled) {
      expect(Object.keys(pkg.devDependencies), name).toContain(name)
      expect(lower.includes(name.toLowerCase()), name).toBe(true)
    }
  })

  it('React (react / react-dom / scheduler) は 1 見出しにまとめてあり、「使う拡張」は「なし (本体)」', () => {
    const notice = notices.find((n) => n.heading.startsWith('React ('))
    expect(notice).toBeDefined()
    expect(notice?.extensions).toEqual([])
    expect(notice?.heading).toContain('scheduler')
  })

  it('zustand / @tanstack/react-virtual は「使う拡張」が「なし (本体)」', () => {
    for (const name of ['zustand', '@tanstack/react-virtual']) {
      const notice = notices.find((n) => n.heading === name)
      expect(notice, name).toBeDefined()
      expect(notice?.extensions).toEqual([])
    }
  })

  it('kuromoji / better-sqlite3-multiple-ciphers / zod / @parcel/watcher / @modelcontextprotocol/sdk の見出しがあり、本体専用', () => {
    const headings = ['kuromoji', 'better-sqlite3-multiple-ciphers', 'zod', '@parcel/watcher', '@modelcontextprotocol/sdk']
    for (const name of headings) {
      const notice = notices.find((n) => n.heading.toLowerCase().startsWith(name.toLowerCase()))
      expect(notice, name).toBeDefined()
      expect(notice?.extensions, name).toEqual([])
    }
  })

  it('Electron 本体 (Chromium / Node.js を含む) の見出しがあり、node_modules/electron の版と揃っている', () => {
    const notice = notices.find((n) => n.heading.startsWith('Electron ('))
    expect(notice).toBeDefined()
    expect(notice?.extensions).toEqual([])
    const electronPkg = JSON.parse(read('node_modules/electron/package.json')) as { readonly version: string }
    expect(notice?.meta.some((line) => line.includes(electronPkg.version))).toBe(true)
  })
})

describe('BuildInfoSection は THIRD_PARTY_NOTICES.md の 1 か所から組み立てる (二重に持たない)', () => {
  const source = read('src/renderer/src/components/BuildInfoSection.tsx')

  it('Seti 専用の表 (seti-ui-license.ts) をもう import しない', () => {
    expect(source).not.toContain('seti-ui-license')
    expect(source).not.toContain('SETI_UI_NOTICE')
  })

  it('thirdPartyNotices() の一覧を map で出す', () => {
    expect(source).toContain('thirdPartyNotices()')
    expect(source).toMatch(/thirdPartyNotices\(\)\.map\(/)
  })

  it('TODO 453: 見出しに「License」「ライセンス」の殻を足さない (ライセンス名と重なる) / 記号は InlineMarkdown で描く', () => {
    expect(source).not.toContain('build.notices.entry')
    expect(source).toContain('metaBody(line)')
  })

  it('TODO 622: 見出しは localizedHeading (EN では日本語でなく英語) を通す', () => {
    expect(source).toContain('localizedHeading(notice, locale)')
  })
})
