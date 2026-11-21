/**
 * Keyboard shortcut table (TODO 549, ARCHITECTURE 5.5.2): one table of **command ID -> default key**, plus
 * reading and writing key strings, matching them against pressed keys, and detecting conflicts. It depends on
 * neither the DOM nor electron (main, renderer and tests all use it).
 *
 * Before this, assignments were scattered over 4 places (the renderer's keydown / menu accelerators / the viewer
 * itself / main's `before-input-event`), each written differently (see the table at the top of
 * `src/renderer/src/shortcuts.ts`). The keys are still caught in those 4 places (an accelerator that electron
 * eats first, and pages in another webContents, cannot be caught by the renderer's keydown), but **which key
 * it is comes from this one table**. The user's assignments (`ui.keybindings` in `app_settings`, owned by main)
 * are a diff of "only the commands changed from the default"; resetting to the default removes the key itself.
 *
 * - **Keys inside a viewer (CodeMirror's Cmd+F / Cmd+D / Cmd+R ...) are out of scope** (owner decision 2026-10-09).
 *   CodeMirror's keymap takes them directly inside the plugin's iframe. **The exception is the two of TODO 692**
 *   (go to declaration F12 / list assignments and uses Shift+F12, owner decision 2026-10-11): rows with scope
 *   `viewer`; the host puts the active keys in `resource` and passes them to the viewer
 *   (`ViewerHostMessage.editorKeys`), and the viewer builds them into CodeMirror's keymap (`codeMirrorKeysOf`).
 * - Key strings use electron's accelerator format (`CmdOrCtrl+Shift+F`), so they can be passed to the menu as is.
 *   `CmdOrCtrl` is Cmd on mac and Ctrl elsewhere. The renderer catches **only the default `CmdOrCtrl`** with
 *   either Cmd or Ctrl (`metaKey || ctrlKey` in `searchShortcut`; the owner uses Ctrl on mac too). A key the user
 *   records is kept as pressed, `Cmd` / `Ctrl`.
 * - A key with no modifier (Cmd / Ctrl / Alt) cannot be assigned (it would steal text input). F1-F24 are the exception.
 */

export type KeyPlatform = 'mac' | 'other'

/**
 * Where a key is caught.
 * - `renderer`: the renderer's top-level keydown (and keys sent back from a viewer / web page).
 * - `menu`: a menu accelerator (main rebuilds the menu). Works even when a viewer (OOPIF) or a page has focus.
 * - `web`: only while a web page (`WebContentsView`) has focus (main's `before-input-event`).
 * - `global`: an OS-wide hotkey (TODO 976 part 1). Main registers it with `globalShortcut`. Works even when aios is not frontmost.
 * - `viewer`: only inside a viewer's (plugin iframe) editor (TODO 692). CodeMirror's keymap takes it. The host does not put it in the
 *   send-back table (`ViewerHostMessage.shortcuts`); it passes the active keys as `editorKeys`.
 */
export type KeybindingScope = 'renderer' | 'menu' | 'web' | 'viewer' | 'global'

/** The commands of the table. The order is the order on the settings screen. */
export const KEYBINDING_COMMAND_IDS = [
  'search.files',
  'search.names',
  'search.conversation',
  'find',
  'thread.new',
  'view.threads',
  'view.files',
  'view.extensions',
  'view.toggleSidebar',
  'view.hiddenFiles',
  'app.settings',
  'file.save',
  'viewer.back',
  'viewer.forward',
  'nav.back',
  'nav.forward',
  'web.reload',
  'web.newTab',
  'web.closeTab',
  'web.focusAddress',
  'web.nextTab',
  'web.prevTab',
  'code.goToDeclaration',
  'code.listReferences',
  'app.summon',
  'app.summonDictate',
  'composer.dictate'
] as const

export type KeybindingCommandId = (typeof KEYBINDING_COMMAND_IDS)[number]

export interface KeybindingCommand {
  readonly id: KeybindingCommandId
  readonly scope: KeybindingScope
  readonly defaults: Readonly<Record<KeyPlatform, string | null>>
}

function both(key: string): Readonly<Record<KeyPlatform, string>> {
  return { mac: key, other: key }
}

/**
 * **The canonical default keys.** The accelerators in `menu-model.ts` and the matching in `shortcuts.ts` read from here
 * (`test/keybindings.test.ts` checks they equal the values of the old code).
 */
