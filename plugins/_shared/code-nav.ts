/**
 * "Go to declaration" (F12), "list assignments and uses" (Shift+F12) and same-variable highlighting for the code viewer (TODO 692, wave 32 bundle B,
 * ARCHITECTURE.md 7.4.3.3). **Within the file only** - analysis is in `references.ts` (an approximation from the Lezer syntax tree).
 *
 * - **Highlight** (VS Code's document highlight): when the cursor rests on a name, other occurrences of the same variable glow faintly.
 *   Assignments (and declarations) use `.cm-codeRef-write` and uses use `.cm-codeRef-read`, with different colors (variables in viewer.css). Not shown while the selection
 *   is non-empty (left to item 467's same-word highlight `highlightSelectionMatches`). After each cursor move it waits briefly
 *   (`REF_HIGHLIGHT_DELAY_MS`) and then looks only at the already-parsed syntax tree (it does not wait for parsing).
 * - **Keys**: default F12 / Shift+F12. They are in item 549's shortcut table (scope `viewer` in `src/shared/keybindings.ts`), and
 *   keys the user changed are passed by the host in the `resource`'s `editorKeys` (`setKeys`). The keymap is swapped through a Compartment.
 * - **List**: the same component as item 468's symbol list (`createListPicker`). Each row has a "declaration / assignment / use" marker, a line excerpt and the line number.
 *   When opened, the row of the occurrence under the cursor is highlighted. Choosing a row puts the cursor on the name's characters.
 * - **Right-click**: the bridge calls `probeContextMenu` on `contextmenu`. Over a name it (moves the cursor there if it is outside the selection)
 *   and returns true, and the two entries appear in the host's menu. When one is chosen, the host's `code-nav` reaches `run`.
 * - When no declaration is found or the pointer is not over a name, a short notice is shown over the editor (VS Code's "No definition found").
 */
import { Compartment, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type KeyBinding, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import {
  VIEWER_KEYBINDING_COMMAND_IDS,
  codeMirrorKeysOf,
  keybindingCommand,
  type KeyPlatform,
  type ViewerKeybindingCommandId
} from '@shared/keybindings.js'
import type { CodeNavAction } from '@shared/plugin.js'
import { vt } from './i18n.js'
import { createListPicker, type SymbolPicker } from './symbol-picker.js'
import { languageNameOf } from './symbols.js'
import { collectReferences, identifierAt, supportsReferences, type CodeRef, type ReferenceResult } from './references.js'

/** Wait (ms) from the cursor settling to computing the highlight. Avoids walking the tree on every keystroke or arrow-key repeat. */
export const REF_HIGHLIGHT_DELAY_MS = 120

/** Upper limit (characters) on the body size for automatic highlighting. Beyond it only F12 / Shift+F12 work (a full scan each time is heavy). */
export const MAX_HIGHLIGHT_DOC = 1_000_000

/**
 * Margin (characters) around the visible range that limits the occurrences enumerated for automatic highlighting. Code review of TODO 692: count only
 * `view.visibleRanges` (+ this margin) instead of walking the whole syntax tree. Declaration resolution (the scope-walking mechanism) is unchanged - if the declaration is
 * outside this range, the same algorithm as before simply fails to find it and falls back to the approximation (`mode: 'name'`).
 */
export const HIGHLIGHT_SCAN_MARGIN = 2000

/** The visible range of `view` (+ margin) as a single interval (even if folds break it up, one interval is a good enough approximation). */
export function highlightScanRange(view: EditorView): { readonly from: number; readonly to: number } {
  const ranges = view.visibleRanges
  const from = ranges.length === 0 ? 0 : ranges[0]!.from
  const to = ranges.length === 0 ? view.state.doc.length : ranges[ranges.length - 1]!.to
  return {
    from: Math.max(0, from - HIGHLIGHT_SCAN_MARGIN),
    to: Math.min(view.state.doc.length, to + HIGHLIGHT_SCAN_MARGIN)
  }
}

/** How long (ms) a notice stays visible. */
export const NOTE_VISIBLE_MS = 2500

/** Upper limit (characters) on an excerpt. For a long line, only the part around the name. */
const EXCERPT_MAX = 160

const readMark = Decoration.mark({ class: 'cm-codeRef cm-codeRef-read' })
const writeMark = Decoration.mark({ class: 'cm-codeRef cm-codeRef-write' })

const setRefHighlight = StateEffect.define<DecorationSet>()

/** Highlight decorations. They follow positions through edits and are replaced on the next recomputation. */
const refHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) if (effect.is(setRefHighlight)) next = effect.value
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

