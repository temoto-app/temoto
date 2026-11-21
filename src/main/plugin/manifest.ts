/**
 * Manifest loading and validation (ARCHITECTURE.md 7.2).
 *
 * **The format was fixed in Phase 4** (7.2 was a draft). Differences from the skeleton are in 12.9.
 * Validation drops unknown keys and refuses to load on a type mismatch; a partially broken manifest is never
 * completed by guesswork.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { z } from 'zod'
import {
  indexSourceOwnedBy,
  MAX_PLUGIN_INDEX_SOURCE,
  PLUGIN_ID_RE,
  PLUGIN_TOOL_NAME_RE,
  type CapabilityName,
  type HostExportKind,
  type HostExports,
  type PluginManifest
} from '@shared/plugin.js'
import { MAX_SCHEDULE_INTERVAL_MINUTES, MIN_SCHEDULE_INTERVAL_MINUTES } from '@shared/schedule.js'
import { TRIGGER_ID_RE, TRIGGER_LIMITS } from '@shared/trigger.js'
import {
  isValidSettingDefault,
  PLUGIN_SETTING_LIMITS,
  PLUGIN_SETTING_NAME_RE,
  SECRET_LIKE_SETTING_NAME_RE,
  type PluginSettingDeclaration
} from '@shared/plugin-settings.js'
import { SETTING_FORMATS } from '@shared/setting-format.js'
import { isWebViewerUrl } from '@shared/open-external.js'
import { checkToolSchema } from './tool-schema.js'
import { isLiteralOrLocalHost } from '../capability/browser.js'
import { credentialOwner } from '../capability/credential-owner.js'

/** Upper limit on the number of tools one plugin can expose (TODO 847). */
export const MAX_PLUGIN_TOOLS = 16
/**
 * Upper limit on the length of a tool name at the gateway (TODO 847). MCP tool names are limited to `[A-Za-z0-9_-]`, and the
 * backend shows the model a name prefixed with the gateway's server name (`mcp__aios__`, 11 characters).
 * It is cut to 53 characters so that the name, prefix included, fits the model API's tool name limit (64 characters).
 */
export const MAX_EXPOSED_TOOL_NAME = 53

/**
 * A plugin tool's name at the gateway (TODO 847). `<plugin id with . replaced by _>__<tool name>`
 * (`fetchThread` of `aios.reddit` -> `aios_reddit__fetchThread`).
 * - An id has only lowercase letters, digits, `-` and `.` and no `_`, so `.` -> `_` is one to one. The separator `__` never
 *   appears on the id side (labels are non-empty), so the first `__` splits plugin from tool.
 * - The gateway's built-in tools (`search` / `openFile` ...) contain no `__`, so they cannot collide.
 */
export function pluginToolExposedName(pluginId: string, tool: string): string {
  return `${pluginId.replace(/\./g, '_')}__${tool}`
}

/** Declaration of one tool (TODO 847). `checkToolSchema` checks the schema contents. */
const TOOL = z
  .object({
    name: z.string().regex(PLUGIN_TOOL_NAME_RE, 'tool name must match [A-Za-z][A-Za-z0-9_-]{0,31}'),
    title: z.string().trim().min(1).max(64).optional(),
    description: z.string().trim().min(1).max(1024),
    inputSchema: z.record(z.unknown()).superRefine((schema, ctx) => {
      const error = checkToolSchema(schema)
      if (error !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error })
    }),
    sideEffect: z.boolean().optional()
  })
  .strict()

/**
 * One settings field (TODO 1225, 7.2.1). A subset of VS Code's `contributes.configuration.properties`: the types are only boolean, string and a table of strings.
 * Whether the default value fits the type and the limits is checked by the superRefine below (`isValidSettingDefault`).
 */
const SETTING_BASE = {
  title: z.string().trim().min(1).max(PLUGIN_SETTING_LIMITS.title).optional(),
  description: z.string().trim().min(1).max(PLUGIN_SETTING_LIMITS.description),
  order: z.number().int().min(0).max(10_000).optional()
}
const SETTING_MAX_LENGTH = z.number().int().min(1).max(PLUGIN_SETTING_LIMITS.maxLength).optional()
/**
 * Shape of an item (fix X, code-review and security review). Same place as VS Code's `format`, but only names from main's fixed table (`SETTING_FORMATS`).
 * An arbitrary regular expression (`pattern`) is not read (an unknown key under `.strict()`) - main must not evaluate an external extension's expression. An unknown name is not loaded.
 */
