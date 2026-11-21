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

describe('parseThirdPartyNotices (pure function)', () => {
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

  it('splits by heading (## )', () => {
    const notices = parseThirdPartyNotices(sample)
    expect(notices).toHaveLength(3)
    expect(notices.map((n) => n.heading)).toEqual(['alpha (alpha-pkg 1.0.0) — 説明', 'beta', 'gamma (no license line, no code block)'])
  })

  it('takes the license name from the 「- ライセンス:」 and 「- 許諾:」 lines', () => {
    const [alpha, beta] = parseThirdPartyNotices(sample)
    expect(alpha?.license).toBe('MIT')
    expect(beta?.license).toBe('BSD-2-Clause')
  })

  it('falls back to the first line of the full text (fenced code block) when there is no license line', () => {
    const [, beta] = parseThirdPartyNotices(sample)
    expect(beta?.text.split('\n')[0]).toBe('Copyright (c) 2021 Beta')
  })

  it('returns an empty string (does not fail) when there is neither a license line nor a code block', () => {
    const [, , gamma] = parseThirdPartyNotices(sample)
    expect(gamma?.license).toBe('')
    expect(gamma?.text).toBe('')
  })

  it('takes the content of the fenced code block as the full text', () => {
    const [alpha] = parseThirdPartyNotices(sample)
    expect(alpha?.text).toContain('Copyright (c) 2020 Alpha')
    expect(alpha?.text).not.toContain('```')
  })

  it('gives the same result with CRLF', () => {
    const crlf = sample.replace(/\n/g, '\r\n')
    expect(parseThirdPartyNotices(crlf)).toEqual(parseThirdPartyNotices(sample))
  })

  it('gives an empty list when there is no heading', () => {
    expect(parseThirdPartyNotices('見出しの無い本文')).toEqual([])
  })

  it('455-1: an indented continuation line joins the previous description line, the license name ends before 「。」, and bullets inside the full text are not picked up', () => {
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

describe('TODO 622: English version of the heading (the - English: line)', () => {
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

  it('takes headingEn from the - English: line and removes it from the description bullets', () => {
    const [alpha, beta] = parseThirdPartyNotices(md)
    expect(alpha?.headingEn).toBe('alpha (alpha-pkg 1.0.0) — the description')
    expect(alpha?.meta.some((line) => line.startsWith('- English:'))).toBe(false)
    expect(alpha?.meta).toEqual(['- ライセンス: MIT', '- 使う場所: テスト'])
    // If there is no row, it falls back to the Japanese heading as is.
    expect(beta?.headingEn).toBe('beta')
  })

  it('localizedHeading: headingEn for en, heading for ja', () => {
    const [alpha] = parseThirdPartyNotices(md)
    if (alpha === undefined) throw new Error('alpha missing')
    expect(localizedHeading(alpha, 'en')).toBe('alpha (alpha-pkg 1.0.0) — the description')
    expect(localizedHeading(alpha, 'ja')).toBe('alpha (alpha-pkg 1.0.0) — 説明')
  })

  it('real file: every heading containing Japanese has a - English: line (no Japanese remains in EN display)', () => {
    const notices = parseThirdPartyNotices(read('THIRD_PARTY_NOTICES.md'))
    const hasJapanese = (text: string): boolean => /[぀-ヿ一-鿿]/.test(text)
    for (const notice of notices) {
      if (hasJapanese(notice.heading)) {
        expect(hasJapanese(notice.headingEn), notice.heading).toBe(false)
      }
    }
  })
})

describe('used extensions (TODO 459, bundled libraries looked up per extension)', () => {
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

  it('lists the `id`s of the 「- 使う拡張:」 line, and gives empty for 「なし」 or when there is no line', () => {
    const [a, b, c] = parseThirdPartyNotices(md)
    expect(a?.extensions).toEqual(['aios.text', 'aios.markdown'])
    expect(b?.extensions).toEqual([])
    expect(c?.extensions).toEqual([])
  })

  it("noticesForExtension returns only that extension's entries in file order", () => {
    const notices = parseThirdPartyNotices(md)
    expect(noticesForExtension(notices, 'aios.markdown').map((n) => n.heading)).toEqual(['a'])
    expect(noticesForExtension(notices, 'aios.image')).toEqual([])
  })

  const notices = parseThirdPartyNotices(read('THIRD_PARTY_NOTICES.md'))
  const ids = (id: string): string[] => noticesForExtension(notices, id).map((n) => n.heading.split(' ')[0] ?? '')

  it('real file: every heading has a 「- 使う拡張:」 line, and every id it names has plugins/<id>/manifest.json', () => {
    for (const notice of notices) {
      expect(notice.meta.some((line) => line.startsWith('- 使う拡張:')), notice.heading).toBe(true)
      for (const id of notice.extensions) expect(existsSync(join(repoRoot, 'plugins', id, 'manifest.json')), id).toBe(true)
    }
  })

  it('real file: bundled libraries per extension (consistent with the bundle contents)', () => {
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

describe('THIRD_PARTY_NOTICES.md itself', () => {
  const noticesText = read('THIRD_PARTY_NOTICES.md')
  const notices = parseThirdPartyNotices(noticesText)
  const headingCount = (noticesText.match(/^## /gm) ?? []).length

  it('the number of headings equals the number of parsed entries (the number of rows in the About fold)', () => {
    expect(headingCount).toBeGreaterThan(0)
    expect(notices).toHaveLength(headingCount)
  })

  it('every heading has either a license name or a full text (no empty section)', () => {
    for (const notice of notices) {
      expect(notice.license !== '' || notice.text !== '').toBe(true)
    }
  })

  it('has the heading of pdfjs-dist that aios.pdf/vendor.json points to', () => {
    const vendor = JSON.parse(read('plugins/aios.pdf/vendor.json')) as { readonly copy: ReadonlyArray<{ readonly from: string }> }
    const packages = new Set(vendor.copy.map((entry) => entry.from.split('/')[0]))
    expect(packages).toContain('pdfjs-dist')
    expect(noticesText).toContain('pdfjs-dist')
  })

  it('libraries in allowedBarePackages of plugin-boundaries.json that need a license have a heading (prevents forgetting to add one)', () => {
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

  it('TODO 453: has headings for CodeMirror / Lezer and the view / state dependencies (style-mod / w3c-keyname / crelt / find-cluster-break)', () => {
    const headings = notices.map((notice) => notice.heading)
    expect(headings.some((h) => h.startsWith('CodeMirror 6'))).toBe(true)
    expect(headings.some((h) => h.startsWith('Lezer'))).toBe(true)
    for (const name of ['style-mod', 'w3c-keyname', 'crelt', '@marijn/find-cluster-break']) expect(headings).toContain(name)
    for (const notice of notices.filter((n) => /CodeMirror|Lezer|style-mod|w3c-keyname|crelt|find-cluster/.test(n.heading))) {
      expect(notice.license).toBe('MIT')
      expect(notice.text).toContain('Marijn Haverbeke')
    }
  })

  it('does not newly add a line that could be mistaken for a merge marker (a line starting with `=======`) to a license text (only the existing 1 line of jszip)', () => {
    const offenders = notices.filter((notice) => /^={7}/m.test(notice.text)).map((notice) => notice.heading)
    expect(offenders).toEqual(['jszip'])
  })
})

describe('parseInlineMarkdown / metaBody (TODO 453, do not show heading and description markers raw)', () => {
  it('splits code / bold / link and leaves the rest as text', () => {
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

  it('an unclosed marker stays as text, and no marker gives a single text', () => {
    expect(parseInlineMarkdown('a `b **c')).toEqual([{ kind: 'text', text: 'a `b **c' }])
    expect(parseInlineMarkdown('MIT')).toEqual([{ kind: 'text', text: 'MIT' }])
    expect(parseInlineMarkdown('')).toEqual([])
  })

  it('metaBody drops only the leading 「- 」', () => {
    expect(metaBody('- 版: 1.0.0')).toBe('版: 1.0.0')
    expect(metaBody('版 - 1')).toBe('版 - 1')
  })

  it('rendering real description lines leaves no raw ` or **', () => {
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

describe('headings of libraries used by the core (renderer / main / gateway) (TODO 470)', () => {
  const noticesText = read('THIRD_PARTY_NOTICES.md')
  const notices = parseThirdPartyNotices(noticesText)
  const lower = noticesText.toLowerCase()
  const pkg = JSON.parse(read('package.json')) as {
    readonly dependencies: Record<string, string>
    readonly devDependencies: Record<string, string>
  }

  // Every entry in `dependencies` of `package.json` (it goes into the node_modules of the distributed build as is, TODO 492) needs a heading.
  // `@codemirror/search` is a family also used in plugins/_shared, and the 'CodeMirror 6' heading from TODO 453 already covers it.
  it('every dependency in package.json has a heading', () => {
    for (const name of Object.keys(pkg.dependencies)) {
      const scope = name.startsWith('@') ? `${name.split('/')[0]}/*` : null
      expect(lower.includes(name.toLowerCase()) || (scope !== null && lower.includes(scope)), name).toBe(true)
    }
  })

  // Of the devDependencies, the ones that actually go into the out/ bundle, not build tools (vite / eslint / typescript / type definitions, ...). The plugin-only ones (dompurify / markdown-it / highlight.js / mammoth / fflate / pdfjs-dist / CodeMirror / the Lezer family) are already checked for headings by the 'extensions that use it' test above, so this only adds what the main app alone brings in.
  const mainOnlyBundled = ['react', 'react-dom', 'zustand', '@tanstack/react-virtual']

  it('devDependencies that only the core bundles have a heading', () => {
    for (const name of mainOnlyBundled) {
      expect(Object.keys(pkg.devDependencies), name).toContain(name)
      expect(lower.includes(name.toLowerCase()), name).toBe(true)
    }
  })

  it('React (react / react-dom / scheduler) is grouped into one heading, and 「使う拡張」 is 「なし (本体)」', () => {
    const notice = notices.find((n) => n.heading.startsWith('React ('))
    expect(notice).toBeDefined()
    expect(notice?.extensions).toEqual([])
    expect(notice?.heading).toContain('scheduler')
  })

  it('zustand / @tanstack/react-virtual have 「使う拡張」 as 「なし (本体)」', () => {
    for (const name of ['zustand', '@tanstack/react-virtual']) {
      const notice = notices.find((n) => n.heading === name)
      expect(notice, name).toBeDefined()
      expect(notice?.extensions).toEqual([])
    }
  })

  it('kuromoji / better-sqlite3-multiple-ciphers / zod / @parcel/watcher / @modelcontextprotocol/sdk have headings and are core-only', () => {
    const headings = ['kuromoji', 'better-sqlite3-multiple-ciphers', 'zod', '@parcel/watcher', '@modelcontextprotocol/sdk']
    for (const name of headings) {
      const notice = notices.find((n) => n.heading.toLowerCase().startsWith(name.toLowerCase()))
      expect(notice, name).toBeDefined()
      expect(notice?.extensions, name).toEqual([])
    }
  })

  it('has a heading for Electron itself (including Chromium / Node.js), consistent with the version in node_modules/electron', () => {
    const notice = notices.find((n) => n.heading.startsWith('Electron ('))
    expect(notice).toBeDefined()
    expect(notice?.extensions).toEqual([])
    const electronPkg = JSON.parse(read('node_modules/electron/package.json')) as { readonly version: string }
    expect(notice?.meta.some((line) => line.includes(electronPkg.version))).toBe(true)
  })
})

describe('BuildInfoSection is built from a single place, THIRD_PARTY_NOTICES.md (no duplicate copy)', () => {
  const source = read('src/renderer/src/components/BuildInfoSection.tsx')

  it('no longer imports the Seti-only table (seti-ui-license.ts)', () => {
    expect(source).not.toContain('seti-ui-license')
    expect(source).not.toContain('SETI_UI_NOTICE')
  })

  it('renders the thirdPartyNotices() list with map', () => {
    expect(source).toContain('thirdPartyNotices()')
    expect(source).toMatch(/thirdPartyNotices\(\)\.map\(/)
  })

  it('TODO 453: does not add 「License」 or 「ライセンス」 shells to headings (they overlap the license name) / markers are drawn with InlineMarkdown', () => {
    expect(source).not.toContain('build.notices.entry')
    expect(source).toContain('metaBody(line)')
  })

  it('TODO 622: headings go through localizedHeading (English in EN, not Japanese)', () => {
    expect(source).toContain('localizedHeading(notice, locale)')
  })
})
