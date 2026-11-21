/**
 * Syntax highlighting for code blocks (ARCHITECTURE.md 5.1.2, TODO 7 / T6).
 *
 * Passed to markdown-it in `render.ts` as `highlight(code, lang)`.
 * It applies the same way to ThreadPane and `aios.markdown` (5.1, "do not keep two systems").
 *
 * The highlighter is **highlight.js with each language imported individually**. Three candidates
 * (`@lezer/highlight` + the `@lezer/*` parsers, highlight.js, shiki) were measured on 10 representative languages;
 * this one has the smallest bundle increase (132 kB, 1/4 of lezer, 1/13 of shiki),
 * and it can also handle bash on the same path (lezer has no bash parser, and running legacy-modes
 * through `StreamLanguage` would add +450 kB including `@codemirror/view`).
 * The table is in ARCHITECTURE.md 5.1.2.
 *
 * Rules:
 * - **An unknown language returns ''** (markdown-it takes '' as "not handled" and
 *   escapes it itself). It does not throw. A fence with no language is not auto-detected.
 * - The output attribute is **`data-hl`** (hljs's scope name), not `class`. Without relying on DOMPurify
 *   allowing `class`, CSS (`styles.css` / `viewer.css`) selects by attribute, as in
 *   `pre code [data-hl~="keyword"]`.
 * - This module has no privileges. It takes a string and returns a string.
 */
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import go from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import typescript from 'highlight.js/lib/languages/typescript'

/** The registered languages (canonical name -> highlight.js definition). To add one, only this and the alias table below. */
const LANGUAGES = {
  python,
  c,
  cpp,
  typescript,
  javascript,
  bash,
  json,
  rust,
  go,
  markdown
} as const

export type HighlightLanguage = keyof typeof LANGUAGES

export const HIGHLIGHT_LANGUAGES = Object.keys(LANGUAGES) as readonly HighlightLanguage[]

/** Aliases for the language of a fence. Looked up in lower case. */
const ALIASES: ReadonlyMap<string, HighlightLanguage> = new Map<string, HighlightLanguage>([
  ['py', 'python'],
  ['python3', 'python'],
  ['py3', 'python'],
  ['h', 'c'],
  ['c++', 'cpp'],
  ['cc', 'cpp'],
  ['cxx', 'cpp'],
  ['hpp', 'cpp'],
  ['hh', 'cpp'],
  ['hxx', 'cpp'],
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['js', 'javascript'],
  ['jsx', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['node', 'javascript'],
  ['sh', 'bash'],
  ['zsh', 'bash'],
  ['shell', 'bash'],
  ['jsonc', 'json'],
  ['json5', 'json'],
  ['rs', 'rust'],
  ['golang', 'go'],
  ['md', 'markdown'],
  ['mkd', 'markdown'],
  ['mkdown', 'markdown']
])

const CANONICAL: ReadonlyMap<string, HighlightLanguage> = new Map(
  HIGHLIGHT_LANGUAGES.map((name) => [name, name])
)

for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition)
// Make it emit the scope names as is; below, `class` is replaced by `data-hl`.
hljs.configure({ classPrefix: '' })

/**
 * Determines the language from a fence's info string (```` ```python title=x ````).
 * Only the first word is looked at, and null if it matches neither a canonical name nor an alias.
 * It is looked up in a `Map`, so names like `constructor` / `toString` can never match by mistake.
 */
export function resolveLanguage(info: string): HighlightLanguage | null {
  const name = info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ''
  if (name === '') return null
  return CANONICAL.get(name) ?? ALIASES.get(name) ?? null
}

/**
 * Returns the highlighted HTML (text is escaped and wrapped in `<span data-hl="…">`).
 * For an unknown language, or when hljs throws, '' - markdown-it then only escapes it and passes it through.
 *
 * The replacement `<span class="` -> `<span data-hl="` is safe because hljs always turns `<` in the code body
 * into `&lt;`, so a string coming from the code can never become `<span class="`
 * (test/markdown.test.ts checks this).
 */
export function highlightCode(code: string, info: string): string {
  const language = resolveLanguage(info)
  if (language === null) return ''
  try {
    const { value } = hljs.highlight(code, { language, ignoreIllegals: true })
    return value.replace(/<span class="/g, '<span data-hl="')
  } catch {
    return ''
  }
}