const SETTING_SHAPE = {
  format: z.enum(SETTING_FORMATS).optional()
}
const SETTING = z.discriminatedUnion('type', [
  z.object({ ...SETTING_BASE, type: z.literal('boolean'), default: z.boolean() }).strict(),
  z.object({ ...SETTING_BASE, ...SETTING_SHAPE, type: z.literal('string'), default: z.string(), maxLength: SETTING_MAX_LENGTH }).strict(),
  z
    .object({
      ...SETTING_BASE,
      type: z.literal('array'),
      items: z.object({ type: z.literal('string'), ...SETTING_SHAPE }).strict(),
      default: z.array(z.string()),
      maxLength: SETTING_MAX_LENGTH,
      maxItems: z.number().int().min(1).max(PLUGIN_SETTING_LIMITS.maxItems).optional()
    })
    .strict()
])
const CONFIGURATION = z
  .object({
    title: z.string().trim().min(1).max(PLUGIN_SETTING_LIMITS.title).optional(),
    properties: z.record(SETTING).superRefine((properties, ctx) => {
      const names = Object.keys(properties)
      if (names.length === 0 || names.length > PLUGIN_SETTING_LIMITS.properties) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `configuration.properties needs 1 to ${PLUGIN_SETTING_LIMITS.properties} entries` })
      }
      for (const name of names) {
        if (!PLUGIN_SETTING_NAME_RE.test(name)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'setting name must match [A-Za-z][A-Za-z0-9]{0,63}' })
        } else if (SECRET_LIKE_SETTING_NAME_RE.test(name)) {
          // Do not let secrets sit in plain-text settings (use the credentials entry point - credentials in 7.7).
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: 'secrets do not belong in configuration (use capabilities.credentials)' })
        }
        const declaration = properties[name] as PluginSettingDeclaration | undefined
        if (declaration !== undefined && !isValidSettingDefault(declaration)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name, 'default'], message: 'default does not fit the type and limits' })
        }
      }
    })
  })
  .strict()

/** An id is reverse-domain style, like `aios.text`. It is used as a URL authority, so it is tightly restricted. */
const ID = z
  .string()
  .min(3)
  .max(64)
  .regex(PLUGIN_ID_RE, 'id must be a lowercase reverse-domain form')

/** entry is limited to a **path relative to the plugin directory** (`..` is not allowed). */
const ENTRY = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !isAbsolute(value), 'absolute paths are not allowed')
  .refine((value) => !normalize(value).startsWith('..'), 'paths outside the plugin directory are not allowed')

/**
 * Icon (TODO 524). The same relative path rules as entry, plus the extensions `.svg` / `.png`.
 * Existence and being inside the directory (including symlink escapes) are checked at load time by `iconFileOf`.
 */
const ICON = ENTRY.refine((value) => /\.(svg|png)$/i.test(value), 'icon must be .svg or .png')

const HOST = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i)

/**
 * Contribution to the Activity Bar (TODO 523). The icon is the manifest's `icon` (no separate one).
 * Pressing it opens `openUrl` in the Web view or in the default browser - plugin code is not run
 * (the policy of 400 / 522). `openUrl` is restricted by the same rule as `isWebViewerUrl` (http(s), has a host, no credentials).
 * `openWith` (TODO 721): if absent, `'web'` (the Web view, as before). `'external'` is `shell.openExternal`
 * (the default browser; nothing is passed to `persist:aios-web`) - an escape hatch for sites that refuse logins from an
 * embedded browser (Google and others).
 */
const ACTIVITY_BAR = z
  .object({
    title: z.string().trim().min(1).max(64),
    openUrl: z.string().min(1).max(2048).refine(isWebViewerUrl, 'openUrl must be an http(s) URL aios can show'),
    openWith: z.enum(['web', 'external']).optional()
  })
  .strict()

/** TODO 1039: `sidebarView`. Only a heading. Rows are passed by the plugin at runtime. */
const SIDEBAR_VIEW = z.object({ title: z.string().trim().min(1).max(64) }).strict()

/**
 * TODO 896: `searchProvider`. A plugin's section in the search sidebar. Results are returned at runtime by `search.query`.
 * `openWith` says how a result is opened (`web` / `external` are http(s) URLs, `viewer` is a URI of the plugin's own viewer).
 * It cannot be omitted - how results are opened is declared per plugin (main checks a result's `open` against it).
 */
