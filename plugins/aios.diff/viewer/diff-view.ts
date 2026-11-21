/**
 * Rendering of `aios.diff` (ARCHITECTURE.md 7.4.6, item 104).
 *
 * Shows the two sides (before / after) passed by the host with `@codemirror/merge`. **Read only** -
 * no editing and no partial acceptance (no per-chunk accept / reject buttons).
 *
 *   - single column (unified, the default): the after text is the body, and removed lines are inserted above (`unifiedMergeView`)
 *   - side by side (split): before on the left, after on the right (`MergeView`)
 *   - if either side exceeds `MAX_DIFF_BYTES`, the diff is not computed and the two sides are simply placed next to each other (plain)
 *
 * Colors use only `--diff-*` from viewer.css (7.4.1). The default theme of `@codemirror/merge` has
 * hard-coded colors, so they are overridden by raising specificity under `.diff-view` (viewer.css).
 *
 * DOM assembly is gathered here, and main.ts just receives from the bridge and calls it.
 * Thanks to this, the whole thing can be tested in jsdom without a bridge (test/diff-viewer.test.ts).
 */
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { syntaxHighlighting } from '@codemirror/language'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { exceedsDiffLimit, type DiffLayout, type DiffSide } from '@shared/plugin.js'
import type { Theme } from '@shared/theme.js'
import { editorTheme, findLanguage, highlightStyle } from '../../_shared/editor.js'
import { readOnlyExtras } from '../../_shared/editor-extras.js'
import { vt, viewerLocale } from '../../_shared/i18n.js'

export type { DiffLayout }

/** The shape of the arriving diff used to decide the layout (the needed part of `DiffPayload`). */
export interface DiffLayoutSource {
  readonly before: DiffSide
  readonly after: DiffSide
  readonly layout?: DiffLayout
}

/**
 * The layout to draw an arriving diff in (TODO 826). If the contents (names, bodies) differ from before and the host attached a `layout`, follow it
 * (a diff opened from the AI is side by side). For a re-send of the same contents (theme / language switch) or a diff without `layout`,
 * keep the current layout (the one the user switched to).
 */
export function layoutFor(current: DiffLayout, previous: DiffLayoutSource | null, next: DiffLayoutSource): DiffLayout {
  if (next.layout === undefined) return current
  const same =
    previous !== null &&
    previous.before.name === next.before.name &&
    previous.after.name === next.after.name &&
    previous.before.text === next.before.text &&
    previous.after.text === next.after.text
  return same ? current : next.layout
}

/** The form actually drawn. `plain` is when the diff was not computed because of the size limit. */
export type DiffMode = 'unified' | 'split' | 'plain'

export interface DiffViewOptions {
  readonly before: DiffSide
  readonly after: DiffSide
  readonly theme: Theme
  /** The layout the user chose. Ignored when over the limit, and it becomes `plain`. */
  readonly layout: DiffLayout
  /** The single column / side-by-side button was pressed. The caller remembers it and redraws. */
  readonly onLayoutChange: (layout: DiffLayout) => void
}

export interface DiffView {
  readonly mode: DiffMode
  destroy(): void
}

/** If either side exceeds the limit, the diff is not computed (owner decision 2 of item 104). */
export function shouldSkipDiff(before: DiffSide, after: DiffSide): boolean {
  return exceedsDiffLimit(before.text) || exceedsDiffLimit(after.text)
}

/** Runs of unchanged lines are collapsed (keeping 3 lines before and after). So a small change in a long file is easy to see. */
const COLLAPSE = { margin: 3, minSize: 4 } as const

/**
 * Wave 13 bundle F (small observation 4 of item 138): `@codemirror/merge` looks up its own strings through
 * `EditorState.phrase()` (`state.phrase("$ unchanged lines", n)`),
 * so adding `EditorState.phrases.of({...})` makes the translated strings appear even in the Japanese display
 * (the 4 phrases confirmed by reading `node_modules/@codemirror/merge/dist/index.js`).
 * With this file's settings (`mergeControls: false`, no `revertControls` passed), the only one that
 * actually appears on screen is the fold's `$ unchanged lines`, but all 4 are translated in case
 * revert / accept / reject controls are added in the future. `$` is replaced by `state.phrase` with
 * the number (CodeMirror's convention, `.replace(/\$(\$|\d*)/g, …)`).
 */
const MERGE_PHRASES_JA: Readonly<Record<string, string>> = {
  '$ unchanged lines': '$ 行は変更なし',
  'Revert this chunk': 'この変更を戻す',
  Accept: '採用',
  Reject: '除く'
}

/** The English is the same as CodeMirror's default, but the table is kept as a pair so the two line up (tests check both). */
const MERGE_PHRASES_EN: Readonly<Record<string, string>> = {
  '$ unchanged lines': '$ unchanged lines',
  'Revert this chunk': 'Revert this chunk',
  Accept: 'Accept',
  Reject: 'Reject'
}

