/**
 * A thin wrapper around CodeMirror 6 (ARCHITECTURE.md 7.4).
 * Shared by the source views of `aios.text` and `aios.markdown`.
 *
 * A rewrite of Phase 1's `TextEditor.tsx` without React.
 * Language packs are pulled in from `@codemirror/language-data` through a **dynamic import**,
 * so not every language is loaded at startup.
 *
 * Colors (7.4.1): colors are not hard-coded; they reference `viewer.css` variables (`var(--…)`).
 * The only thing passed to CodeMirror is the `dark` flag, chosen from the
 * theme name (`Theme`) that arrived from the host. Syntax colors also come from
 * `--hl-*` (5.1.2, the same variables as Markdown code blocks) rather than from `defaultHighlightStyle` (colors baked in),
 * so the source view and the preview have the same colors and do not break in dark.
 *
 * Search (TODO 54): `search()` and `searchKeymap` of `@codemirror/search` are loaded as a whole.
 * Mod-f opens the search panel (at the top), Mod-g / Shift-Mod-g go to next / previous, and Alt-g jumps to a line number.
 * All of it completes inside the text buffer and touches neither the host nor the Broker.
 * Search-term highlighting (TODO 56) is `setHighlight` - the host passes the search-field string,
 * and here a mark decoration is applied to the matches and **the first match in the document** is centered (TODO 431: it is re-centered
 * again after the size settles). With 2 or more matches, a hit box (`hit-nav.ts`, "n / N" and the first / previous / next / last buttons) is shown at the bottom right.
 * Jumping to a line (item 273) is `revealLine` - a one-shot instruction the host sends from the `foo.ts:42` of a link in the body or from the gateway's `openFile`
 * `line`; it centers that line, places the cursor and marks the line (`.cm-revealedLine`).
 * **It does not make a range selection** - a selection is reported to the host as item 97's "candidate to attach to the send",
 * so merely jumping would make a chip appear in the Composer (VS Code also just places the cursor for `file:line`).
 * The viewing position (TODO 1146, the viewer's Back / Forward) is "the top line of the screen": it is reported through `onTopLine` on every scroll, and
 * `restoreTopLine` brings that line back to the top (with no marker and no cursor; if the line count has shrunk it clamps to the last line).
 */
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension,
  type SelectionRange,
  type Transaction
} from '@codemirror/state'
import {
  EditorView,
  Decoration,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  type DecorationSet
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap } from '@codemirror/search'
import {
  LanguageDescription,
  HighlightStyle,
  syntaxHighlighting,
  bracketMatching,
  indentOnInput,
  type LanguageSupport
} from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import type { Theme } from '@shared/theme.js'
import type { ViewerSelectionRange } from '@shared/plugin.js'
import { findHighlightRanges, splitHighlightTerms, type HighlightRange } from './highlight.js'
import { createHitNav, hitNavState, stepTarget, watchRecenter, type HitStep } from './hit-nav.js'
import { selectionOf } from './selection.js'
import { applyEol, detectEol, normalizeEol } from './eol.js'
import { gutterLineMouseDown } from './line-select.js'
// TODO 467: same-word highlight + Cmd+D and multiple cursors, folding, and symbols for invisible characters.
import { editingExtras, unfoldEffectsAt } from './editor-extras.js'
// TODO 468: the list of symbols in the file (Cmd+R and the heading button).
import { createSymbolNav } from './symbol-picker.js'
// TODO 692: go to declaration (F12), list assignments and uses (Shift+F12), and same-variable highlight.
import { createCodeNav, type ContextProbe } from './code-nav.js'
import type { CodeNavAction } from '@shared/plugin.js'

/**
 * An effect that shows `pos` at the vertical center of the screen (TODO 56 / 59). Shared by search-panel jumps and
 * the first match of the highlight.
 */
function centerOn(pos: number | SelectionRange): StateEffect<unknown> {
  return EditorView.scrollIntoView(pos, { y: 'center' })
}

