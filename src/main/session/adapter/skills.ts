/**
 * Listing and deleting skills (TODO 773, ARCHITECTURE.md 4.5.3).
 *
 * A CLI skill is `<location>/<name>/<main file>`, in three places: user-wide, project (under the working folder), and
 * plugin. **aios has no format of its own.** The location names are held by `skills` in `compat/backend-paths.json`
 * (constraint 6), and this only reads the table and walks. It is handed to the renderer in neutral types (`shared/skills.ts`).
 *
 * - **Only skill directories and the plugin list (just `installPath`) are read** (constraint 2). Other places in the CLI's settings
 *   directory (credentials, settings) are not opened. Only the first 16 KB of the body is read, to take the frontmatter's
 *   `name` / `description`.
 * - **symlinks**: a main file is accepted only if it passes `canRead` (the caller's `FsAccess.assertAllowed(…, 'read')`, for both the logical path and
 *   the canonical one). Moreover, if the real file falls inside the CLI's settings directory, it is accepted only if it stays **inside the same
 *   location** (links pointing to credentials, auto memory, or another plugin outside the location are not listed).
 *   Links pointing outside the settings directory (such as a dotfiles repository) are listed (`linked`).
 * - **Deletion**: user / project skills only. A name coming from the renderer is checked again in main
 *   (separators and a leading `.` are rejected, the realpath must be exactly a directory one level directly under the location, and positions that include the location itself or the settings
 *   directory are rejected). **A deletion-only check that does not rely on the read choke point or the viewer's read exception.**
 *   What is discarded is the single entry directly under the location (only the link if it is a link), handed to `trash`: the caller uses `shell.trashItem`.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToUri, uriToPath } from '../../../common/uri.js'
import type {
  SkillDeleteReason,
  SkillDeleteRequest,
  SkillDeleteResult,
  SkillEntry,
  SkillListing,
  SkillScope
} from '../../../shared/skills.js'
import { loadBackendPaths, type BackendPaths } from './compat.js'
import { expandHome } from '../../home-path.js'

/** How much to read from the head of the body. The frontmatter fits here. */
const HEAD_BYTES = 16 * 1024
/** Upper bound on the description's length (the part shown in the list). */
const MAX_DESCRIPTION = 300
/** Upper bounds: per location and overall (so an abnormal count cannot stall us). */
const MAX_PER_ROOT = 200
const MAX_TOTAL = 600
const MAX_MANIFEST_BYTES = 1024 * 1024

export interface SkillDeps {
  /** Defaults to the real home. Tests pass a fake home. */
  readonly home?: string
  /** Defaults to `compat/backend-paths.json`. */
  readonly paths?: BackendPaths
  /** Whether the main file may be read (`FsAccess`'s read choke point). */
  readonly canRead: (path: string) => boolean
}