export const KEYBINDING_COMMANDS: readonly KeybindingCommand[] = [
  // The three searches and Cmd+F (items 46 / 48 / 189 / TODO 496). Not an accelerator (Cmd+F would collide with the viewer editor's search).
  { id: 'search.files', scope: 'renderer', defaults: both('CmdOrCtrl+Shift+F') },
  { id: 'search.names', scope: 'renderer', defaults: both('CmdOrCtrl+P') },
  { id: 'search.conversation', scope: 'renderer', defaults: both('CmdOrCtrl+K') },
  // Search within the current place: thread search in a ThreadPane, in-page search for a web page, otherwise body search (same as Cmd+Shift+F).
  { id: 'find', scope: 'renderer', defaults: both('CmdOrCtrl+F') },
  // Menu accelerators (items 195 / 313 / 261, TODO 367 / 408).
  { id: 'thread.new', scope: 'menu', defaults: both('CmdOrCtrl+Shift+O') },
  { id: 'view.threads', scope: 'menu', defaults: { mac: 'Ctrl+Cmd+I', other: 'Ctrl+Alt+I' } },
  { id: 'view.files', scope: 'menu', defaults: both('CmdOrCtrl+Shift+E') },
  { id: 'view.extensions', scope: 'menu', defaults: both('CmdOrCtrl+Shift+X') },
  { id: 'view.toggleSidebar', scope: 'menu', defaults: both('CmdOrCtrl+B') },
  { id: 'view.hiddenFiles', scope: 'menu', defaults: both('CmdOrCtrl+Shift+.') },
  { id: 'app.settings', scope: 'menu', defaults: both('CmdOrCtrl+,') },
  { id: 'file.save', scope: 'menu', defaults: both('CmdOrCtrl+S') },
  // Viewer back / forward (TODO 369). On mac Cmd+- is zoom out, so Ctrl; elsewhere Alt+Left / Alt+Right as in VS Code.
  { id: 'viewer.back', scope: 'renderer', defaults: { mac: 'Ctrl+-', other: 'Alt+Left' } },
  { id: 'viewer.forward', scope: 'renderer', defaults: { mac: 'Ctrl+Shift+-', other: 'Alt+Right' } },
  // App-wide back / forward (TODO 801): the title bar arrows. Keys in the same direction as VS Code's Go Back (Cmd+[ / Cmd+] on mac).
  // Separate from the viewer's Ctrl+- / Alt+Left. On other OSes Alt+Shift+Left / Alt+Shift+Right (Alt+Left is for the viewer).
  { id: 'nav.back', scope: 'renderer', defaults: { mac: 'Cmd+[', other: 'Alt+Shift+Left' } },
  { id: 'nav.forward', scope: 'renderer', defaults: { mac: 'Cmd+]', other: 'Alt+Shift+Right' } },
  // Reload a web page (TODO 400). Only while the page has focus.
  { id: 'web.reload', scope: 'web', defaults: both('CmdOrCtrl+R') },
  // Web tabs (TODO 531, same keys as Chrome). Only while the Web pane is in front (the renderer's keydown, and keys sent back
  // while the page has focus). Only Cmd+W is a menu accelerator ("Close"): it closes the tab if a Web tab is in front, otherwise the window.
  // Only web.newTab (Cmd+T) also works when the pane is not in front (TODO 771: an empty ViewerPane = open a blank tab).
  { id: 'web.newTab', scope: 'renderer', defaults: both('CmdOrCtrl+T') },
  { id: 'web.closeTab', scope: 'menu', defaults: both('CmdOrCtrl+W') },
  { id: 'web.focusAddress', scope: 'renderer', defaults: both('CmdOrCtrl+L') },
  { id: 'web.nextTab', scope: 'renderer', defaults: both('Ctrl+Tab') },
  { id: 'web.prevTab', scope: 'renderer', defaults: both('Ctrl+Shift+Tab') },
  // Inside the code viewer (TODO 692, same keys as VS Code). Mac laptops need fn (same as VS Code, owner decision 2026-10-11).
  { id: 'code.goToDeclaration', scope: 'viewer', defaults: both('F12') },
  { id: 'code.listReferences', scope: 'viewer', defaults: both('Shift+F12') },
  // Bring aios to the front from any app and focus the Composer of a new conversation (TODO 976 part 1, default Ctrl+Alt+Space by owner decision 2026-11-08).
  // Registered OS-wide, so it may collide with other apps (a registration failure is shown on the settings screen). Unassigning it means no registration.
  { id: 'app.summon', scope: 'global', defaults: both('Ctrl+Alt+Space') },
  // Bring aios to the front and start dictation at once (TODO 1267). Same path as `app.summon`, plus "start recording" for the Composer.
  // **No default** (owner decision 2026-11-20): people who want it assign a key in Settings -> Keyboard. Unassigned means no registration.
  { id: 'app.summonDictate', scope: 'global', defaults: { mac: null, other: null } },
  // Start / stop dictation (TODO 1268). Only while the Composer's input field has focus (the field's keydown). Matched with the modifiers exactly as
  // pressed, so on mac Ctrl+D (emacs-style delete forward) stays a text operation. No other row uses CmdOrCtrl+D; the only same key is CodeMirror's
  // "select next occurrence" inside a viewer iframe, which this table does not forward (out of scope, see above), so the two never meet.
  { id: 'composer.dictate', scope: 'renderer', defaults: both('CmdOrCtrl+D') }
]