/**
 * Syntax colors. Uses the same `--hl-*` as Markdown code blocks (render.ts -> `data-hl`).
 * lezer tags and hljs scopes are not 1:1, so the mapping is decided here.
 */
export const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--hl-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.url, t.link], color: 'var(--hl-string)' },
  { tag: [t.comment, t.quote], color: 'var(--hl-comment)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null, t.atom, t.literal, t.list], color: 'var(--hl-number)' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.name)], color: 'var(--hl-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--hl-function)' },
  { tag: [t.definition(t.variableName), t.propertyName, t.attributeName, t.tagName, t.self], color: 'var(--hl-variable)' },
  { tag: [t.meta, t.processingInstruction, t.annotation, t.docComment, t.escape], color: 'var(--hl-meta)' },
  { tag: t.heading, color: 'var(--hl-keyword)', fontWeight: '600' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.invalid, color: 'var(--danger-fg)' }
])

const THEME_RULES = {
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  '.cm-content': { caretColor: 'var(--fg)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--fg-dim)',
    // Dragging the line numbers does not select the digits themselves (TODO 406). Line selection is applied to the body by `line-select.ts`.
    userSelect: 'none',
    WebkitUserSelect: 'none'
  },
  '.cm-lineNumbers .cm-gutterElement': { cursor: 'default' },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--selected-bg)'
  },
  // Search panel (TODO 54). The default baseTheme has baked-in colors that stand out in light / dark, so
  // align it with viewer.css variables. `.cm-panels` is a class on the view side and `.cm-search` on the search side.
  '.cm-panels': { backgroundColor: 'var(--bg-raised)', color: 'var(--fg)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panel.cm-search': { fontSize: '12px' },
  '.cm-panel input, .cm-panel button, .cm-panel.cm-search .cm-textfield, .cm-panel.cm-search .cm-button': {
    backgroundColor: 'var(--bg)',
    color: 'var(--fg)',
    border: '1px solid var(--line)',
    borderRadius: '4px',
    backgroundImage: 'none',
    font: 'inherit'
  },
  '.cm-panel.cm-search [name=close]': { border: 'none', backgroundColor: 'transparent', color: 'var(--fg-dim)' },
  '.cm-panel.cm-search .cm-button:active': { backgroundColor: 'var(--hover)' },
  '.cm-searchMatch': { backgroundColor: 'var(--accent-bg)', outline: '1px solid var(--accent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--selected-bg)' },
  // Words equal to the selected word (TODO 467, `highlightSelectionMatches`). `--hover` (4%) was not visible.
  '.cm-selectionMatch': { backgroundColor: 'var(--selection-match-bg)' },
  // Marker for a line jump (item 273). The same background color as a search match, laid over the whole line.
  '.cm-revealedLine': { backgroundColor: 'var(--accent-bg)' }
}

// ---- Search-term highlight (TODO 56) and the "current match" of the hit box (TODO 431) ----

/** An effect that replaces the set of terms to highlight. If empty, the highlight disappears. The current match becomes the first match in the document. */
const setHighlightTerms = StateEffect.define<readonly string[]>()

/** An effect that changes the current match (the hit box, TODO 431). The value is the match's range itself. */
const setCurrentHit = StateEffect.define<HighlightRange>()

/** The color is viewer.css's `.cm-searchHit` (a fixed color, listed as an exception in theme-tokens). */
const searchHit = Decoration.mark({ class: 'cm-searchHit' })
/** The current match (TODO 431). Lit more strongly than the others (equivalent to `.cm-searchMatch-selected`). Used only when there are 2 or more matches. */
const searchHitCurrent = Decoration.mark({ class: 'cm-searchHit cm-searchHit-current' })

interface HighlightState {
  readonly deco: DecorationSet
  /** The current match. null if there are no matches. */
  readonly current: HighlightRange | null
}

const NO_HIGHLIGHT: HighlightState = { deco: Decoration.none, current: null }