const SEARCH_PROVIDER = z
  .object({
    title: z.string().trim().min(1).max(64),
    placeholder: z.string().trim().min(1).max(64).optional(),
    openWith: z.enum(['web', 'external', 'viewer'])
  })
  .strict()

/**
 * `browser.hosts` (TODO 848). The same shape as `network.hosts`, but it also refuses literal IPs and `localhost` - so the cookies of
 * the logged-in Web view cannot be taken to devices inside the home network (such as a router's admin page).
 */
const BROWSER_HOST = HOST.refine((value) => !isLiteralOrLocalHost(value.replace(/^\*\./, '')), 'browser.hosts may not be an IP address or localhost')

const CAPABILITIES = z
  .object({
    credentials: z
      .object({
        oauth: z.array(z.string().min(1).max(128)).max(16).default([]),
        basic: z.array(z.string().min(1).max(128)).max(16).optional()
      })
      .optional(),
    network: z.object({ hosts: z.array(HOST).max(32) }).optional(),
    fs: z
      .object({
        read: z.array(z.string().min(1)).max(32).optional(),
        write: z.array(z.string().min(1)).max(32).optional()
      })
      .optional(),
    // TODO 920: the value is only `<id>`, or `<id>:<name>` / `<id>/<name>` (superRefine below, `indexSourceOwnedBy`).
    index: z.object({ write: z.array(z.string().min(1).max(MAX_PLUGIN_INDEX_SOURCE)).max(8) }).optional(),
    ui: z
      .object({ notify: z.boolean().optional(), status: z.boolean().optional(), sidebar: z.boolean().optional() })
      .strict()
      .optional(),
    browser: z.object({ hosts: z.array(BROWSER_HOST).max(16) }).strict().optional()
  })
  .strict()