/** Commands inside a viewer (scope `viewer`, TODO 692). */
export const VIEWER_KEYBINDING_COMMAND_IDS = ['code.goToDeclaration', 'code.listReferences'] as const satisfies readonly KeybindingCommandId[]

export type ViewerKeybindingCommandId = (typeof VIEWER_KEYBINDING_COMMAND_IDS)[number]

export function isViewerKeybindingCommandId(value: unknown): value is ViewerKeybindingCommandId {
  return (VIEWER_KEYBINDING_COMMAND_IDS as readonly unknown[]).includes(value)
}

const COMMANDS_BY_ID: ReadonlyMap<string, KeybindingCommand> = new Map(
  KEYBINDING_COMMANDS.map((command) => [command.id, command])
)

export function isKeybindingCommandId(value: unknown): value is KeybindingCommandId {
  return typeof value === 'string' && COMMANDS_BY_ID.has(value)
}

export function keybindingCommand(id: KeybindingCommandId): KeybindingCommand {
  return COMMANDS_BY_ID.get(id) as KeybindingCommand
}

/** The commands registered OS-wide (scope `global`). Each has its own registration result. */
export const GLOBAL_HOTKEY_IDS = ['app.summon', 'app.summonDictate'] as const satisfies readonly KeybindingCommandId[]

export type GlobalHotkeyId = (typeof GLOBAL_HOTKEY_IDS)[number]

/** The registration results of all global hotkeys, by command id. */
export type GlobalHotkeyStatuses = Readonly<Record<GlobalHotkeyId, GlobalHotkeyStatus>>

/** The result of registering one global hotkey (`app.summon`, TODO 976 part 1; `app.summonDictate`, TODO 1267). */
export interface GlobalHotkeyStatus {
  readonly accelerator: string | null
  /**
   * `off` = not assigned, `failed` = could not register (for example another app uses it),
   * `disabled` = not registered in this instance (dev, verification build, duplicated userData; TODO 976 review Y-2).
   */
  readonly state: 'off' | 'registered' | 'failed' | 'disabled'
}

/** The user's assignments (only commands changed from the default). null means "the assignment was removed". */
export type KeybindingOverrides = Readonly<Partial<Record<KeybindingCommandId, string | null>>>

/** A parsed key string. `primary` stands for `CmdOrCtrl`. */
export interface ParsedKeybinding {
  readonly primary: boolean
  readonly cmd: boolean
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  /** The canonical name (`F` / `,` / `Left` / `Tab` / `F5` ...). Letters are upper case. */
  readonly key: string
}

/** Named keys: `KeyboardEvent.key` -> table name. */
const NAMED_FROM_EVENT: Readonly<Record<string, string>> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Esc',
  ' ': 'Space',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown'
}

/** Table name -> `KeyboardEvent.key` (the `key` of the send-back table for viewers / web pages). */
const EVENT_FROM_NAMED: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(NAMED_FROM_EVENT).map(([event, name]) => [name, event])
)

/** `KeyboardEvent.code` -> symbol (the US layout's legend). Symbols with Shift / Alt are read from the physical key. */
const SYMBOL_FROM_CODE: Readonly<Record<string, string>> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`'
}

/** The character produced when Shift is held (US layout). Used for input without a `code` and for the `key` of the send-back table. */
const US_SHIFTED: Readonly<Record<string, string>> = {
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  ';': ':',
  "'": '"',
  ',': '<',
  '.': '>',
  '/': '?',
  '\\': '|',
  '`': '~',
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')'
}