const sameRange = (a: HighlightRange, b: HighlightRange): boolean => a.from === b.from && a.to === b.to

/** Extracts the match ranges from the decorations in `from` order (positions after being `map`ped through edits). */
function hitRanges(deco: DecorationSet): HighlightRange[] {
  const out: HighlightRange[] = []
  for (const iter = deco.iter(); iter.value !== null; iter.next()) out.push({ from: iter.from, to: iter.to })
  return out
}

function buildHighlight(ranges: readonly HighlightRange[], current: HighlightRange | null): HighlightState {
  if (ranges.length === 0) return NO_HIGHLIGHT
  // If not found, the first match in the document.
  const at = Math.max(0, current === null ? 0 : ranges.findIndex((range) => sameRange(range, current)))
  const marked = ranges.length >= 2 ? at : -1
  return {
    deco: Decoration.set(
      ranges.map((range, i) => (i === marked ? searchHitCurrent : searchHit).range(range.from, range.to)),
      true
    ),
    current: ranges[at]!
  }
}

/**
 * Matches after an edit. Decorations follow positions (`map`). If the current match disappeared (its contents were deleted, etc.),
 * move to the first match after that position (or the last match if there is none).
 */
function remapHighlight(value: HighlightState, changes: Transaction['changes']): HighlightState {
  const deco = value.deco.map(changes)
  const ranges = hitRanges(deco)
  if (ranges.length === 0) return NO_HIGHLIGHT
  const current =
    value.current === null ? null : { from: changes.mapPos(value.current.from, 1), to: changes.mapPos(value.current.to, -1) }
  if (current !== null && ranges.some((range) => sameRange(range, current))) return { deco, current }
  const fallback =
    current === null ? ranges[0]! : (ranges.find((range) => range.from >= current.from) ?? ranges[ranges.length - 1]!)
  return buildHighlight(ranges, fallback)
}

/**
 * Decorations for the matches and the current match. They follow when edits shift positions (`map`), but
 * when the document is replaced, call `setHighlight` again (main.ts calls it after `setValue`).
 */
const highlightField = StateField.define<HighlightState>({
  create: () => NO_HIGHLIGHT,
  update(value, transaction) {
    let next = transaction.docChanged && value.current !== null ? remapHighlight(value, transaction.changes) : value
    for (const effect of transaction.effects) {
      if (effect.is(setHighlightTerms)) {
        const ranges = findHighlightRanges(transaction.state.doc, effect.value)
        next = buildHighlight(ranges, ranges[0] ?? null)
      } else if (effect.is(setCurrentHit)) {
        const ranges = hitRanges(next.deco)
        if (ranges.some((range) => sameRange(range, effect.value))) next = buildHighlight(ranges, effect.value)
      }
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco)
})

/** State of the box (the current match number and the count). */
function hitPosition(state: EditorState): { readonly ranges: HighlightRange[]; readonly index: number } {
  const { deco, current } = state.field(highlightField)
  const ranges = hitRanges(deco)
  const index = current === null ? 0 : ranges.findIndex((range) => sameRange(range, current)) + 1
  return { ranges, index }
}

// ---- Marker for a line jump (item 273) ----

/** Position of the start of the line to mark (null clears it). */
const setRevealedLine = StateEffect.define<number | null>()

const revealedLine = Decoration.line({ class: 'cm-revealedLine' })

/**
 * The marker on the line jumped to. It disappears when the whole body is replaced (`setValue`) and follows positions through edits.
 * It moves when the next jump happens.
 */
const revealedLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(setRevealedLine)) {
        next = effect.value === null ? Decoration.none : Decoration.set([revealedLine.range(effect.value)])
      }
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

/**
 * Clamps a 1-based line / column to a position in the body (item 273). If the line is past the body, the last line; if the column is longer than
 * the line, the line end. If `column` is null, the line start.
 */
/**
 * The position that puts "the line you were viewing before" at the very top (TODO 1146). The start of the line obtained by clamping the 1-based line to the body. If the file was
 * rewritten externally and has fewer lines, the last line (the same clamping as `revealPosition`).
 */
