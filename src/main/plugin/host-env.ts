/**
 * Building the environment passed to the plugin-host process (ARCHITECTURE.md 7.8).
 *
 * A **pure function** split out of `host.ts`. The utility process itself cannot be
 * started from Vitest, so this is shaped so that only "what is passed" can be checked.
 *
 * - The `--allow-fs-read` path is **enclosed in double quotes**. Node splits `NODE_OPTIONS`
 *   on whitespace, so without quotes `~/Library/Application Support/aios/plugins/…`
 *   is cut at `~/Library/Application`, and not one user-installed plugin starts
 *   (measured in review A-2). Node's parser treats `\` inside quotes as an escape,
 *   so a path containing `"` or `\` is refused rather than built.
 * - main's environment variables are **not passed**. Node's permission model does not
 *   restrict `process.env`, so API keys and tokens would flow straight to plugins (review A-1).
 *   Only a few allow-listed ones are passed.
 */

/** The environment variables handed over to plugin-host. Nothing else is passed, whatever main's value is. */
export const HOST_ENV_ALLOWLIST: readonly string[] = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']

/**
 * The value of `NODE_OPTIONS`. Enables the permission model and lists the readable scope.
 * Throws if a path has `"` or `\` (because it would break inside the quotes).
 */
export function buildNodeOptions(allowRead: readonly string[]): string {
  const parts = ['--permission']
  for (const path of allowRead) {
    if (path.includes('"') || path.includes('\\')) {
      throw new Error(`plugin path contains a character NODE_OPTIONS cannot quote: ${path}`)
    }
    parts.push(`--allow-fs-read="${path}"`)
  }
  return parts.join(' ')
}

/**
 * The environment passed to plugin-host. Copies only the allow-listed keys from `source` (main's `process.env`),
 * and builds and adds `NODE_OPTIONS`.
 */
export function buildHostEnv(
  source: NodeJS.ProcessEnv,
  allowRead: readonly string[]
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of HOST_ENV_ALLOWLIST) {
    const value = source[key]
    if (typeof value === 'string') env[key] = value
  }
  env['NODE_OPTIONS'] = buildNodeOptions(allowRead)
  return env
}

/**
 * Turns plugin-host's `permission` frame (TODO 499) into one line of the structured log at launch (pure function).
 *
 * It is passed only through `NODE_OPTIONS` (`execArgv` does not work even in Electron 44 - wave 25 bundle H). The distributed build restores the Helper to the name
 * `Electron Helper*.app` so that NODE_OPTIONS stays alive (`restoreElectronHelpers` in `scripts/release-config.mjs`).
 * **If it is not in effect, warn**: the Helper was renamed (Electron regarded it as packaged), or
 * something dropped NODE_OPTIONS. A malformed report is also treated as "not in effect" and warns.
 */
export function permissionLogLine(
  pluginId: string,
  payload: unknown
): { level: 'info' | 'warn'; event: 'plugin.host.permission'; fields: Record<string, string | boolean> } {
  let enabled = false
  let helper = '?'
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>
    if (record['enabled'] === true) enabled = true
    if (typeof record['helper'] === 'string') helper = record['helper'].slice(0, 64)
  }
  return {
    level: enabled ? 'info' : 'warn',
    event: 'plugin.host.permission',
    fields: { pluginId, enabled, via: 'NODE_OPTIONS', helper }
  }
}
