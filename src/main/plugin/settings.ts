/**
 * Home of an extension's settings (TODO 1225, ARCHITECTURE 7.2.1). **Independent of electron.**
 *
 * - The declaration is the manifest's `configuration` (as read by PluginHost). Values live per plugin id in `plugins.settings` of
 *   `app_settings` (the encrypted DB), and **this class is the only writer** (the owner for `lint:settings-owner` is main).
 * - There are two ways to read: the extension detail's "Settings" (renderer, `view`) and the extension itself (`values`, looked up by
 *   the id of the extension the Broker's `settings.get` was called for). Both **re-check against the current declaration** on every read -
 *   a field that disappeared from the declaration, or a value whose type or limit changed, is not passed on and falls back to the default.
 * - The only way to write is `update` (fix X, code-review: **one field**). It re-checks the value of one field from the renderer against the
 *   declaration (`checkPluginSettingUpdate`) and refuses without writing anything if it does not pass. It does not touch the saved values of
 *   other fields (previously every field was sent, so changing two fields in a row made the second save roll back the first with stale values).
 * - Values are not logged (they may hold things like a table of email addresses). Only the plugin id and the number of fields are logged.
 */
import {
  checkPluginSettingUpdate,
  PLUGIN_SETTING_LIMITS,
  pluginSettingsView,
  resolvePluginSettings,
  type PluginConfigurationDeclaration,
  type PluginSettingValues,
  type PluginSettingsView
} from '@shared/plugin-settings.js'
import { reasonError } from '@shared/reason.js'
import { errorFields, log } from '../../common/logger.js'
import { PLUGIN_SETTINGS_OWNERS_KEY } from '../../common/settings-keys.js'

export type StoredPluginSettings = Readonly<Record<string, Readonly<Record<string, unknown>>>>

export interface PluginSettingsDeps {
  /** Read `plugins.settings` (`{}` if it is broken). */
  read(): StoredPluginSettings
  write(value: StoredPluginSettings): void
  /** The declaration of an installed extension (found even if disabled; whether it is installed is told apart by `known`, since this returns undefined when not installed). */
  configurationOf(pluginId: string): PluginConfigurationDeclaration | undefined
  /** Whether the extension is installed (including disabled ones). */
  known(pluginId: string): boolean
  /**
   * TODO 1237: the extension's current identity (`PluginHost.identityOf` - 'bundled' for bundled ones, the SHA-256 of the contents for external ones, null if not computed yet or unreadable).
   * A value is tied to the identity at the time it was saved and only takes effect while it is the same (the same idea as `plugin_consents`, ARCHITECTURE 7.2.1 / 7.7).
   */
  identityOf(pluginId: string): string | null
  /** TODO 1237 (wave 87 code-review): wait until the identity computation at startup has finished (`PluginHost.identitiesReady`). Omitted = do not wait (tests). */
  identitiesReady?(): Promise<void>
}

/** The key of the owner table (`$owners`: plugin id -> identity at the time of saving) inside `plugins.settings`. */
const OWNERS = PLUGIN_SETTINGS_OWNERS_KEY

export class PluginSettingsStore {
  constructor(private readonly deps: PluginSettingsDeps) {}

  /** The values the extension itself reads (only declared fields, the default if absent). `{}` if there is no declaration. */
  values(pluginId: string): PluginSettingValues {
    return resolvePluginSettings(this.deps.configurationOf(pluginId), this.stored(pluginId))
  }

  /** The "Settings" fields of the extension detail. null for an extension that is not installed. */
  view(pluginId: string): PluginSettingsView | null {
    if (!this.deps.known(pluginId)) return null
    const view = pluginSettingsView(pluginId, this.deps.configurationOf(pluginId), this.stored(pluginId))
    return this.wasReset(pluginId) ? { ...view, reset: true } : view
  }

  /**
   * Save **one field** from the renderer (fix X). Only when the name is a declared field and the value fits its type, limits and shape. Otherwise refuse with `invalid-value`
   * and write nothing. **Saved values of other fields and values of other extensions are not touched.** The overall length limit is checked together with the other fields.
   */
  update(pluginId: string, name: unknown, raw: unknown): PluginSettingsView {
    if (!this.deps.known(pluginId)) throw reasonError('invalid-value', { field: 'pluginId' })
    const configuration = this.deps.configurationOf(pluginId)
    const value = checkPluginSettingUpdate(configuration, name, raw)
    if (value === null || typeof name !== 'string') {
      log.warn('plugin.settings.rejected', { pluginId })
      throw reasonError('invalid-value', { field: 'settings' })
    }
    // TODO 1237: only a value for the current identity is saved. If it is unknown (not computed yet, unreadable, too large), it cannot be bound, so refuse.
    const identity = this.deps.identityOf(pluginId)
    if (identity === null) {
      log.warn('plugin.settings.unbound', { pluginId })
      throw reasonError('plugin-settings-unbound')
    }
    // Throw if it cannot be read (writing without reading would erase other extensions' and other fields' values).
    const all = this.deps.read()
    // If the previous value belongs to a different identity (a different thing with the same id, or an external extension whose contents changed), do not carry it over: start empty and switch the owner to the current one.
    const previous = this.matches(all, pluginId, identity) ? (all[pluginId] as Readonly<Record<string, unknown>>) : {}
    const next = { ...previous, [name]: value }
    if (JSON.stringify(next).length > PLUGIN_SETTING_LIMITS.totalChars) {
      log.warn('plugin.settings.rejected', { pluginId, reason: 'total' })
      throw reasonError('invalid-value', { field: 'settings' })
    }
    // The values and the owner are one write of the same JSON (no half state is left).
    this.deps.write({ ...all, [pluginId]: next, [OWNERS]: { ...ownersOf(all), [pluginId]: identity } })
    log.info('plugin.settings.saved', { pluginId, fields: 1 })
    return pluginSettingsView(pluginId, configuration, next)
  }