/** The character produced when the same physical key (named by its US legend) is pressed with Shift on a JIS layout. */
const JIS_SHIFTED: Readonly<Record<string, string>> = {
  '-': '=',
  '=': '~',
  '[': '`',
  ']': '{',
  ';': '+',
  "'": '*',
  '\\': '}',
  ',': '<',
  '.': '>',
  '/': '?',
  '1': '!',
  '2': '"',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '&',
  '7': "'",
  '8': '(',
  '9': ')'
}

const US_UNSHIFTED: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(US_SHIFTED).map(([base, shifted]) => [shifted, base])
)

/** Keys that cannot stand alone as a key: modifier keys themselves, composition in progress, and so on. */
const NOT_A_KEY = new Set([
  'Meta',
  'Control',
  'Alt',
  'Shift',
  'CapsLock',
  'OS',
  'Fn',
  'FnLock',
  'AltGraph',
  'Dead',
  'Process',
  'Unidentified',
  'Hyper',
  'Super'
])

const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/

/** Whether it is accepted as a table name (alphanumeric, a single symbol, a named key, an F key). `+` is the separator, so it is `Plus`. */
function isKeyName(name: string): boolean {
  if (FUNCTION_KEY.test(name)) return true
  if (name in EVENT_FROM_NAMED) return true
  if (name === 'Plus') return true
  if (name.length !== 1) return false
  const code = name.codePointAt(0) ?? 0
  return code > 0x20 && code < 0x7f && name !== '+'
}

/** Modifier names (electron's aliases are accepted too). */
const MODIFIER_ALIASES: Readonly<Record<string, 'primary' | 'cmd' | 'ctrl' | 'alt' | 'shift'>> = {
  cmdorctrl: 'primary',
  commandorcontrol: 'primary',
  cmd: 'cmd',
  command: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift'
}

/** Parses a key string. Returns null if it cannot be read or has no modifier (except F keys). */
export function parseKeybinding(text: unknown): ParsedKeybinding | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 64) return null
  const parts = text.split('+')
  const keyPart = parts.pop()
  if (keyPart === undefined || keyPart === '') return null
  const mods = { primary: false, cmd: false, ctrl: false, alt: false, shift: false }
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()]
    if (mod === undefined || mods[mod]) return null
    mods[mod] = true
  }
  const key = keyPart.length === 1 ? keyPart.toUpperCase() : keyPart
  if (!isKeyName(key)) return null
  if (mods.primary && (mods.cmd || mods.ctrl)) return null
  if (!mods.primary && !mods.cmd && !mods.ctrl && !mods.alt && !FUNCTION_KEY.test(key)) return null
  return { ...mods, key }
}

/** The canonical form (modifiers in the order `CmdOrCtrl` / `Ctrl` / `Cmd` / `Alt` / `Shift`). */
export function formatKeybinding(parsed: ParsedKeybinding): string {
  const parts: string[] = []
  if (parsed.primary) parts.push('CmdOrCtrl')
  if (parsed.ctrl) parts.push('Ctrl')
  if (parsed.cmd) parts.push('Cmd')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(parsed.key)
  return parts.join('+')
}

/** Rewrites to the canonical form. Returns null if it cannot be read. */
export function normalizeKeybinding(text: unknown): string | null {
  const parsed = parseKeybinding(text)
  return parsed === null ? null : formatKeybinding(parsed)
}

/** The modifiers actually pressed on that platform (`CmdOrCtrl` expanded). */
export interface ConcreteKeybinding {
  readonly meta: boolean
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly key: string
}

export function concreteKeybinding(parsed: ParsedKeybinding, platform: KeyPlatform): ConcreteKeybinding {
  return {
    meta: parsed.cmd || (parsed.primary && platform === 'mac'),
    ctrl: parsed.ctrl || (parsed.primary && platform !== 'mac'),
    alt: parsed.alt,
    shift: parsed.shift,
    key: parsed.key
  }
}

