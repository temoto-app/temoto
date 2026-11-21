/**
 * Extension settings (TODO 1225, ARCHITECTURE 7.2.1). Fields are declared with `configuration` in the manifest, the user changes values in the "Settings" of
 * the extension's details, and the extension reads **only its own** values with `aios.settings.get()` (through the Broker). A small subset modeled on VS Code's
 * `contributes.configuration` (a `title` and a `properties` table, `type` / `default` / `description`).
 *
 * **There are no privileges here.** It holds only shapes, limits and value validation (pure functions), and main (manifest validation, storage, Broker) and the renderer (drawing the fields)
 * use the same functions. Storage is main's `PluginSettingsStore` (`plugins.settings` in `app_settings`).
 *
 * **Secrets are not put through this entry point** (tokens and passwords go through the credentials entry point: credentials in 7.7, "the owner of the credentials" in fix Z). A field whose name looks like a secret
 * is not loaded by manifest validation. Values are kept in plaintext in `app_settings` (inside the encrypted DB), and no value appears in logs or audit.
 */

import { matchesSettingFormat, type SettingFormat } from './setting-format.js'

/** The value of one field. A boolean, a string, or a list of strings (one per row). */
export type PluginSettingValue = boolean | string | readonly string[]

export type PluginSettingValues = Readonly<Record<string, PluginSettingValue>>

interface SettingBase {
  /** The field's heading (optional; the name if absent). VS Code builds the heading from the key, but this was added so that headings can be written in Japanese. */
  readonly title?: string
  /** The field's description. For a dangerous setting, state the danger clearly here. */
  readonly description: string
  /** The order (ascending; if absent, after those in declaration order). VS Code's `order`. */
  readonly order?: number
}

/**
 * The format of a string (and of one item of a list) (fix X, code-review and security review). In the same place as VS Code's `format`, and the value is only a name from the fixed table main holds
 * (`SETTING_FORMATS` in `setting-format.ts`). Arbitrary regular expressions (`pattern`) cannot be written. Main validates before saving and refuses a value that does not match
 * (it does not fix it silently). The description shown in the field is aios's wording (per format name, ja / en).
 */
interface SettingShape {
  readonly format?: SettingFormat
}

export type PluginSettingDeclaration =
  | (SettingBase & { readonly type: 'boolean'; readonly default: boolean })
  | (SettingBase & SettingShape & { readonly type: 'string'; readonly default: string; readonly maxLength?: number })
  | (SettingBase & {
      readonly type: 'array'
      /** As in VS Code, the shape of an item is written in `items`. */
      readonly items: { readonly type: 'string' } & SettingShape
      readonly default: readonly string[]
      /** Upper limit of the length of one item. */
      readonly maxLength?: number
      readonly maxItems?: number
    })

/** The `configuration` of the manifest (one section of VS Code's `contributes.configuration`). */
export interface PluginConfigurationDeclaration {
  readonly title?: string
  readonly properties: Readonly<Record<string, PluginSettingDeclaration>>
}

export const PLUGIN_SETTING_LIMITS = {
  /** The number of fields. */
  properties: 32,
  title: 64,
  description: 1_000,
  /** The default and upper limit of the length of a string (and of one item of a list). */
  defaultMaxLength: 500,
  maxLength: 2_000,
  /** The default and upper limit of the number of items in a list. */
  defaultMaxItems: 100,
  maxItems: 500,
  /** Upper limit of the length of one extension's values as JSON (characters). */
  totalChars: 64 * 1024
} as const

/** The form of a field name (unique within the extension. `.` is not used; the extension id is the namespace). */
export const PLUGIN_SETTING_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/

/**
 * Field names that look like secrets. This entry point is for plaintext settings, so tokens and the like must not be put here (use the credentials entry point). Manifest validation rejects them.
 */
export const SECRET_LIKE_SETTING_NAME_RE = /(token|secret|password|passwd|passphrase|credential|apikey|privatekey|cookie)/i

// eslint-disable-next-line no-control-regex -- an expression for refusing control characters
const CONTROLS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]')

function maxLengthOf(declaration: PluginSettingDeclaration): number {
  return declaration.type === 'boolean' ? 0 : (declaration.maxLength ?? PLUGIN_SETTING_LIMITS.defaultMaxLength)
}