function real(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

async function realAsync(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

function skillConfig(paths: BackendPaths): NonNullable<BackendPaths['skills']> | null {
  return paths.skills ?? null
}

/** The `name` and `description` of the frontmatter (the head enclosed by `---`). Not all of YAML, only the shapes skills use. */
export function parseSkillFrontmatter(text: string): { name: string | null; description: string } {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { name: null, description: '' }
  const body: string[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim() === '---') break
    body.push(line)
  }
  const read = (key: string): string | null => {
    const start = body.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line))
    if (start < 0) return null
    const first = (body[start] ?? '').replace(new RegExp(`^${key}\\s*:`), '').trim()
    const parts: string[] = []
    const block = /^[>|][+-]?\d*$/.test(first)
    if (!block && first !== '') parts.push(first)
    for (let i = start + 1; i < body.length; i += 1) {
      const line = body[i] ?? ''
      // Only indented lines (and blank lines inside a block) continue it. A line without indentation is the next key.
      if (line.trim() === '') {
        if (block) continue
        break
      }
      if (!/^\s/.test(line)) break
      parts.push(line.trim())
    }
    let value = parts.join(' ').replace(/\s+/g, ' ').trim()
    const quoted = /^(["'])(.*)\1$/.exec(value)
    if (quoted !== null) value = quoted[2] ?? ''
    return value
  }
  const name = read('name')
  const description = read('description') ?? ''
  return {
    name: name === null || name === '' ? null : name.slice(0, 100),
    description: description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION)}…` : description
  }
}

async function readHead(file: string): Promise<string | null> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

interface Root {
  readonly dir: string
  readonly scope: SkillScope
  readonly pluginName: string | null
}

/** Walks directly under a location and collects skills. */
async function scanRoot(
  root: Root,
  file: string,
  configDirReal: readonly string[],
  deps: SkillDeps,
  out: SkillEntry[]
): Promise<void> {
  const realRoot = await realAsync(root.dir)
  if (realRoot === null) return
  let names: string[]
  try {
    names = await readdir(root.dir)
  } catch {
    return
  }
  names.sort()
  for (const dirName of names.slice(0, MAX_PER_ROOT)) {
    if (out.length >= MAX_TOTAL) return
    if (dirName.startsWith('.')) continue
    const entry = join(root.dir, dirName)
    const skillFile = join(entry, file)
    let isLink = false
    try {
      isLink = (await lstat(entry)).isSymbolicLink()
      if (!(await stat(skillFile)).isFile()) continue
    } catch {
      continue
    }
    const realFile = await realAsync(skillFile)
    if (realFile === null) continue
    // If the real file falls inside the settings directory, only the same location is allowed (to exclude links pointing to credentials, memory, or other plugins).
    if (configDirReal.some((dir) => within(realFile, dir)) && !within(realFile, realRoot)) continue
    if (!deps.canRead(skillFile)) continue
    const head = await readHead(skillFile)
    if (head === null) continue
    const meta = parseSkillFrontmatter(head)
    out.push({
      name: meta.name ?? dirName,
      dirName,
      description: meta.description,
      scope: root.scope,
      pluginName: root.pluginName,
      uri: pathToUri(skillFile),
      linked: isLink || !within(realFile, realRoot),
      readOnly: root.scope === 'plugin'
    })
  }
}

function configDirs(paths: BackendPaths, home: string): string[] {
  const dirs: string[] = []
  for (const dir of paths.credentialDirs) {
    const resolved = real(expandHome(dir, home))
    if (resolved !== null) dirs.push(resolved)
  }
  return dirs
}

async function configDirsAsync(paths: BackendPaths, home: string): Promise<string[]> {
  const dirs: string[] = []
  for (const dir of paths.credentialDirs) {
    const resolved = await realAsync(expandHome(dir, home))
    if (resolved !== null) dirs.push(resolved)
  }
  return dirs
}

/** The skill locations of installed plugins. Silently empty if the list's shape is wrong or broken. */
async function pluginRoots(paths: BackendPaths, home: string, cwd: string | null): Promise<Root[]> {
  const cfg = skillConfig(paths)
  if (cfg === null) return []
  const manifest = expandHome(cfg.pluginsManifest, home)
  let data: unknown
  try {
    if ((await stat(manifest)).size > MAX_MANIFEST_BYTES) return []
    data = JSON.parse(await readFile(manifest, 'utf8'))
  } catch {
    return []
  }
  const plugins = (data as { plugins?: unknown } | null)?.plugins
  if (plugins === null || typeof plugins !== 'object') return []
  const roots: Root[] = []
  const seen = new Set<string>()
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    const installs = Array.isArray(value) ? value : [value]
    for (const install of installs) {
      if (install === null || typeof install !== 'object') continue
      const record = install as Record<string, unknown>
      const installPath = record.installPath
      if (typeof installPath !== 'string' || !isAbsolute(installPath)) continue
      // A plugin installed only for a specific project counts only when in that project.
      const scope = record.scope
      if (scope === 'project' || scope === 'local') {
        const projectPath = record.projectPath
        if (cwd === null || typeof projectPath !== 'string' || resolve(projectPath) !== resolve(cwd)) continue
      }
      const dir = join(installPath, cfg.pluginSkillsSubdir)
      if (seen.has(dir)) continue
      seen.add(dir)
      roots.push({ dir, scope: 'plugin', pluginName: key.split('@')[0] || key })
    }
  }
  return roots
}

function userRoot(paths: BackendPaths, home: string): string | null {
  const cfg = skillConfig(paths)
  return cfg === null ? null : expandHome(cfg.userRoot, home)
}

function projectRoot(paths: BackendPaths, cwd: string | null): string | null {
  const cfg = skillConfig(paths)
  if (cfg === null || cwd === null || !isAbsolute(cwd)) return null
  return join(resolve(cwd), cfg.projectRootSuffix)
}

/** Turns `cwdUri` (`file://`, or null) into an absolute path. Null if the shape is wrong. */
export function cwdPathOf(cwdUri: string | null | undefined): string | null {
  if (typeof cwdUri !== 'string' || cwdUri === '') return null
  try {
    const path = uriToPath(cwdUri)
    return isAbsolute(path) ? path : null
  } catch {
    return null
  }
}

/** Collects in the order user → project → plugin. A location with the same real path is taken only once (when the cwd is the home). */
export async function listSkills(cwd: string | null, deps: SkillDeps): Promise<SkillListing> {
  const paths = deps.paths ?? loadBackendPaths()
  const cfg = skillConfig(paths)
  if (cfg === null) return { skills: [], projectChecked: false }
  const home = deps.home ?? homedir()
  const cfgDirs = await configDirsAsync(paths, home)
  const roots: Root[] = []
  const user = userRoot(paths, home)
  if (user !== null) roots.push({ dir: user, scope: 'user', pluginName: null })
  const project = projectRoot(paths, cwd)
  if (project !== null) {
    const realProject = await realAsync(project)
    const realUser = user === null ? null : await realAsync(user)
    if (realProject === null || realProject !== realUser) roots.push({ dir: project, scope: 'project', pluginName: null })
  }
  roots.push(...(await pluginRoots(paths, home, cwd)))
  const skills: SkillEntry[] = []
  for (const root of roots) await scanRoot(root, cfg.file, cfgDirs, deps, skills)
  return { skills, projectChecked: project !== null }
}

/** The deletion check. If it passes, returns the one path to discard. */
export function checkSkillDelete(
  request: SkillDeleteRequest,
  deps: SkillDeps
): { ok: true; path: string } | { ok: false; reason: SkillDeleteReason } {
  const paths = deps.paths ?? loadBackendPaths()
  const cfg = skillConfig(paths)
  if (cfg === null) return { ok: false, reason: 'invalid' }
  const home = deps.home ?? homedir()
  const name = request.dirName
  if (
    (request.scope !== 'user' && request.scope !== 'project') ||
    typeof name !== 'string' ||
    name === '' ||
    name.startsWith('.') ||
    /[/\\\0]/.test(name)
  ) {
    return { ok: false, reason: 'invalid' }
  }
  const rootDir =
    request.scope === 'user' ? userRoot(paths, home) : projectRoot(paths, cwdPathOf(request.cwdUri))
  if (rootDir === null) return { ok: false, reason: 'invalid' }
  const entry = join(rootDir, name)
  let isLink: boolean
  try {
    const stats = lstatSync(entry)
    isLink = stats.isSymbolicLink()
    if (!isLink && !stats.isDirectory()) return { ok: false, reason: 'not-found' }
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  const skillFile = join(entry, cfg.file)
  try {
    if (!statSync(skillFile).isFile()) return { ok: false, reason: 'not-found' }
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  // A deletion-only check (it does not rely on the read choke point `canRead` or the viewer's read exception: writing and
  // deleting a directory are heavier than reading). What is discarded is `entry` itself (one level directly under the location).
  const realRoot = real(rootDir)
  const realEntry = real(entry)
  if (realRoot === null || realEntry === null) return { ok: false, reason: 'not-found' }
  // Do not let the location itself, a position containing the location, or a position containing the settings directory (credentials) be discarded (the same for a link's target).
  const dirs = configDirs(paths, home)
  if (
    realEntry === realRoot ||
    within(realRoot, realEntry) ||
    dirs.some((dir) => within(dir, realEntry))
  ) {
    return { ok: false, reason: 'not-allowed' }
  }
  // The real directory must be one level directly under the location (two levels down or outside is not allowed). A link discards only the link,
  // so the real location does not matter (we only check that the target does not hit the rule above and that the main file satisfies the rule below).
  if (!isLink && dirname(realEntry) !== realRoot) return { ok: false, reason: 'not-allowed' }
  // If the main file's real path falls inside the settings directory, only the same location is allowed (the same rule as enumeration).
  const realFile = real(skillFile)
  if (realFile === null) return { ok: false, reason: 'not-found' }
  if (dirs.some((dir) => within(realFile, dir)) && !within(realFile, realRoot)) {
    return { ok: false, reason: 'not-allowed' }
  }
  return { ok: true, path: entry }
}

/** Hands the one that passed the check to `trash` (the recycle bin). Does not throw. */
export async function deleteSkill(
  request: SkillDeleteRequest,
  deps: SkillDeps,
  trash: (path: string) => Promise<void>
): Promise<SkillDeleteResult> {
  const checked = checkSkillDelete(request, deps)
  if (!checked.ok) return checked
  try {
    await trash(checked.path)
    return { ok: true }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