/** Builds the highlight decorations (pure function; a declaration gets the assignment color). */
export function refHighlightDecorations(refs: readonly CodeRef[]): DecorationSet {
  if (refs.length === 0) return Decoration.none
  return Decoration.set(
    refs.map((ref) => (ref.role === 'read' ? readMark : writeMark).range(ref.from, ref.to)),
    true
  )
}

/**
 * The occurrences to highlight in the current state (only when there is a single cursor and an empty selection). Empty otherwise. When `scanRange` is passed,
 * the enumeration of occurrences in `collectReferences` is limited to that range (the visible range, code review of TODO 692).
 */
export function highlightRefsFor(
  state: EditorState,
  scanRange?: { readonly from: number; readonly to: number }
): readonly CodeRef[] {
  const { ranges, main } = state.selection
  if (ranges.length !== 1 || !main.empty) return []
  if (state.doc.length > MAX_HIGHLIGHT_DOC) return []
  return collectReferences(state, main.head, 0, scanRange)?.refs ?? []
}

/** After each cursor move, document change or parse progress, waits briefly and then recomputes the highlight. */
const refHighlighter = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null
    private destroyed = false

    constructor(readonly view: EditorView) {
      this.schedule()
    }

    update(update: ViewUpdate): void {
      if (update.selectionSet || update.docChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.schedule()
      }
    }

    schedule(): void {
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        if (this.destroyed) return
        const decorations = refHighlightDecorations(highlightRefsFor(this.view.state, highlightScanRange(this.view)))
        const current = this.view.state.field(refHighlightField)
        if (current.size === 0 && decorations.size === 0) return
        this.view.dispatch({ effects: setRefHighlight.of(decorations) })
      }, REF_HIGHLIGHT_DELAY_MS)
    }

    destroy(): void {
      this.destroyed = true
      if (this.timer !== null) clearTimeout(this.timer)
    }
  }
)

/** One row of the list (with an excerpt). */
export interface RefRow {
  readonly ref: CodeRef
  /** Excerpt of the line (leading whitespace removed; for a long line, only the part around the name). */
  readonly excerpt: string
  /** Position of the name within the excerpt (characters). */
  readonly nameFrom: number
  readonly nameTo: number
}

/** Builds the list rows (pure function). */
export function refRows(state: EditorState, refs: readonly CodeRef[]): RefRow[] {
  return refs.map((ref) => {
    const line = state.doc.lineAt(ref.from)
    const raw = line.text
    const indent = raw.length - raw.trimStart().length
    let start = indent
    let end = raw.length
    const col = ref.from - line.from
    const len = ref.to - ref.from
    if (end - start > EXCERPT_MAX) {
      start = Math.max(indent, col - Math.floor(EXCERPT_MAX / 3))
      end = Math.min(raw.length, start + EXCERPT_MAX)
    }
    const prefix = start > indent ? '…' : ''
    const suffix = end < raw.length ? '…' : ''
    const excerpt = prefix + raw.slice(start, end) + suffix
    const nameFrom = prefix.length + Math.max(0, col - start)
    return { ref, excerpt, nameFrom, nameTo: Math.min(excerpt.length, nameFrom + len) }
  })
}

/** List filtering: a substring match on the excerpt (case-insensitive), or a prefix match when the query is digits and matches the line number. */
export function filterRefRows(rows: readonly RefRow[], query: string): RefRow[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...rows]
  const numeric = /^\d+$/.test(q)
  return rows.filter((row) => row.excerpt.toLowerCase().includes(q) || (numeric && String(row.ref.line).startsWith(q)))
}

const ROLE_LABEL: Readonly<Record<CodeRef['role'], 'refDeclaration' | 'refWrite' | 'refRead'>> = {
  declaration: 'refDeclaration',
  write: 'refWrite',
  read: 'refRead'
}

/** The viewer's convention (mac / other). Decided inside the iframe (the host does not pass it). */
function viewerPlatform(): KeyPlatform {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform) ? 'mac' : 'other'
}

/** Default keys (while nothing has arrived from the host). */
function defaultKeys(platform: KeyPlatform): Readonly<Partial<Record<ViewerKeybindingCommandId, string>>> {
  const out: Partial<Record<ViewerKeybindingCommandId, string>> = {}
  for (const id of VIEWER_KEYBINDING_COMMAND_IDS) {
    const key = keybindingCommand(id).defaults[platform]
    if (key !== null) out[id] = key
  }
  return out
}