const MANIFEST = z
  .object({
    id: ID,
    name: z.string().min(1).max(64),
    version: z.string().min(1).max(32),
    // Top-level keys (TODO 368, owner decision 2026-10-03). All optional; they only appear in the extensions view's (TODO 367) list and
    // the detail summary. The structure of `viewer` / `command` / `capabilities` does not change (`.strict()` is kept too).
    // They correspond to the keys of the same names in VS Code's `package.json`. Moving to the `contributes` shape will be decided separately just before the public SDK.
    displayName: z.string().trim().min(1).max(64).optional(),
    description: z.string().trim().min(1).max(256).optional(),
    // Path relative to the plugin directory (the same rules as entry, plus `.svg` / `.png`). Read since TODO 524:
    // the extensions view shows `aios-plugin://<id>/<icon>` as an `<img>` in the row and the detail (a default icon if absent).
    icon: ICON.optional(),
    publisher: z.string().trim().min(1).max(64).optional(),
    // One key for the Activity Bar (TODO 523). No full move to 368's `contributes` - it only adds to the current set of top-level keys.
    activityBar: ACTIVITY_BAR.optional(),
    // TODO 1039: the plugin's own list in the sidebar. The host draws it; the row data comes through the Broker (`ui.setSidebarRows`). Bundled plugins only (host.ts).
    sidebarView: SIDEBAR_VIEW.optional(),
    // TODO 896: a section of the search sidebar. It is answered by plugin-host's `search.query`. Bundled plugins only (host.ts).
    searchProvider: SEARCH_PROVIDER.optional(),
    capabilities: CAPABILITIES.default({}),
    viewer: z
      .object({
        entry: ENTRY,
        extensions: z.array(z.string().min(1).max(16)).max(64).optional(),
        schemes: z.array(z.string().min(1).max(32)).max(8).optional(),
        editable: z.boolean().optional(),
        priority: z.number().int().min(0).max(1000).optional(),
        // Announce itself by content kind (item 104). An unknown kind is rejected by validation.
        payloads: z.array(z.enum(['diff'])).max(4).optional(),
        // How the body is delivered (code-review of TODO 906). If omitted: a non-editing viewer that claims by extension gets 'url', everything else gets 'text'.
        delivery: z.enum(['text', 'url']).optional(),
        // Extensions that are received by URL but return a draft of cell values (TODO 1212 stage 1 / stage 2). Only xlsx and xlsm (with macros).
        cellEdits: z.array(z.enum(['xlsx', 'xlsm'])).max(2).optional()
      })
      .strict()
      .optional(),
    // plugin-host has one entry point (review C-4). `command` / `mcp` / `indexer` are told apart by exports of the same entry.
    host: z.object({ entry: ENTRY }).strict().optional(),
    command: z
      .object({
        // The old shape (Phase 4). If written, it must be the same file as `host.entry` (the refine below).
        entry: ENTRY.optional(),
        commands: z
          .array(
            z
              .object({
                id: z.string().min(1).max(64),
                title: z.string().min(1).max(64),
                sideEffect: z.boolean().optional()
              })
              .strict()
          )
          .max(32)
      })
      .strict()
      .optional(),
    // TODO 847: `tools` declares the tools shown to the model (owner decision 2026-10-15, widening the `mcp` key).
    mcp: z.object({ entry: ENTRY.optional(), tools: z.array(TOOL).max(MAX_PLUGIN_TOOLS).optional() }).strict().optional(),
    indexer: z
      .object({ entry: ENTRY.optional(), interval: z.string().max(16).optional() })
      .strict()
      .optional(),
    // TODO 372 (wave 20 bundle B): declaration of periodic tasks. aios's JobScheduler counts the time; the plugin only
    // declares (it has no timer of its own and no runtime registration API). A row is disabled when first installed.
    scheduledTasks: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/),
            name: z.string().min(1).max(64),
            defaultInterval: z
              .number()
              .int()
              .min(MIN_SCHEDULE_INTERVAL_MINUTES)
              .max(MAX_SCHEDULE_INTERVAL_MINUTES),
            // TODO 952 stage 1: "repeat while idle". Called only while no conversation is running; if `more` is returned, it is called again.
            idle: z.boolean().optional()
          })
          .strict()
      )
      .max(16)
      .optional(),
    // TODO 1216 (6.2.6): declaration of triggers. The declaration itself is the request for the `triggers` capability (`declaredCapabilities`). Rules are disabled by default.
    triggers: z
      .array(
        z
          .object({
            id: z.string().min(1).max(TRIGGER_LIMITS.id).regex(TRIGGER_ID_RE),
            name: z.string().trim().min(1).max(TRIGGER_LIMITS.name),
            description: z.string().trim().min(1).max(TRIGGER_LIMITS.description).optional(),
            defaultPrompt: z.string().trim().min(1).max(TRIGGER_LIMITS.defaultPrompt).optional()
          })
          .strict()
      )
      .min(1)
      .max(8)
      .optional(),
    // TODO 1225 (7.2.1): settings fields. An extension reads only its own values with `aios.settings.get()` (the code runs in plugin-host).
    configuration: CONFIGURATION.optional()
  })
  .strict()
  .superRefine((manifest, ctx) => {
    // TODO 920: the only sources that can be written to the index are in the plugin's own id namespace (the built-in `fs` / `conversation` / `transcript` and other plugins are refused).
    for (const [i, source] of (manifest.capabilities?.index?.write ?? []).entries()) {
      if (!indexSourceOwnedBy(manifest.id, source)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['capabilities', 'index', 'write', i],
          message: `index.write must be "${manifest.id}" or start with "${manifest.id}:" / "${manifest.id}/"`
        })
      }
    }
    // Wave 84 fix Z (security review of TODO 1218 / 952): the names of credentials for which main handles login and input can be
    // declared only by the owning extension (`credential-owner.ts`). If another id writes one, it is not loaded (same practice as `index.write`). host.ts checks whether it is bundled.
    for (const kind of ['oauth', 'basic'] as const) {
      for (const [i, name] of (manifest.capabilities?.credentials?.[kind] ?? []).entries()) {
        const owner = credentialOwner(name)
        if (owner !== null && owner !== manifest.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['capabilities', 'credentials', kind, i],
            message: `credential "${name}" belongs to ${owner}`
          })
        }
      }
    }
    const entries = new Set(
      [manifest.host?.entry, manifest.command?.entry, manifest.mcp?.entry, manifest.indexer?.entry]
        .filter((entry): entry is string => entry !== undefined)
        .map((entry) => normalize(entry))
    )
    if (entries.size > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['host', 'entry'],
        message: 'plugin-host has exactly one entry (command / mcp / indexer are distinguished by their exports)'
      })
    }
    const wantsHost =
      manifest.command !== undefined || manifest.mcp !== undefined || manifest.indexer !== undefined
    if (wantsHost && entries.size === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['host', 'entry'],
        message: 'command / mcp / indexer require host.entry'
      })
    }
    // TODO 1039: it is needed together with the declaration that passes rows (`ui.sidebar`). TODO 1264: a viewer (`schemes`) is no longer
    // required - without one, every row loses its URI (`restrictRowUris`) and the list only expands (`aios.calendar` shows details as child rows).
    if (manifest.sidebarView !== undefined) {
      if (manifest.capabilities?.ui?.sidebar !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['capabilities', 'ui', 'sidebar'],
          message: 'sidebarView requires capabilities.ui.sidebar'
        })
      }
    }
    // TODO 896: the search code runs in plugin-host, so an entry is needed. Opening with `viewer` needs the scheme of the plugin's own viewer.
    if (manifest.searchProvider !== undefined) {
      if (entries.size === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['host', 'entry'],
          message: 'searchProvider requires host.entry'
        })
      }
      if (manifest.searchProvider.openWith === 'viewer' && (manifest.viewer?.schemes ?? []).length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['viewer', 'schemes'],
          message: 'searchProvider.openWith "viewer" requires viewer.schemes (results open the plugin\'s own viewer)'
        })
      }
    }
    // TODO 372: the periodic task code runs in plugin-host, so an entry is needed. The id is unique within a plugin.
    const tasks = manifest.scheduledTasks ?? []
    if (tasks.length > 0 && entries.size === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['host', 'entry'],
        message: 'scheduledTasks requires host.entry'
      })
    }
    // TODO 1225: the code that reads settings is plugin-host code (`aios.settings.get()`), so an entry is needed.
    if (manifest.configuration !== undefined && entries.size === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['host', 'entry'], message: 'configuration requires host.entry' })
    }
    // TODO 1216: the code that reports events runs in plugin-host (it emits from inside a periodic task), so an entry is needed. The id is unique within a plugin.
    const triggers = manifest.triggers ?? []
    if (triggers.length > 0 && entries.size === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['host', 'entry'], message: 'triggers requires host.entry' })
    }
    if (new Set(triggers.map((trigger) => trigger.id)).size !== triggers.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['triggers'], message: 'triggers ids collide' })
    }
    // TODO 847: a tool name is unique within a plugin, and its name at the gateway must fit the limit.
    const tools = manifest.mcp?.tools ?? []
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mcp', 'tools'], message: 'mcp.tools names collide' })
    }
    for (const tool of tools) {
      if (pluginToolExposedName(manifest.id, tool.name).length > MAX_EXPOSED_TOOL_NAME) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mcp', 'tools'],
          message: `id + tool name is longer than ${MAX_EXPOSED_TOOL_NAME} characters`
        })
      }
    }
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scheduledTasks'],
        message: 'scheduledTasks ids collide'
      })
    }
  })