export function topLinePosition(doc: EditorState['doc'], line: number): number {
  return revealPosition(doc, line, null).lineFrom
}

export function revealPosition(
  doc: EditorState['doc'],
  line: number,
  column: number | null
): { readonly lineFrom: number; readonly head: number } {
  const target = doc.line(Math.min(Math.max(1, Math.trunc(line)), doc.lines))
  const offset = column === null ? 0 : Math.min(Math.max(0, Math.trunc(column) - 1), target.length)
  return { lineFrom: target.from, head: target.from + offset }
}

const themes = {
  light: EditorView.theme(THEME_RULES, { dark: false }),
  dark: EditorView.theme(THEME_RULES, { dark: true })
} as const

/** The color extension (7.4.1). Exported so the diff viewer (item 104) looks the same. */
export function editorTheme(theme: Theme): Extension {
  return themes[theme]
}

/**
 * Looks up a language pack. It checks `hint` (a language name such as `typescript`) first, and otherwise looks by the
 * extension of `filename`. null if not found. `@codemirror/language-data` stays a dynamic import.
 */
export async function findLanguage(filename: string, hint: string | null = null): Promise<LanguageSupport | null> {
  const { languages } = await import('@codemirror/language-data')
  const description =
    (hint === null ? null : LanguageDescription.matchLanguageName(languages, hint, false)) ??
    LanguageDescription.matchFilename(languages, filename)
  if (description === null) return null
  return description.load()
}

export interface Editor {
  /** The current contents (including a draft). Used to tell a re-send of `resource` apart (items 303 / 309-2). */
  getValue(): string
  /** `resetHistory`: when switching to another file (TODO 1112). Empties the undo history so Cmd+Z cannot go back into the previous file. */
  setValue(value: string, options?: { readonly resetHistory?: boolean }): void
  setReadOnly(readOnly: boolean): void
  setFilename(filename: string): void
  setTheme(theme: Theme): void
  /**
   * Search-term highlight (TODO 56). Pass the search-field string as is - it is split into terms on whitespace,
   * the matches of each term are lit, and **the first match in the document is centered** (TODO 431). `null` / an empty string clears it.
   * With 2 or more matches a hit box appears at the bottom right (the editor owns the box; the caller need not do anything).
   */
  setHighlight(query: string | null): void
  /**
   * Jump to a line (item 273). Clamps the 1-based `line` (and `column`) to the body, centers that line,
   * places the cursor and marks the line. It does not select a range (a selection would become item 97's candidate attachment).
   */
  revealLine(line: number, column?: number | null): void
  /**
   * Brings the line you were viewing before back to the very top of the screen (TODO 1146, the host's `restore-position`). The line is clamped to the body.
   * It does not move the cursor, the selection or the line marker. It stops the watcher that re-centers search terms (TODO 431) (the restored position wins).
   */
  restoreTopLine(line: number): void
  /**
   * Inserts a string (TODO 366 / 407, a link / path of a dropped file). It inserts at **the caret (the head of the main selection)**
   * (407 changed this from "the dropped position"). It does not replace the selected range (a drop does not delete text that was selected). After inserting it
   * places the caret after the inserted text and moves focus to the editor. If read-only it does nothing and returns false. If the character just before the caret is not whitespace,
   * one half-width space is added in front (`padDropInsert`, TODO 429).
   */
  insertText(text: string): boolean
  /**
   * Opens the symbol list (TODO 468, the host's heading button). If `onSymbolsAvailable` was not passed or the language has no
   * symbol table, it does nothing and returns false.
   */
  openSymbols(): boolean
  /**
   * Changes the keys for go to declaration / list assignments and uses (TODO 692, the `editorKeys` of the host's `resource`). null means the defaults (F12 / Shift+F12).
   * It does nothing in an editor that has not enabled `codeNav`.
   */
  setEditorKeys(keys: Readonly<Partial<Record<string, string>>> | null): void
  /** The right-click menu's "go to declaration" / "list assignments and uses" (TODO 692, the host's `code-nav`). */
  runCodeNav(action: CodeNavAction): boolean
  /** Right-click (TODO 692, from the bridge's `contextmenu`). Always false if `codeNav` is not enabled. */
  probeContextMenu(event: { readonly clientX: number; readonly clientY: number; readonly target: EventTarget | null }): ContextProbe
  destroy(): void
}