/** Result of the right-click probe. */
export interface ContextProbe {
  /** Over a name, so "Go to declaration" and "List assignments and uses" may be put in the menu. */
  readonly codeNav: boolean
  /** Whether the selected text may be used (for item 630's search entry). False if the click was outside the selection and the cursor was moved. */
  readonly keepSelection: boolean
}

export interface CodeNav {
  /** The editor extension (keymap and highlight). Push it onto `createEditor`'s array. */
  readonly extension: Extension
  /** Called once after the view exists. Mounts the list and notice DOM on `.cm-editor`. */
  mount(view: EditorView): void
  /** Changes the keys (the host's `editorKeys`). null means the defaults. */
  setKeys(keys: Readonly<Partial<Record<string, string>>> | null): void
  /** Go to declaration. Omit `pos` for the cursor. */
  goToDeclaration(pos?: number): boolean
  /** Opens the list of assignments and uses. Omit `pos` for the cursor. */
  listReferences(pos?: number): boolean
  /** From the right-click menu (the host's `code-nav`). The target is the right-clicked position. */
  run(action: CodeNavAction): boolean
  /** Right-click (from the bridge's `contextmenu`). */
  probeContextMenu(event: { readonly clientX: number; readonly clientY: number; readonly target: EventTarget | null }): ContextProbe
  destroy(): void
}