/** The `@codemirror/merge` strings for the viewer's current language (`plugins/_shared/i18n.ts`). */
export function mergePhrases(): Extension {
  return EditorState.phrases.of(viewerLocale() === 'ja' ? { ...MERGE_PHRASES_JA } : { ...MERGE_PHRASES_EN })
}

/** Extensions common to read-only editors. */
function baseExtensions(theme: Theme, language: Compartment): Extension[] {
  return [
    lineNumbers(),
    syntaxHighlighting(highlightStyle),
    EditorView.lineWrapping,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    editorTheme(theme),
    language.of([]),
    mergePhrases(),
    // TODO 467: only the same-word highlight and invisible characters (no multiple cursors or folding, editor-extras.ts).
    readOnlyExtras()
  ]
}

/** The language is looked up from the after side's name and hint, and applied to all editors. */
function loadLanguage(side: DiffSide, targets: readonly { view: EditorView; language: Compartment }[], alive: () => boolean): void {
  void findLanguage(side.name, side.language).then(
    (support) => {
      if (support === null || !alive()) return
      for (const target of targets) target.view.dispatch({ effects: target.language.reconfigure(support) })
    },
    () => {
      // Keep displaying even if the language pack cannot be found (it just has no colors).
    }
  )
}

function toolbar(options: DiffViewOptions, skip: boolean): HTMLDivElement {
  const bar = document.createElement('div')
  bar.className = 'toolbar diff-toolbar'
  const names = document.createElement('span')
  names.className = 'diff-names'
  names.textContent =
    options.before.name === options.after.name
      ? options.after.name
      : `${options.before.name} → ${options.after.name}`
  bar.append(names)
  if (skip) return bar
  const spacer = document.createElement('span')
  spacer.className = 'diff-spacer'
  bar.append(spacer)
  for (const [value, label] of [
    ['unified', vt('diffUnified')],
    ['split', vt('diffSplit')]
  ] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.layout = value
    button.textContent = label
    button.setAttribute('aria-pressed', String(options.layout === value))
    if (options.layout === value) button.classList.add('active')
    button.addEventListener('click', () => {
      if (options.layout !== value) options.onLayoutChange(value)
    })
    bar.append(button)
  }
  return bar
}

/**
 * Replaces the contents of `root` and draws the diff. The caller must `destroy` the previous drawing
 * (rebuild when the theme or layout changes - it is a temporary view, so there is no state to keep).
 */
export function mountDiffView(root: HTMLElement, options: DiffViewOptions): DiffView {
  root.textContent = ''
  const skip = shouldSkipDiff(options.before, options.after)
  const mode: DiffMode = skip ? 'plain' : options.layout
  let alive = true
  const isAlive = (): boolean => alive

  root.append(toolbar(options, skip))
  if (skip) {
    const banner = document.createElement('div')
    banner.className = 'banner'
    banner.textContent = vt('diffTooLarge')
    root.append(banner)
  }

  const body = document.createElement('div')
  body.className = `diff-view diff-${mode}`
  root.append(body)

  if (mode === 'unified') {
    const language = new Compartment()
    const view = new EditorView({
      parent: body,
      state: EditorState.create({
        doc: options.after.text,
        extensions: [
          ...baseExtensions(options.theme, language),
          unifiedMergeView({
            original: options.before.text,
            mergeControls: false,
            gutter: true,
            highlightChanges: true,
            syntaxHighlightDeletions: true,
            collapseUnchanged: COLLAPSE
          })
        ]
      })
    })
    loadLanguage(options.after, [{ view, language }], isAlive)
    return {
      mode,
      destroy() {
        alive = false
        view.destroy()
      }
    }
  }

  if (mode === 'split') {
    const languageA = new Compartment()
    const languageB = new Compartment()
    const merge = new MergeView({
      parent: body,
      a: { doc: options.before.text, extensions: baseExtensions(options.theme, languageA) },
      b: { doc: options.after.text, extensions: baseExtensions(options.theme, languageB) },
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: COLLAPSE
    })
    loadLanguage(
      options.after,
      [
        { view: merge.a, language: languageA },
        { view: merge.b, language: languageB }
      ],
      isAlive
    )
    return {
      mode,
      destroy() {
        alive = false
        merge.destroy()
      }
    }
  }

  // plain: the diff is not computed. Put two read-only editors side by side.
  const views: { view: EditorView; language: Compartment }[] = []
  for (const side of [options.before, options.after]) {
    const column = document.createElement('div')
    column.className = 'diff-column'
    const heading = document.createElement('div')
    heading.className = 'diff-column-name'
    heading.textContent = side.name
    column.append(heading)
    body.append(column)
    const language = new Compartment()
    const view = new EditorView({
      parent: column,
      state: EditorState.create({ doc: side.text, extensions: baseExtensions(options.theme, language) })
    })
    views.push({ view, language })
  }
  loadLanguage(options.after, views, isAlive)
  return {
    mode,
    destroy() {
      alive = false
      for (const { view } of views) view.destroy()
    }
  }
}