/**
 * Whether to add whitespace in front of a string inserted by a drop (TODO 429 / observation (1) of 428, owner decision 2026-10-04). `before` is
 * the one character just before the caret (an empty string at the start of the text). Unless it is whitespace (half- or full-width space, tab, newline = line start),
 * one half-width space is added in front. A newline is not added. The separators (newlines) between the second and later paths stay as the host put them.
 * The same rule for the plain-text path in `aios.text` and the Source link in `aios.markdown` (both go through `insertText`).
 */
export function padDropInsert(before: string, text: string): string {
  if (text === '' || before === '' || /\s/u.test(before)) return text
  return ` ${text}`
}

export function createEditor(
  parent: HTMLElement,
  options: {
    value: string
    filename: string
    readOnly: boolean
    theme: Theme
    onChange: (next: string) => void
    /**
     * The selection changed (item 97). Passes only the single main selection, with line numbers. null if empty.
     * The caller forwards it to the bridge's `reportSelection` (the bridge owns throttling).
     */
    onSelection?: (selection: ViewerSelectionRange | null) => void
    /**
     * Called when the line (1-based) of the cursor (the head of the main selection) may have changed (item 318, `aios.markdown`'s heading list
     * "the heading being read now"). Once right after creation, then whenever the selection or body changes. The caller may ignore repeats for the same line.
     */
    onCursorLine?: (line: number) => void
    /**
     * Passed only by a viewer that uses the symbol list (TODO 468) (`aios.text`). Each time the language configuration changes it is called with
     * "whether this language has a symbol table". If not passed, there is neither Cmd+R nor the list (the Source of `aios.markdown` / `aios.html`).
     */
    onSymbolsAvailable?: (available: boolean) => void
    /**
     * Go to declaration (F12), list assignments and uses (Shift+F12) and same-variable highlight (TODO 692). Turned on only by the viewer that reads code
     * (`aios.text`). If the language has no table (the Source of Markdown / HTML, etc.), all of them do nothing.
     */
    codeNav?: boolean
    /**
     * Called when the top line (1-based) of the screen may change by scrolling (TODO 1146). The caller forwards it to the bridge's
     * `reportScrollPosition` (the bridge does throttling and skipping identical values). If not passed, nothing is watched.
     */
    onTopLine?: (line: number) => void
  }
): Editor {
  const language = new Compartment()
  const editable = new Compartment()
  const theme = new Compartment()
  const historyCompartment = new Compartment()
  // TODO 852: preserve the line endings of the opened file. The doc is normalized to `\n`, and only the value returned to the host is rejoined with these line endings.
  let eol = detectEol(options.value)
  let current = applyEol(normalizeEol(options.value), eol)
  let applyingHostValue = false
  // The hit box (TODO 431). Created before `view` and redrawn from the updateListener. It sits at the bottom right of view.dom (`.cm-editor`,
  // which CodeMirror makes position: relative) - outside `.cm-scroller`, so it does not scroll with the body.
  const hitNav = createHitNav(document, (step) => goToHit(step))
  // The symbol list (TODO 468). Only when passed.
  const symbolNav = options.onSymbolsAvailable === undefined ? null : createSymbolNav(options.onSymbolsAvailable)
  // Go to declaration / list assignments and uses (TODO 692). Only when enabled.
  const codeNav = options.codeNav === true ? createCodeNav() : null

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: options.value,
      extensions: [
        // Click / drag / shift+click on a line number selects body lines (TODO 406, same as VS Code).
        lineNumbers({ domEventHandlers: { mousedown: (view, line, event) => gutterLineMouseDown(view, line.from, event as MouseEvent) } }),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        // TODO 467: the Alt + drag rectangular selection (the former `rectangularSelection`) is taken over by `editingExtras`'s Alt+click.
        editingExtras(),
        symbolNav?.extension ?? [],
        codeNav?.extension ?? [],
        historyCompartment.of(history()),
        bracketMatching(),
        indentOnInput(),
        syntaxHighlighting(highlightStyle),
        // Show the search panel at the top (TODO 54). searchKeymap also includes goToLine (Alt-g).
        // Next / previous / select all go through `scrollToMatch`. The default is "move only the minimum",
        // so, as with the highlight (TODO 56), show the match at the center (TODO 59).
        search({ top: true, scrollToMatch: (range) => centerOn(range) }),
        highlightField,
        revealedLineField,
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        EditorView.lineWrapping,
        theme.of(themes[options.theme]),
        language.of([]),
        editable.of(EditorState.readOnly.of(options.readOnly)),
        EditorView.updateListener.of((update) => {
          if (update.startState.field(highlightField) !== update.state.field(highlightField)) {
            const { ranges, index } = hitPosition(update.state)
            hitNav.update(hitNavState(index, ranges.length))
          }
          if (update.selectionSet || update.docChanged) {
            const main = update.state.selection.main
            options.onSelection?.(selectionOf(update.state.doc, main.anchor, main.head))
            options.onCursorLine?.(update.state.doc.lineAt(main.head).number)
          }
          if (!update.docChanged) return
          current = applyEol(update.state.doc.toString(), eol)
          // Applying a body re-put from the host (setValue) is not a user edit. Do not emit onChange.
          if (applyingHostValue) return
          options.onChange(current)
        })
      ]
    })
  })

  let loadToken = 0
  const loadLanguage = (filename: string): void => {
    const token = ++loadToken
    void (async () => {
      const support = await findLanguage(filename)
      if (token !== loadToken) return
      // When switching to a file with no language (.txt etc.), remove the previous language (TODO 468: it used to stay, so syntax colors and
      // the symbol list kept the previous file's language).
      view.dispatch({ effects: language.reconfigure(support ?? []) })
    })()
  }
  symbolNav?.mount(view)
  codeNav?.mount(view)
  loadLanguage(options.filename)
  options.onCursorLine?.(view.state.doc.lineAt(view.state.selection.main.head).number)
  view.dom.append(hitNav.element)

  /** Centers the current match. */
  const centerCurrent = (): void => {
    const hit = view.state.field(highlightField).current
    // If the match is inside a fold, unfold it before centering (TODO 467).
    if (hit !== null) view.dispatch({ effects: [...unfoldEffectsAt(view.state, hit.from, hit.to), centerOn(hit.from)] })
  }
  // Right after opening, the size is not fully settled (TODO 431 (b)). Re-center once it settles / whenever it changes.
  const recenter = watchRecenter(view.scrollDOM, centerCurrent)

  // The top line of the screen (TODO 1146). We are inside a scroll DOM event, so reading layout is fine. We look 1 px lower so that
  // when the restored line lands exactly at the top edge (`restoreTopLine` has 0 margin) it is not mistaken for the line above.
  const onTopLine = options.onTopLine
  const onScroll =
    onTopLine === undefined
      ? null
      : (): void => {
          // Height from the top of the document = scrollTop - the top margin. `getBoundingClientRect` / `documentTop` force layout, so they are not read.
          const block = view.lineBlockAtHeight(Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top + 1))
          onTopLine(view.state.doc.lineAt(block.from).number)
        }
  if (onScroll !== null) view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })

  /** The box was pressed (TODO 431). Makes the destination match the current match and centers it. Does not move the selection or cursor (item 97). */
  function goToHit(step: HitStep): void {
    const { ranges, index } = hitPosition(view.state)
    const target = stepTarget(step, index, ranges.length)
    const hit = target === null ? undefined : ranges[target - 1]
    if (hit === undefined) return
    recenter.disarm()
    view.dispatch({ effects: [setCurrentHit.of(hit), ...unfoldEffectsAt(view.state, hit.from, hit.to), centerOn(hit.from)] })
  }

  return {
    getValue() {
      return current
    },
    setValue(value, setOptions) {
      // Removing and re-adding history rebuilds the state and empties the history (TODO 1112).
      // Even when the body is the same, empty it so that switching to a different file with identical contents does not keep the previous file's history.
      const clearHistory = (): void => {
        if (setOptions?.resetHistory !== true) return
        view.dispatch({ effects: historyCompartment.reconfigure([]) })
        view.dispatch({ effects: historyCompartment.reconfigure(history()) })
      }
      if (value === current) {
        clearHistory()
        return
      }
      eol = detectEol(value)
      current = applyEol(normalizeEol(value), eol)
      // Compare docs normalized to \n. A body with mixed line endings has a current that was normalized and does not
      // equal value, but the doc is the same, so neither a full replace (which loses undo and the cursor) nor onChange is needed.
      const next = normalizeEol(value)
      if (view.state.doc.toString() === next) {
        clearHistory()
        return
      }
      applyingHostValue = true
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: next },
          // Once the body changes, the previous marker loses its meaning.
          effects: setRevealedLine.of(null)
        })
        clearHistory()
      } finally {
        applyingHostValue = false
      }
    },
    setReadOnly(readOnly) {
      view.dispatch({ effects: editable.reconfigure(EditorState.readOnly.of(readOnly)) })
    },
    setFilename(filename) {
      loadLanguage(filename)
    },
    setTheme(next) {
      view.dispatch({ effects: theme.reconfigure(themes[next]) })
    },
    setHighlight(query) {
      view.dispatch({ effects: setHighlightTerms.of(splitHighlightTerms(query)) })
      // A highlight off screen goes unnoticed, so center the first match in the document (= the current match, TODO 431 (a)), and
      // re-center after the size settles / changes (TODO 431 (b)).
      if (view.state.field(highlightField).current === null) {
        recenter.disarm()
        return
      }
      centerCurrent()
      recenter.arm()
    },
    revealLine(line, column = null) {
      const { lineFrom, head } = revealPosition(view.state.doc, line, column)
      view.dispatch({
        selection: { anchor: head },
        effects: [setRevealedLine.of(lineFrom), centerOn(head)]
      })
    },
    restoreTopLine(line) {
      recenter.disarm()
      view.dispatch({ effects: EditorView.scrollIntoView(topLinePosition(view.state.doc, line), { y: 'start', yMargin: 0 }) })
    },
    insertText(text) {
      if (text === '' || view.state.readOnly) return false
      const at = Math.min(Math.max(0, view.state.selection.main.head), view.state.doc.length)
      // If dropped in the middle of a line, add a half-width space so it does not run into the preceding character (TODO 429 / observation (1) of 428).
      const padded = padDropInsert(at === 0 ? '' : view.state.sliceDoc(at - 1, at), text)
      view.dispatch({
        changes: { from: at, insert: padded },
        selection: { anchor: at + padded.length },
        scrollIntoView: true,
        userEvent: 'input.drop'
      })
      view.focus()
      return true
    },
    openSymbols() {
      return symbolNav?.open() ?? false
    },
    setEditorKeys(keys) {
      codeNav?.setKeys(keys)
    },
    runCodeNav(action) {
      return codeNav?.run(action) ?? false
    },
    probeContextMenu(event) {
      return codeNav?.probeContextMenu(event) ?? { codeNav: false, keepSelection: true }
    },
    destroy() {
      if (onScroll !== null) view.scrollDOM.removeEventListener('scroll', onScroll)
      recenter.destroy()
      symbolNav?.destroy()
      codeNav?.destroy()
      view.destroy()
    }
  }
}