function maxItemsOf(declaration: PluginSettingDeclaration): number {
  return declaration.type === 'array' ? (declaration.maxItems ?? PLUGIN_SETTING_LIMITS.defaultMaxItems) : 0
}

/** Whether it is a one-line string (non-empty, no control characters or newlines, within the limit). */
function isLine(value: unknown, max: number, allowEmpty: boolean): value is string {
  return typeof value === 'string' && (allowEmpty || value !== '') && value.length <= max && !CONTROLS.test(value)
}

/** The format of a field's items (`format` of the declaration; the field itself for a string, `items` for a list). undefined if none. */
export function settingFormatOf(declaration: PluginSettingDeclaration): SettingFormat | undefined {
  if (declaration.type === 'string') return declaration.format
  if (declaration.type === 'array') return declaration.items.format
  return undefined
}

/**
 * Whether one value (a string or one item of a list) matches the item's format. True if there is no format declaration. An empty string (a string field's "not entered") is not checked against the format
 * (list items have already refused empty ones).
 */
export function matchesFormat(format: SettingFormat | undefined, value: string): boolean {
  if (format === undefined || value === '') return true
  return matchesSettingFormat(format, value)
}

/** Validates the value of one field. null if it does not pass. A list has duplicates dropped (order is kept). */
export function checkPluginSettingValue(declaration: PluginSettingDeclaration, raw: unknown): PluginSettingValue | null {
  switch (declaration.type) {
    case 'boolean':
      return typeof raw === 'boolean' ? raw : null
    case 'string':
      return isLine(raw, maxLengthOf(declaration), true) && matchesFormat(declaration.format, raw) ? raw : null
    case 'array': {
      if (!Array.isArray(raw) || raw.length > maxItemsOf(declaration)) return null
      const out: string[] = []
      let total = 0
      for (const item of raw as unknown[]) {
        if (!isLine(item, maxLengthOf(declaration), false)) return null
        total += item.length
        if (!out.includes(item)) out.push(item)
      }
      // Cut by the total length before looking at the shape (the total limit is also checked at the save entry point).
      if (total > PLUGIN_SETTING_LIMITS.totalChars) return null
      return out.every((item) => matchesFormat(declaration.items.format, item)) ? out : null
    }
  }
}

/** Whether the shape of the declaration's default value fits the field's type and limits (used by manifest validation). */
export function isValidSettingDefault(declaration: PluginSettingDeclaration): boolean {
  return checkPluginSettingValue(declaration, declaration.default) !== null
}