/** One string for comparing conflicts (the same for the same physical key). null if it cannot be read. */
export function keybindingIdentity(text: string, platform: KeyPlatform): string | null {
  const parsed = parseKeybinding(text)
  if (parsed === null) return null
  const c = concreteKeybinding(parsed, platform)
  return `${c.ctrl ? 'C' : ''}${c.alt ? 'A' : ''}${c.shift ? 'S' : ''}${c.meta ? 'M' : ''}+${c.key}`
}

const MAC_KEY_SYMBOLS: Readonly<Record<string, string>> = {
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓',
  Plus: '+'
}

/**
 * The notation shown on screen. On mac, symbols in the order Ctrl Alt Shift Cmd (Apple's order); elsewhere `Ctrl+Alt+Shift+F`. The original string if it cannot be read.
 */
export function displayKeybinding(text: string, platform: KeyPlatform): string {
  const parsed = parseKeybinding(text)
  if (parsed === null) return text
  const c = concreteKeybinding(parsed, platform)
  if (platform === 'mac') {
    const key = MAC_KEY_SYMBOLS[c.key] ?? c.key
    return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.meta ? '⌘' : ''}${key}`
  }
  const key = c.key === 'Left' ? '←' : c.key === 'Right' ? '→' : c.key === 'Up' ? '↑' : c.key === 'Down' ? '↓' : c.key
  const parts: string[] = []
  if (c.ctrl) parts.push('Ctrl')
  if (c.alt) parts.push('Alt')
  if (c.shift) parts.push('Shift')
  if (c.meta) parts.push('Win')
  parts.push(key)
  return parts.join('+')
}

/** The part of a `KeyboardEvent` (and electron's `Input`, normalized to it) that is used for matching. */
export interface KeyInput {
  readonly key: string
  readonly code?: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
}

/**
 * The table name of the pressed key. null if it is a modifier key itself.
 *
 * - Letters use `key` (as laid out); if `key` is not a letter (for example mac, where Alt makes a different character), `KeyX` of `code`.
 * - Digits and symbols use `key` itself when neither Shift nor Alt is held (a JIS `@` stays as is). With Shift / Alt the physical key
 *   (`code`) is read by its US legend, so that Ctrl+Shift+- arriving as `_` on US and `=` on JIS becomes the same `-` (TODO 369).
 */
export function keyNameOf(input: Pick<KeyInput, 'key' | 'code' | 'shiftKey' | 'altKey'>): string | null {
  const { key, code } = input
  const named = NAMED_FROM_EVENT[key]
  if (named !== undefined) return named
  if (FUNCTION_KEY.test(key)) return key
  if (NOT_A_KEY.has(key)) return null
  if (key.length === 1 && /[a-z]/i.test(key)) return key.toUpperCase()
  const letter = code === undefined ? null : /^Key([A-Z])$/.exec(code)
  if (letter !== null && letter[1] !== undefined) return letter[1]
  const digit = code === undefined ? null : /^Digit([0-9])$/.exec(code)
  if (!input.shiftKey && !input.altKey && key.length === 1 && isKeyName(key)) return key
  if (digit !== null && digit[1] !== undefined) return digit[1]
  const symbol = code === undefined ? undefined : SYMBOL_FROM_CODE[code]
  if (symbol !== undefined) return symbol
  if (key.length !== 1) return null
  if (input.shiftKey) {
    // Input without a `code` (tests, old paths). Only restores the US Shift characters and JIS Shift+- (`=`).
    const base = US_UNSHIFTED[key] ?? (key === '=' ? '-' : undefined)
    if (base !== undefined) return base
  }
  return isKeyName(key) ? key : null
}

/** Turns the pressed key into a key string for recording (null if a modifier is missing or only modifier keys are held). */
export function keybindingFromInput(input: KeyInput, platform: KeyPlatform): string | null {
  const key = keyNameOf(input)
  if (key === null) return null
  const parsed: ParsedKeybinding = {
    primary: false,
    // The Win key on other platforms is not used for assignments.
    cmd: platform === 'mac' && input.metaKey,
    ctrl: input.ctrlKey,
    alt: input.altKey,
    shift: input.shiftKey,
    key: key === '+' ? 'Plus' : key
  }
  return normalizeKeybinding(formatKeybinding(parsed))
}

/**
 * Whether the key string matches the pressed key. With `lenient`, `CmdOrCtrl` matches either Cmd or Ctrl
 * (the renderer's long-standing way, `metaKey || ctrlKey` in `searchShortcut`).
 */
export function matchesKeybinding(
  text: string,
  input: KeyInput,
  platform: KeyPlatform,
  lenient = false
): boolean {
  const parsed = parseKeybinding(text)
  if (parsed === null) return false
  const key = keyNameOf(input)
  if (key === null || (key === '+' ? 'Plus' : key) !== parsed.key) return false
  if (parsed.alt !== input.altKey || parsed.shift !== input.shiftKey) return false
  const c = concreteKeybinding(parsed, platform)
  if (c.meta === input.metaKey && c.ctrl === input.ctrlKey) return true
  return lenient && parsed.primary && (input.metaKey || input.ctrlKey)
}

/** The key in effect at that moment (null if the assignment was removed). */
export function effectiveKeybinding(
  id: KeybindingCommandId,
  platform: KeyPlatform,
  overrides: KeybindingOverrides
): string | null {
  if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id] ?? null
  return keybindingCommand(id).defaults[platform]
}

/** Whether it was changed from the default. */
export function isKeybindingModified(id: KeybindingCommandId, overrides: KeybindingOverrides): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, id)
}

/**
 * The command (among `candidates`) that matches the pressed key. First looks for one matching with the modifiers as pressed, and if none,
 * with the lenient `CmdOrCtrl` match (if the user assigns `Ctrl+F` on mac to another command, that one wins).
 */
export function resolveKeybinding<T extends KeybindingCommandId>(
  input: KeyInput,
  candidates: readonly T[],
  platform: KeyPlatform,
  overrides: KeybindingOverrides
): T | null {
  for (const lenient of [false, true]) {
    for (const id of candidates) {
      const text = effectiveKeybinding(id, platform, overrides)
      if (text !== null && matchesKeybinding(text, input, platform, lenient)) return id
    }
  }
  return null
}

/** Upper bound on the number of assignments (so a broken value cannot inflate it). */
const MAX_OVERRIDES = 200

/**
 * Validates assignments that were saved / came from the renderer. Unknown commands and unreadable keys are dropped, and assignments
 * to the same physical key as the default are removed (only the diff is kept). Keys are rewritten to the canonical form.
 */
export function sanitizeKeybindingOverrides(raw: unknown, platform: KeyPlatform): KeybindingOverrides {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Partial<Record<KeybindingCommandId, string | null>> = {}
  let count = 0
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_OVERRIDES) break
    if (!isKeybindingCommandId(id)) continue
    const fallback = keybindingCommand(id).defaults[platform]
    if (value === null) {
      if (fallback === null) continue
      out[id] = null
      count += 1
      continue
    }
    const normalized = normalizeKeybinding(value)
    if (normalized === null) continue
    if (fallback !== null && keybindingIdentity(fallback, platform) === keybindingIdentity(normalized, platform)) {
      continue
    }
    out[id] = normalized
    count += 1
  }
  return out
}

/** The diff after changing the assignment of one command (`key` undefined = reset to the default). */
export function withKeybinding(
  overrides: KeybindingOverrides,
  id: KeybindingCommandId,
  key: string | null | undefined,
  platform: KeyPlatform
): KeybindingOverrides {
  const next: Record<string, string | null> = {}
  for (const [other, value] of Object.entries(overrides)) {
    if (other !== id && value !== undefined) next[other] = value
  }
  if (key !== undefined) next[id] = key
  return sanitizeKeybindingOverrides(next, platform)
}

/** Keys that are not in the table but are held by electron roles / the OS and cannot be taken (only shown as a "conflict" on the settings screen). */
export type ReservedKeyGroup = 'edit' | 'app' | 'view'

const RESERVED: Readonly<Record<KeyPlatform, readonly (readonly [string, ReservedKeyGroup])[]>> = {
  mac: [
    ['Cmd+Z', 'edit'],
    ['Cmd+Shift+Z', 'edit'],
    ['Cmd+X', 'edit'],
    ['Cmd+C', 'edit'],
    ['Cmd+V', 'edit'],
    ['Cmd+A', 'edit'],
    ['Cmd+Q', 'app'],
    ['Cmd+H', 'app'],
    ['Cmd+Alt+H', 'app'],
    ['Cmd+M', 'app'],
    ['Cmd+N', 'app'],
    ['Cmd+0', 'view'],
    ['Cmd+=', 'view'],
    ['Cmd+Shift+=', 'view'],
    ['Cmd+-', 'view'],
    ['Cmd+Shift+R', 'view'],
    ['Cmd+Alt+I', 'view'],
    ['Ctrl+Cmd+F', 'view']
  ],
  other: [
    ['Ctrl+Z', 'edit'],
    ['Ctrl+Shift+Z', 'edit'],
    ['Ctrl+Y', 'edit'],
    ['Ctrl+X', 'edit'],
    ['Ctrl+C', 'edit'],
    ['Ctrl+V', 'edit'],
    ['Ctrl+A', 'edit'],
    ['Ctrl+Q', 'app'],
    ['Ctrl+M', 'app'],
    ['Ctrl+N', 'app'],
    ['Ctrl+0', 'view'],
    ['Ctrl+=', 'view'],
    ['Ctrl+Shift+=', 'view'],
    ['Ctrl+-', 'view'],
    ['Ctrl+Shift+R', 'view'],
    ['Ctrl+Shift+I', 'view'],
    ['F11', 'view']
  ]
}

export function reservedKeybindings(platform: KeyPlatform): readonly (readonly [string, ReservedKeyGroup])[] {
  return RESERVED[platform]
}

/** The conflict partners of one command. */
export interface KeybindingConflicts {
  readonly commands: readonly KeybindingCommandId[]
  readonly reserved: readonly ReservedKeyGroup[]
}

/** Who `key` (may be a key being recorded and not yet saved) collides with, other than `self`. */
export function conflictsOf(
  key: string,
  self: KeybindingCommandId | null,
  platform: KeyPlatform,
  overrides: KeybindingOverrides
): KeybindingConflicts {
  const identity = keybindingIdentity(key, platform)
  if (identity === null) return { commands: [], reserved: [] }
  const commands = KEYBINDING_COMMAND_IDS.filter((id) => {
    if (id === self) return false
    const other = effectiveKeybinding(id, platform, overrides)
    return other !== null && keybindingIdentity(other, platform) === identity
  })
  const reserved = [
    ...new Set(
      RESERVED[platform].filter(([text]) => keybindingIdentity(text, platform) === identity).map(([, group]) => group)
    )
  ]
  return { commands, reserved }
}

/** The modifiers and key of one row of the send-back table (same names as `ViewerShortcut` / `WebViewShortcut`). */
export interface KeyRow {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  /**
   * TODO 589: the physical key (`KeyboardEvent.code`, `KeyF` / `Digit1` / `Minus`), set only on rows with a letter, digit or symbol with Alt.
   * On mac Alt turns `key` into a different character (Alt+F = `ƒ`), so this row is matched by `code` (`rowKeyMatches`). Read the same way as the renderer's
   * `keyNameOf` (a `key` that is not a letter is read by `code`).
   */
  readonly code?: string
}

/** Symbol name -> physical key (the inverse of `SYMBOL_FROM_CODE`). */
const CODE_FROM_SYMBOL: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SYMBOL_FROM_CODE).map(([code, symbol]) => [symbol, code])
)

/** The physical key of a key name (`A` / `1` / `-`). None for named keys (arrows, Tab) and F keys (Alt does not change their `key`). */
function physicalCodeOf(keyName: string): string | undefined {
  if (/^[A-Z]$/.test(keyName)) return `Key${keyName}`
  if (/^[0-9]$/.test(keyName)) return `Digit${keyName}`
  return CODE_FROM_SYMBOL[keyName]
}

/**
 * Whether the key of a send-back table row matches the pressed key (`KeyboardEvent.key` / `code`; electron's `Input` has the same names).
 * The caller compares the modifiers. Used by `plugins/_shared/shortcuts.ts` and `matchWebShortcut`.
 *
 * - A row without `code` (no Alt): compares `key` (a single character is folded to lower case; Shift makes it `F`).
 * - A row with `code` (with Alt, TODO 589): if the pressed `key` is a letter, compares `key` (as laid out; the legend letter even on Dvorak);
 *   otherwise (mac Alt+F = `ƒ`, Alt+1 = `¡`) compares `code`, the same as `keyNameOf`.
 */
export function rowKeyMatches(
  row: { readonly key: string; readonly code?: string },
  key: string,
  code: string | undefined
): boolean {
  const pressed = key.length === 1 ? key.toLowerCase() : key
  if (row.code !== undefined) {
    if (/^[a-z]$/.test(pressed)) return pressed === row.key
    return code === row.code
  }
  const rowKey = row.key.length === 1 ? row.key.toLowerCase() : row.key
  return rowKey === pressed
}

/**
 * Expands a key string into send-back table rows. The table is matched by `KeyboardEvent.key` (a single character in lower case)
 * (`plugins/_shared/shortcuts.ts` / `matchWebShortcut`), so a Shift symbol lists both the US and the JIS characters.
 * `CmdOrCtrl` becomes rows for both Cmd and Ctrl (as with the renderer's keydown, pressing Ctrl on mac also gets through).
 * A letter, digit or symbol with Alt becomes a single row on the physical key (`code`) (TODO 589, `rowKeyMatches`).
 */
export function keyRowsOf(text: string, platform: KeyPlatform): readonly KeyRow[] {
  const parsed = parseKeybinding(text)
  if (parsed === null) return []
  const keyName = parsed.key === 'Plus' ? '+' : parsed.key
  // TODO 589: with Alt, match by the physical key (Alt turns `key` into a different character). One character is enough (do not list the US / JIS characters).
  const code = parsed.alt ? physicalCodeOf(keyName) : undefined
  let keys: string[]
  if (code !== undefined) keys = [keyName.toLowerCase()]
  else if (EVENT_FROM_NAMED[keyName] !== undefined) keys = [EVENT_FROM_NAMED[keyName] as string]
  else if (FUNCTION_KEY.test(keyName)) keys = [keyName]
  else if (/^[A-Z]$/.test(keyName)) keys = [keyName.toLowerCase()]
  else if (parsed.shift) {
    keys = [...new Set([US_SHIFTED[keyName], JIS_SHIFTED[keyName]].filter((k): k is string => k !== undefined))]
    if (keys.length === 0) keys = [keyName]
  } else keys = [keyName]
  const c = concreteKeybinding(parsed, platform)
  const mods: (readonly [boolean, boolean])[] = parsed.primary
    ? [
        [true, false],
        [false, true]
      ]
    : [[c.meta, c.ctrl]]
  const rows: KeyRow[] = []
  for (const [metaKey, ctrlKey] of mods) {
    for (const key of keys) {
      rows.push({ key, metaKey, ctrlKey, shiftKey: parsed.shift, altKey: parsed.alt, ...(code === undefined ? {} : { code }) })
    }
  }
  return rows
}

/** Whether the row has the modifiers "as pressed" on that platform (that is, it is not the lenient side's row for `CmdOrCtrl`). */
export function isPrimaryRow(row: KeyRow, text: string, platform: KeyPlatform): boolean {
  const parsed = parseKeybinding(text)
  if (parsed === null) return false
  const c = concreteKeybinding(parsed, platform)
  return row.metaKey === c.meta && row.ctrlKey === c.ctrl
}

/**
 * Expands a key string into CodeMirror keymap format (`Mod-r`, `Shift-F12`) (TODO 692). Empty if it cannot be read.
 *
 * - `CmdOrCtrl` becomes two: `Mod` (CodeMirror reads it as Cmd on mac, Ctrl elsewhere) and `Ctrl`, following the renderer's way
 *   (works with Ctrl on mac too, same as Cmd+R of 468). On other platforms the same Ctrl would appear twice, so it is folded into one.
 * - Letters are lower case (CodeMirror matches by the lower case name even with Shift); named keys use the `KeyboardEvent.key` name
 *   (`ArrowLeft` / `Escape` / `Space`). The order of modifiers does not matter, as CodeMirror reorders them.
 */
export function codeMirrorKeysOf(text: string, platform: KeyPlatform): readonly string[] {
  const parsed = parseKeybinding(text)
  if (parsed === null) return []
  let key = parsed.key === 'Plus' ? '+' : parsed.key
  if (/^[A-Z]$/.test(key)) key = key.toLowerCase()
  else if (EVENT_FROM_NAMED[key] !== undefined) key = EVENT_FROM_NAMED[key] as string
  const mods: string[] = []
  if (parsed.alt) mods.push('Alt')
  if (parsed.shift) mods.push('Shift')
  const tail = [...mods, key].join('-')
  if (parsed.primary) {
    const keys = [`Mod-${tail}`]
    if (platform === 'mac') keys.push(`Ctrl-${tail}`)
    return keys
  }
  const head: string[] = []
  if (parsed.ctrl) head.push('Ctrl')
  if (parsed.cmd) head.push('Meta')
  return [[...head, tail].join('-')]
}
