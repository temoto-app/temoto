/**
 * Rendering of `aios.diff` (ARCHITECTURE.md 7.4.6, item 104).
 *
 * Shows the two sides (before / after) passed by the host with `@codemirror/merge`. **Read only** -
 * no editing and no partial acceptance (no per-chunk accept / reject buttons).
 *
 *   - single column (unified, the default): the after text is the body, and removed lines are inserted above (`unifiedMergeView`)
 *   - side by side (split): before on the left, after on the right (`MergeView`)
 *   - if either side exceeds `MAX_DIFF_BYTES`, the character diff is not computed and the two sides are simply placed next to each other (plain).
 *     A coarse line diff (`coarse-diff.ts`) still marks the changed lines there, so the jump buttons work (TODO 1339)
 *   - previous / next change buttons and F7 / Shift+F7 (Alt+F5 / Shift+Alt+F5) in every mode; the target chunk is centered, and
 *     right after opening the first change is shown (re-centered while the size settles, `watchRecenter`)
 *
 * Colors use only `--diff-*` from viewer.css (7.4.1). The default theme of `@codemirror/merge` has
 * hard-coded colors, so they are overridden by raising specificity under `.diff-view` (viewer.css).
 *
 * DOM assembly is gathered here, and main.ts just receives from the bridge and calls it.
 * Thanks to this, the whole thing can be tested in jsdom without a bridge (test/diff-viewer.test.ts).
 */
import { Compartment, EditorState, RangeSetBuilder, StateField, type Extension, type Text } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { syntaxHighlighting } from '@codemirror/language'
import { Change, MergeView, getChunks, unifiedMergeView, type DiffConfig } from '@codemirror/merge'
import { Decoration, type DecorationSet } from '@codemirror/view'
import { exceedsDiffLimit, type DiffLayout, type DiffSide } from '@shared/plugin.js'
import type { Theme } from '@shared/theme.js'
import { editorTheme, findLanguage, highlightStyle } from '../../_shared/editor.js'
import { readOnlyExtras } from '../../_shared/editor-extras.js'
import { vt, viewerLocale } from '../../_shared/i18n.js'
import { attachNav, createNavGroup, scrollerView, type NavController, type NavLocation, type NavParts } from './nav.js'
import { coarseLineDiff, refinedCharChanges, type CharChange, type LineChunk } from './coarse-diff.js'
import { LINE_DIFF_THRESHOLD, editorText, type DiffJobResult } from './diff-work.js'

export type { DiffLayout }
export { LINE_DIFF_THRESHOLD }

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
  /**
   * The change (0-based) to show first. The caller passes the one that was current before a redraw (layout / theme switch) so
   * the view does not jump back to the first change. Default 0; clamped to the number of changes.
   */
  readonly startChunk?: number
  /**
   * The slow part of the diff, already computed for these two sides (TODO 1341 item 4: in the Web Worker, `main.ts`). `chars` feeds the
   * merge views' line-diff override, `lines` the plain mode. Absent (or of the other kind): computed here, on this thread, with
   * `UI_THREAD_LIMITS` as before.
   */
  readonly precomputed?: DiffJobResult
}

export interface DiffView {
  readonly mode: DiffMode
  /** Number of changes that can be jumped to. 0 means nothing to jump to (equal sides, or the coarse diff gave up). */
  readonly chunkCount: number
  /** The current change (0-based), or -1 when there are none. */
  readonly chunk: number
  /** Move to the next / previous change (wrapping around) and center it. No-ops when there are none. */
  next(): void
  prev(): void
  destroy(): void
}

/** If either side exceeds the limit, the character diff is not computed (owner decision 2 of item 104). */
export function shouldSkipDiff(before: DiffSide, after: DiffSide): boolean {
  return exceedsDiffLimit(before.text) || exceedsDiffLimit(after.text)
}

/**
 * `diffConfig` for the merge views: the default for small inputs, the line diff for big ones. `precomputed` (from the worker) is used
 * when the library asks for exactly the two sides it was computed for; anything else is computed here. The library asks with the
 * editor's text (lines joined with `\n`), so the sides are compared as `editorText` (wave 109 fix X1: CRLF files missed the result).
 */
function diffConfigFor(
  before: DiffSide,
  after: DiffSide,
  precomputed: readonly CharChange[] | null | undefined
): DiffConfig | undefined {
  if (before.text.length <= LINE_DIFF_THRESHOLD && after.text.length <= LINE_DIFF_THRESHOLD) return undefined
  const sideA = precomputed === undefined ? null : editorText(before.text)
  const sideB = precomputed === undefined ? null : editorText(after.text)
  return {
    override: (a, b) => {
      const changes = precomputed !== undefined && a === sideA && b === sideB ? precomputed : refinedCharChanges(a, b)
      // Gave up: report everything as changed rather than stalling (still one chunk to jump to).
      if (changes === null) return [new Change(0, a.length, 0, b.length)]
      return changes.map((c) => new Change(c.fromA, c.toA, c.fromB, c.toB))
    }
  }
}