  /**
   * The version of `update` that waits for an identity that is not computed yet (used by the renderer's IPC). Like `setConsentByUser`, if there is no identity yet it waits for the startup computation
   * and looks again (if it is still null after waiting, it refuses with `plugin-settings-unbound` like `update`). If the extension disappears while waiting, `invalid-value`.
   */
  async updateWhenReady(pluginId: string, name: unknown, raw: unknown): Promise<PluginSettingsView> {
    if (this.deps.known(pluginId) && this.deps.identityOf(pluginId) === null) await this.deps.identitiesReady?.()
    return this.update(pluginId, name, raw)
  }

  /**
   * TODO 1237 (wave 87 code-review) migration: for values of an external extension saved before the migration (no owner record in `$owners`),
   * **write the current identity on the first identity computation and adopt it** (same as the NULL rows of `plugin_state`. Only once - later values are always written with an owner
   * and follow the binding rule). Without this, an updating user's extension settings would silently go back to the defaults (the default can be the wider filter).
   * Bundled ones count a missing record as bundled, so nothing is written for them. Extensions whose identity is not known yet or unreadable are skipped.
   */
  adoptUnowned(): void {
    let all: StoredPluginSettings
    try {
      all = this.deps.read()
    } catch (err) {
      log.warn('plugin.settings.adopt.unreadable', errorFields(err))
      return
    }
    const owners = { ...ownersOf(all) }
    let adopted = 0
    for (const id of Object.keys(all)) {
      if (id === OWNERS || Object.hasOwn(owners, id) || !this.deps.known(id)) continue
      const identity = this.deps.identityOf(id)
      if (identity === null || identity === 'bundled') continue
      owners[id] = identity
      adopted++
    }
    if (adopted === 0) return
    this.deps.write({ ...all, [OWNERS]: owners })
    log.info('plugin.settings.adopted', { count: adopted })
  }

  /**
   * TODO 1233: delete the values of an uninstalled extension (`PluginHost.uninstall` calls it inside a DB transaction). If there are no values, nothing is written.
   * **If the whole of `plugins.settings` cannot be read, return without writing anything** (wave 86 fix Y, code-review): writing without reading would erase other extensions' values, and
   * it does not fall back to defaults either (security review of 1225). Values that cannot be read are not handed to anyone even now (`stored` falls back to `{}`), so even if that id's
   * part remains, the uninstall is not stopped - stopping it would leave consent and rule rows after the folder is already in the trash, and having them take effect again when it is restored is worse.
   */
  forget(pluginId: string): void {
    let all: StoredPluginSettings
    try {
      all = this.deps.read()
    } catch (err) {
      log.warn('plugin.settings.forget.unreadable', { pluginId, ...errorFields(err) })
      return
    }
    const owners = ownersOf(all)
    if (!Object.hasOwn(all, pluginId) && !Object.hasOwn(owners, pluginId)) return
    const next: Record<string, Readonly<Record<string, unknown>>> = {}
    for (const [id, values] of Object.entries(all)) if (id !== pluginId && id !== OWNERS) next[id] = values
    const remaining = Object.fromEntries(Object.entries(owners).filter(([id]) => id !== pluginId))
    if (Object.keys(remaining).length > 0) next[OWNERS] = remaining
    this.deps.write(next)
    log.info('plugin.settings.forgotten', { pluginId })
  }

  private stored(pluginId: string): unknown {
    const all = this.read()
    if (!Object.hasOwn(all, pluginId)) return undefined
    // TODO 1237: only a value saved under the current identity is passed. A different content (updated or swapped), not computed yet, or an unreadable external extension gets the default (empty).
    return this.matches(all, pluginId, this.deps.identityOf(pluginId)) ? all[pluginId] : undefined
  }

  /**
   * Whether the saved values belong to the current extension. False if the identity is unknown (the closed side). For bundled extensions, values with no owner record (saved before TODO 1237) also count
   * as bundled - bundled is decided by where it was loaded from. Values of an external extension with no record are not carried over (it is unknown which contents they were saved for).
   */
  private matches(all: StoredPluginSettings, pluginId: string, identity: string | null): boolean {
    if (identity === null) return false
    const owner = ownersOf(all)[pluginId]
    return identity === 'bundled' ? owner === undefined || owner === 'bundled' : owner === identity
  }

  /** There are saved values, but they do not belong to the current extension (the identity is known). The extension detail shows "reverted". */
  private wasReset(pluginId: string): boolean {
    const identity = this.deps.identityOf(pluginId)
    if (identity === null) return false
    const all = this.read()
    return Object.hasOwn(all, pluginId) && !this.matches(all, pluginId, identity)
  }

  private read(): StoredPluginSettings {
    try {
      return this.deps.read()
    } catch {
      return {}
    }
  }
}

/** `$owners` (id -> identity). Empty if it is broken. */
function ownersOf(all: StoredPluginSettings): Readonly<Record<string, string>> {
  const raw = Object.hasOwn(all, OWNERS) ? all[OWNERS] : undefined
  const out: Record<string, string> = {}
  if (raw === undefined) return out
  for (const [id, identity] of Object.entries(raw)) if (typeof identity === 'string') out[id] = identity
  return out
}