export interface LoadedPlugin {
  readonly manifest: PluginManifest
  /** The directory that holds the plugin itself. **Not passed to the renderer.** */
  readonly dir: string
  /** Whether it is bundled (built in). Consent is granted at every launch only for capabilities never decided (a revoked `denied` is not restored, TODO 1070). Only the last fallback cannot be disabled (TODO 460, `isRequiredPlugin`, 12.9). */
  readonly bundled: boolean
  /** Relative path of an icon that may be served (after `iconFileOf` has checked it, TODO 524). null if none. */
  readonly icon: string | null
}

export class ManifestError extends Error {}

/**
 * Check the manifest's `icon` and return the relative path (`/`-separated) that may be served (TODO 524).
 * Missing, outside the directory (including symlink escapes), not a regular file, or wrong extension -> null
 * (the plugin itself is loaded and the default icon is shown).
 */
export function iconFileOf(dir: string, manifest: PluginManifest): string | null {
  const icon = manifest.icon
  if (icon === undefined) return null
  try {
    const root = realpathSync.native(dir)
    const real = realpathSync.native(join(dir, icon))
    const inside = relative(root, real)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null
    if (!/\.(svg|png)$/i.test(real) || !statSync(real).isFile()) return null
    return inside.split(sep).join('/')
  } catch {
    return null
  }
}

export function parseManifest(raw: unknown): PluginManifest {
  const result = MANIFEST.safeParse(raw)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new ManifestError(`${first?.path.join('.') ?? ''}: ${first?.message ?? 'invalid'}`)
  }
  return result.data as PluginManifest
}

export function readManifest(dir: string): PluginManifest {
  const text = readFileSync(join(dir, 'manifest.json'), 'utf8')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ManifestError('manifest.json is not JSON')
  }
  return parseManifest(raw)
}