export function createCodeNav(platform: KeyPlatform = viewerPlatform()): CodeNav {
  let view: EditorView | null = null
  let picker: SymbolPicker | null = null
  let note: HTMLDivElement | null = null
  let noteTimer: ReturnType<typeof setTimeout> | null = null
  /** The right-clicked position (used when a menu entry is chosen). */
  let menuPos: number | null = null
  /** Contents when opening the list (built by `listReferences` and returned by `collect`). */
  let pending: { readonly result: ReferenceResult; readonly rows: RefRow[] } | null = null
  /** Name of the open list (the heading; `label` is read after `collect`). */
  let listedName = ''
  const keys = new Compartment()
  /** Keys of the current keymap (not rebuilt if unchanged). */
  let keysSignature = JSON.stringify(VIEWER_KEYBINDING_COMMAND_IDS.map((id) => defaultKeys(platform)[id] ?? null))

  const hideNote = (): void => {
    if (noteTimer !== null) clearTimeout(noteTimer)
    noteTimer = null
    if (note !== null) note.hidden = true
  }

  const showNote = (message: string, pos: number): void => {
    if (view === null || note === null) return
    note.textContent = message
    note.hidden = false
    // Show it just below the cursor's line (`.cm-editor` is position: relative). If it cannot be measured, at the top edge.
    let coords: { readonly left: number; readonly bottom: number } | null = null
    try {
      coords = view.coordsAtPos(Math.min(pos, view.state.doc.length))
    } catch {
      // Cannot be measured where there is no layout (jsdom in tests). Show at the top edge.
    }
    const box = view.dom.getBoundingClientRect()
    if (coords !== null) {
      note.style.top = `${Math.max(0, coords.bottom - box.top + 2)}px`
      note.style.left = `${Math.max(0, coords.left - box.left)}px`
    } else {
      note.style.top = '6px'
      note.style.left = '12px'
    }
    if (noteTimer !== null) clearTimeout(noteTimer)
    noteTimer = setTimeout(hideNote, NOTE_VISIBLE_MS)
  }

  const headOf = (): number => view?.state.selection.main.head ?? 0

  const listReferences = (pos: number = headOf()): boolean => {
    if (view === null || picker === null) return false
    const result = collectReferences(view.state, pos)
    if (result === null) {
      if (supportsReferences(languageNameOf(view.state))) showNote(vt('declarationNotHere'), pos)
      return false
    }
    pending = { result, rows: refRows(view.state, result.refs) }
    listedName = result.name
    hideNote()
    return picker.open()
  }

  const goToDeclaration = (pos: number = headOf()): boolean => {
    if (view === null) return false
    const result = collectReferences(view.state, pos)
    if (result === null) {
      if (supportsReferences(languageNameOf(view.state))) showNote(vt('declarationNotHere'), pos)
      return false
    }
    const declaration = result.declaration
    if (declaration === null) {
      showNote(vt('declarationNotFound', { name: result.name }), pos)
      return false
    }
    // Pressed on a declaration, show the list (VS Code default: Go to Definition on a definition shows the references).
    if (declaration.from === result.target.from) return listReferences(pos)
    hideNote()
    view.dispatch({
      selection: { anchor: declaration.from },
      effects: EditorView.scrollIntoView(declaration.from, { y: 'center' }),
      userEvent: 'select'
    })
    view.focus()
    return true
  }

  const keymapFor = (map: Readonly<Partial<Record<string, string>>>): Extension => {
    const bindings: KeyBinding[] = []
    const actions: Readonly<Record<ViewerKeybindingCommandId, () => boolean>> = {
      'code.goToDeclaration': () => (goToDeclaration(), true),
      'code.listReferences': () => (listReferences(), true)
    }
    for (const id of VIEWER_KEYBINDING_COMMAND_IDS) {
      const text = map[id]
      if (typeof text !== 'string') continue
      for (const key of codeMirrorKeysOf(text, platform)) bindings.push({ key, run: actions[id], preventDefault: true })
    }
    return keymap.of(bindings)
  }

  return {
    extension: [
      keys.of(keymapFor(defaultKeys(platform))),
      refHighlightField,
      refHighlighter,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          picker?.close(false)
          menuPos = null
        }
        if (update.selectionSet || update.docChanged) hideNote()
      })
    ],
    mount(next) {
      view = next
      picker = createListPicker<RefRow>(next, {
        className: 'ref-picker',
        collect() {
          const current = pending
          pending = null
          if (current === null) return null
          const { result, rows } = current
          const initial = Math.max(0, rows.findIndex((row) => row.ref.from === result.target.from))
          return {
            items: rows,
            initial,
            note: (_total, shown) =>
              shown === 0 ? vt('refsNoMatch') : result.partial ? vt('refsPartial') : result.mode === 'name' ? vt('refsByName') : ''
          }
        },
        filter: filterRefRows,
        renderRow(row, item) {
          const doc = row.ownerDocument
          const role = doc.createElement('span')
          role.className = 'ref-role'
          role.dataset.role = item.ref.role
          role.textContent = vt(ROLE_LABEL[item.ref.role])
          const excerpt = doc.createElement('span')
          excerpt.className = 'ref-text'
          const name = doc.createElement('span')
          name.className = 'ref-name'
          name.textContent = item.excerpt.slice(item.nameFrom, item.nameTo)
          excerpt.append(item.excerpt.slice(0, item.nameFrom), name, item.excerpt.slice(item.nameTo))
          const line = doc.createElement('span')
          line.className = 'symbol-line'
          line.textContent = String(item.ref.line)
          row.append(role, excerpt, line)
        },
        positionOf: (item) => item.ref.from,
        placeholder: () => vt('refsPlaceholder'),
        label: () => vt('refsLabel', { name: listedName })
      })
      note = next.dom.ownerDocument.createElement('div')
      note.className = 'code-nav-note'
      note.hidden = true
      note.setAttribute('role', 'status')
      next.dom.append(note)
    },
    setKeys(map) {
      if (view === null) return
      const next = map ?? defaultKeys(platform)
      // Do not rebuild for a re-send of the same keys (a `resource` for theme / language).
      const signature = JSON.stringify(VIEWER_KEYBINDING_COMMAND_IDS.map((id) => next[id] ?? null))
      if (signature === keysSignature) return
      keysSignature = signature
      view.dispatch({ effects: keys.reconfigure(keymapFor(next)) })
    },
    goToDeclaration: (pos) => goToDeclaration(pos),
    listReferences: (pos) => listReferences(pos),
    run(action) {
      const pos = menuPos ?? headOf()
      menuPos = null
      view?.focus()
      return action === 'declaration' ? goToDeclaration(pos) : listReferences(pos)
    },
    probeContextMenu(event) {
      menuPos = null
      if (view === null) return { codeNav: false, keepSelection: true }
      const target = event.target as Node | null
      if (target === null || !view.contentDOM.contains(target)) return { codeNav: false, keepSelection: true }
      const language = languageNameOf(view.state)
      if (!supportsReferences(language)) return { codeNav: false, keepSelection: true }
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (pos === null) return { codeNav: false, keepSelection: true }
      if (identifierAt(syntaxTree(view.state), view.state.doc, language!, pos) === null) {
        return { codeNav: false, keepSelection: true }
      }
      const main = view.state.selection.main
      const inside = !main.empty && pos >= main.from && pos <= main.to
      // If clicked outside the selection, move the cursor there (same as VS Code). Inside the selection, keep the selection.
      if (!inside) view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' })
      menuPos = pos
      return { codeNav: true, keepSelection: main.empty || inside }
    },
    destroy() {
      hideNote()
      picker?.element.remove()
      note?.remove()
      picker = null
      note = null
      view = null
    }
  }
}