/** Upper limit of lines decorated per side in the plain mode (the jump targets are not limited by this). */
const MAX_DECORATED_LINES = 200_000

/** Line background marks for the plain mode, built once (a read-only document never changes). `ranges` are 0-based half-open lines. */
function coarseMarks(className: string, ranges: readonly { from: number; to: number }[]): Extension {
  const deco = Decoration.line({ class: className })
  const field = StateField.define<DecorationSet>({
    create(state) {
      const builder = new RangeSetBuilder<Decoration>()
      const doc = state.doc
      let used = 0
      for (const range of ranges) {
        for (let line = range.from; line < range.to && line < doc.lines && used < MAX_DECORATED_LINES; line++, used++) {
          const at = doc.line(line + 1).from
          builder.add(at, at, deco)
        }
      }
      return builder.finish()
    },
    update: (value) => value,
    provide: (f) => EditorView.decorations.from(f)
  })
  return field
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

interface ToolbarParts extends NavParts {
  readonly bar: HTMLDivElement
}

function toolbar(options: DiffViewOptions, skip: boolean): ToolbarParts {
  const bar = document.createElement('div')
  bar.className = 'toolbar diff-toolbar'
  const names = document.createElement('span')
  names.className = 'diff-names'
  names.textContent =
    options.before.name === options.after.name
      ? options.after.name
      : `${options.before.name} → ${options.after.name}`
  bar.append(names)
  const spacer = document.createElement('span')
  spacer.className = 'diff-spacer'
  bar.append(spacer)
  const { group, prev, next, pos } = createNavGroup()
  bar.append(group)
  if (!skip) {
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
  }
  return { bar, group, prev, next, pos }
}

/**
 * Where the changes are on screen right now, for the base of previous / next after the person scrolled (TODO 1341). The middle of
 * `scroller` against each change's line in `view`; both in client coordinates (`documentTop` is the document's top in the viewport).
 */
function locateIn(view: EditorView, scroller: HTMLElement, position: (index: number) => number): () => NavLocation {
  return () => {
    const documentTop = view.documentTop
    return {
      ...scrollerView(scroller),
      top: (i) => documentTop + view.lineBlockAt(Math.min(Math.max(position(i), 0), view.state.doc.length)).top
    }
  }
}

/** Centers `pos` of `view` (in unified / split the scroller is the surrounding `.diff-view`, so both sides move together; plain columns scroll on their own). */
function centerOn(view: EditorView, pos: number): void {
  view.dispatch({ effects: EditorView.scrollIntoView(Math.min(Math.max(pos, 0), view.state.doc.length), { y: 'center' }) })
}

/**
 * The position to center for the 0-based half-open line range `[from, to)`: the range's first line, or for an empty range (a pure
 * insertion on the other side) the line just before it, which is where that side's change sits.
 */
export function anchorPos(doc: Text, from: number, to: number): number {
  if (doc.lines === 0) return 0
  if (to > from) return from < doc.lines ? doc.line(from + 1).from : doc.length
  if (from <= 0) return 0
  return doc.line(Math.min(from, doc.lines)).from
}

/**
 * Replaces the contents of `root` and draws the diff. The caller must `destroy` the previous drawing
 * (rebuild when the theme or layout changes - it is a temporary view, so there is no state to keep except the
 * current change, which the caller passes back as `startChunk`).
 */
export function mountDiffView(root: HTMLElement, options: DiffViewOptions): DiffView {
  root.textContent = ''
  const skip = shouldSkipDiff(options.before, options.after)
  const mode: DiffMode = skip ? 'plain' : options.layout
  let alive = true
  const isAlive = (): boolean => alive

  const parts = toolbar(options, skip)
  root.append(parts.bar)
  const banner = document.createElement('div')
  banner.className = 'banner'
  if (skip) root.append(banner)

  const body = document.createElement('div')
  body.className = `diff-view diff-${mode}`
  root.append(body)

  const finish = (nav: NavController, destroyViews: () => void): DiffView => ({
    mode,
    get chunkCount() {
      return nav.count
    },
    get chunk() {
      return nav.current()
    },
    next: nav.next,
    prev: nav.prev,
    destroy() {
      alive = false
      nav.destroy()
      destroyViews()
    }
  })

  const precomputed = options.precomputed
  const diffConfig = diffConfigFor(
    options.before,
    options.after,
    precomputed?.kind === 'chars' ? precomputed.changes : undefined
  )

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
            collapseUnchanged: COLLAPSE,
            ...(diffConfig === undefined ? {} : { diffConfig })
          })
        ]
      })
    })
    loadLanguage(options.after, [{ view, language }], isAlive)
    const chunks = getChunks(view.state)?.chunks ?? []
    const nav = attachNav({
      parts,
      body,
      count: chunks.length,
      start: options.startChunk ?? 0,
      scroll: (i) => {
        const chunk = chunks[i]
        if (isAlive() && chunk !== undefined) centerOn(view, chunk.fromB)
      },
      locate: locateIn(view, body, (i) => chunks[i]?.fromB ?? 0)
    })
    return finish(nav, () => view.destroy())
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
      collapseUnchanged: COLLAPSE,
      ...(diffConfig === undefined ? {} : { diffConfig })
    })
    loadLanguage(
      options.after,
      [
        { view: merge.a, language: languageA },
        { view: merge.b, language: languageB }
      ],
      isAlive
    )
    const chunks = merge.chunks
    const nav = attachNav({
      parts,
      body,
      count: chunks.length,
      start: options.startChunk ?? 0,
      scroll: (i) => {
        const chunk = chunks[i]
        if (isAlive() && chunk !== undefined) centerOn(merge.b, chunk.fromB)
      },
      locate: locateIn(merge.b, body, (i) => chunks[i]?.fromB ?? 0)
    })
    return finish(nav, () => merge.destroy())
  }

  // plain: the character diff is not computed. Put two read-only editors side by side, and mark the changed lines from a coarse line diff.
  const coarse: readonly LineChunk[] | null =
    precomputed?.kind === 'lines' ? precomputed.chunks : coarseLineDiff(options.before.text, options.after.text)
  banner.textContent = vt(coarse === null || coarse.length === 0 ? 'diffTooLarge' : 'diffTooLargeJump')
  const views: { view: EditorView; language: Compartment }[] = []
  for (const [side, kind] of [
    [options.before, 'a'],
    [options.after, 'b']
  ] as const) {
    const column = document.createElement('div')
    column.className = 'diff-column'
    const heading = document.createElement('div')
    heading.className = 'diff-column-name'
    heading.textContent = side.name
    column.append(heading)
    body.append(column)
    const language = new Compartment()
    const marks =
      coarse === null
        ? []
        : [
            coarseMarks(
              kind === 'a' ? 'diff-coarse-del' : 'diff-coarse-add',
              coarse.map((c) => (kind === 'a' ? { from: c.fromA, to: c.toA } : { from: c.fromB, to: c.toB }))
            )
          ]
    const view = new EditorView({
      parent: column,
      state: EditorState.create({ doc: side.text, extensions: [...baseExtensions(options.theme, language), ...marks] })
    })
    views.push({ view, language })
  }
  loadLanguage(options.after, views, isAlive)
  const columns = [...body.querySelectorAll<HTMLElement>('.diff-column')]
  const [beforeView, afterView] = [views[0]!.view, views[1]!.view]
  // Each column scrolls on its own (the two sides are not line-aligned), so a jump centers the change in both. The person's own
  // scrolling is mirrored by the same distance, so the columns still move together. While an automatic jump is in effect (until the
  // first wheel / pointer / key / touch, the same inputs that stop the re-centering) the scroll events are not mirrored.
  let automatic = false
  const lastTop = columns.map((c) => c.scrollTop)
  columns.forEach((column, index) => {
    column.addEventListener('scroll', () => {
      const delta = column.scrollTop - lastTop[index]!
      lastTop[index] = column.scrollTop
      if (automatic || delta === 0) return
      const other = columns[1 - index]!
      other.scrollTop += delta
      lastTop[1 - index] = other.scrollTop
    })
  })
  const manual = (): void => {
    automatic = false
  }
  const manualEvents = ['wheel', 'pointerdown', 'touchstart'] as const
  for (const type of manualEvents) body.addEventListener(type, manual, { capture: true, passive: true })
  // Keys target the iframe body (the editors are read-only), so they are watched on the document.
  body.ownerDocument.addEventListener('keydown', manual, { capture: true, passive: true })
  const nav = attachNav({
    parts,
    body,
    count: coarse?.length ?? 0,
    start: options.startChunk ?? 0,
    scroll: (i) => {
      const chunk = coarse?.[i]
      if (!isAlive() || chunk === undefined) return
      automatic = true
      centerOn(beforeView, anchorPos(beforeView.state.doc, chunk.fromA, chunk.toA))
      centerOn(afterView, anchorPos(afterView.state.doc, chunk.fromB, chunk.toB))
    },
    // The columns are mirrored, so the after column stands for both (ties between neighbouring anchors are possible in this mode).
    locate: locateIn(afterView, columns[1]!, (i) => {
      const chunk = coarse?.[i]
      return chunk === undefined ? 0 : anchorPos(afterView.state.doc, chunk.fromB, chunk.toB)
    })
  })
  return finish(nav, () => {
    for (const type of manualEvents) body.removeEventListener(type, manual, { capture: true })
    body.ownerDocument.removeEventListener('keydown', manual, { capture: true })
    for (const { view } of views) view.destroy()
  })
}