/** Field names in display order (order -> declaration order). */
export function orderedSettingNames(configuration: PluginConfigurationDeclaration): readonly string[] {
  const names = Object.keys(configuration.properties)
  return names
    .map((name, index) => ({ name, index, order: configuration.properties[name]?.order ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((entry) => entry.name)
}

function defaultOf(declaration: PluginSettingDeclaration): PluginSettingValue {
  return declaration.type === 'array' ? [...declaration.default] : declaration.default
}

/** How one field's saved value is read (fix X): unset (default), a value that could be read, or **saved but not matching the current declaration**. */
type StoredField =
  | { readonly kind: 'unset' }
  | { readonly kind: 'ok'; readonly value: PluginSettingValue }
  | { readonly kind: 'invalid' }

function readStoredField(declaration: PluginSettingDeclaration, record: Record<string, unknown>, name: string): StoredField {
  if (!Object.hasOwn(record, name)) return { kind: 'unset' }
  const value = checkPluginSettingValue(declaration, record[name])
  return value === null ? { kind: 'invalid' } : { kind: 'ok', value }
}

function recordOf(stored: unknown): Record<string, unknown> {
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}
}

/**
 * The values an extension reads: for each declared field, the saved value if it matches the current declaration, **otherwise the default if nothing was saved**.
 * **A field that was saved but does not match the current declaration (an update that changed the type / limit / format, a value of an old shape) is not put into the values** (security review of fix X: falling back
 * to the default would, for an allowlist, fall open into "not restricting"). The extension treats "a declared field is missing from the values" as "unreadable" and fails closed
 * (`aios.gmail` emits no events for that run if there is no allowlist). Names not in the declaration are dropped (values from old versions' fields or strays are not passed on).
 */
export function resolvePluginSettings(
  configuration: PluginConfigurationDeclaration | undefined,
  stored: unknown
): PluginSettingValues {
  if (configuration === undefined) return {}
  const record = recordOf(stored)
  const out: Record<string, PluginSettingValue> = {}
  for (const name of orderedSettingNames(configuration)) {
    const declaration = configuration.properties[name]
    if (declaration === undefined) continue
    const read = readStoredField(declaration, record, name)
    if (read.kind === 'ok') out[name] = read.value
    else if (read.kind === 'unset') out[name] = defaultOf(declaration)
  }
  return out
}

/**
 * Validation of **an update to one field** coming from the renderer (fix X, code-review. Always run in main). The value only if the name is a declared field and the value fits its type, limits and format
 * (for a list, the form with duplicates dropped). null if it does not fit. Other fields are not touched, so changing two fields in a row does not roll back the earlier save.
 * The total length limit is checked by the store (`PluginSettingsStore.update`) together with the other saved fields.
 */
export function checkPluginSettingUpdate(
  configuration: PluginConfigurationDeclaration | undefined,
  name: unknown,
  raw: unknown
): PluginSettingValue | null {
  if (configuration === undefined || typeof name !== 'string' || !Object.hasOwn(configuration.properties, name)) return null
  const declaration = configuration.properties[name]
  return declaration === undefined ? null : checkPluginSettingValue(declaration, raw)
}

/** One field of the "Settings" in an extension's details (the shape passed to the renderer). */
export interface PluginSettingField {
  readonly name: string
  readonly type: PluginSettingDeclaration['type']
  readonly title: string
  readonly description: string
  readonly default: PluginSettingValue
  readonly value: PluginSettingValue
  /** Upper limit of the length of a string / one list item (0 for booleans). */
  readonly maxLength: number
  /** Upper limit of the number of list items (0 if not a list). */
  readonly maxItems: number
  /** The format of the items (`format`, fix X). The renderer validates with the same function before saving and points out non-matching rows in the field (main also re-validates before saving). */
  readonly format?: SettingFormat
  /**
   * Fix X: the saved value does not match the current declaration (type, limit, format) and **has not been passed to the extension**. The field says "not used because it does not match the current form" and
   * makes the user fix it. `value` is the saved row (so it can be fixed, when it can be read as a list of strings) or the default.
   */
  readonly storedInvalid?: boolean
}

export interface PluginSettingsView {
  readonly pluginId: string
  /** `configuration.title` (null if none). */
  readonly title: string | null
  readonly fields: readonly PluginSettingField[]
  /**
   * TODO 1237: a saved value exists, but it was saved by an extension with different contents (an update or replacement), so it is not used (it went back to the default).
   * A single note is shown in the details "Settings". Not set for bundled extensions or when there is no value.
   */
  readonly reset?: boolean
}

/** Builds the fields of the details from the declaration and the current values. No fields if there is no declaration. */
export function pluginSettingsView(
  pluginId: string,
  configuration: PluginConfigurationDeclaration | undefined,
  stored: unknown
): PluginSettingsView {
  if (configuration === undefined) return { pluginId, title: null, fields: [] }
  const record = recordOf(stored)
  const fields: PluginSettingField[] = []
  for (const name of orderedSettingNames(configuration)) {
    const declaration = configuration.properties[name]
    if (declaration === undefined) continue
    const read = readStoredField(declaration, record, name)
    const raw = record[name]
    const value: PluginSettingValue =
      read.kind === 'ok'
        ? read.value
        : read.kind === 'invalid' && declaration.type === 'array' && Array.isArray(raw) && raw.every((item) => typeof item === 'string')
          ? (raw as string[])
          : read.kind === 'invalid' && declaration.type === 'string' && typeof raw === 'string'
            ? raw
            : defaultOf(declaration)
    const format = settingFormatOf(declaration)
    fields.push({
      name,
      type: declaration.type,
      title: declaration.title ?? name,
      description: declaration.description,
      default: declaration.type === 'array' ? [...declaration.default] : declaration.default,
      value,
      maxLength: maxLengthOf(declaration),
      maxItems: maxItemsOf(declaration),
      ...(format === undefined ? {} : { format }),
      ...(read.kind === 'invalid' ? { storedInvalid: true } : {})
    })
  }
  return { pluginId, title: configuration.title ?? null, fields }
}