/** The list of capabilities the manifest declares (used by the UI and the consent record). */
export function declaredCapabilities(manifest: PluginManifest): readonly CapabilityName[] {
  const out: CapabilityName[] = []
  const caps = manifest.capabilities
  if (caps.credentials !== undefined) out.push('credentials')
  if (caps.network !== undefined && caps.network.hosts.length > 0) out.push('network')
  // Even with an empty declaration, fs has an implicit grant for "a URI the user opened",
  // so a plugin with a viewer always gets fs (note in 7.2).
  if (caps.fs !== undefined || manifest.viewer !== undefined) out.push('fs')
  if (caps.index !== undefined && caps.index.write.length > 0) out.push('index')
  if (caps.ui !== undefined) out.push('ui')
  if (caps.browser !== undefined && caps.browser.hosts.length > 0) out.push('browser')
  // TODO 1216: triggers are requested by the top-level `triggers` declaration, not by `capabilities` (like viewer -> fs, the declaration is the request itself).
  if ((manifest.triggers?.length ?? 0) > 0) out.push('triggers')
  return out
}

/** Whether it has code that runs in plugin-host. A plugin without it does not start a process. */
export function needsHost(manifest: PluginManifest): boolean {
  return (
    manifest.command !== undefined ||
    manifest.mcp !== undefined ||
    manifest.indexer !== undefined ||
    // TODO 896: the search section also runs in plugin-host.
    manifest.searchProvider !== undefined ||
    // TODO 952 stage 1: periodic tasks also run in plugin-host (previously they were only declared and never called when the time came).
    (manifest.scheduledTasks?.length ?? 0) > 0
  )
}

/**
 * The plugin-host entry (review C-4). `host.entry` is authoritative; the old shapes (`command.entry` and others) are
 * aligned to "the same file" by validation, so whichever is taken gives the same result. null if none.
 */
export function hostEntryOf(manifest: PluginManifest): string | null {
  return (
    manifest.host?.entry ??
    manifest.command?.entry ??
    manifest.mcp?.entry ??
    manifest.indexer?.entry ??
    null
  )
}

/**
 * Whether main may send this kind and name to plugin-host (C-4). **The manifest is the upper bound**: commands and kinds
 * that are not declared are not called (even if a renderer / viewer passes an arbitrary name).
 * `mcp` is only the tools listed in `mcp.tools[].name` (TODO 847. Previously there was no tool declaration and only the kind's declaration was checked).
 */
export function isDeclaredExport(manifest: PluginManifest, kind: HostExportKind, name: string): boolean {
  switch (kind) {
    case 'command':
      return manifest.command?.commands.some((command) => command.id === name) ?? false
    case 'mcp':
      return manifest.mcp?.tools?.some((tool) => tool.name === name) ?? false
    case 'indexer':
      return manifest.indexer !== undefined && name === 'sync'
    case 'task':
      // TODO 952 stage 1: only tasks listed in `scheduledTasks[].id`.
      return manifest.scheduledTasks?.some((task) => task.id === name) ?? false
    case 'search':
      // TODO 896: only `search.query` of a plugin that declared `searchProvider`.
      return manifest.searchProvider !== undefined && name === 'query'
    default:
      return false
  }
}

/** Difference between the exports plugin-host returned and the declaration (for a startup warning). Names declared but missing from the exports. */
export function missingExports(manifest: PluginManifest, exports: HostExports): readonly string[] {
  const missing: string[] = []
  for (const command of manifest.command?.commands ?? []) {
    if (!exports.commands.includes(command.id)) missing.push(`command:${command.id}`)
  }
  const tools = manifest.mcp?.tools
  if (tools !== undefined && tools.length > 0) {
    for (const tool of tools) if (!exports.mcp.includes(tool.name)) missing.push(`mcp:${tool.name}`)
  } else if (manifest.mcp !== undefined && exports.mcp.length === 0) missing.push('mcp')
  if (manifest.indexer !== undefined && !exports.indexer.includes('sync')) missing.push('indexer:sync')
  for (const task of manifest.scheduledTasks ?? []) {
    if (!(exports.tasks ?? []).includes(task.id)) missing.push(`task:${task.id}`)
  }
  if (manifest.searchProvider !== undefined && !(exports.search ?? []).includes('query')) missing.push('search:query')
  return missing
}

/** Resolve entry inside the plugin directory. A specification that escapes it is rejected. */
export function resolveEntry(dir: string, entry: string): string {
  const full = join(dir, entry)
  const rel = relative(dir, full)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new ManifestError('entry is outside the plugin directory')
  return full
}
