/**
 * Copy the user-facing material to `~/<data name>/help/` (the rest of TODO 1060, ARCHITECTURE 7.6.8 stage 4).
 *
 * - **The canonical copy is the same place as Help's (TODO 1174) `resources/help/`.** `index.html` is the Help itself, `ai-guide.md` is a short
 *   guide for the AI to answer questions about settings. The same fact is not written in two places (the table of where settings live is only in the "settings" section of `index.html`).
 *   The list of keys is returned by `getSettings`, so it is not duplicated here.
 * - **On every launch the contents are compared with the bundled ones and only differing files are rewritten** (wave 87 automatic security review). The `.version` marker is
 *   a record only and is not used for the decision: even if a conversation or another process rewrites the guide the AI reads, the next launch restores the bundled contents
 *   (trusting the marker would let a tampered guide survive until the version updates, a persistent prompt injection). It is light, as there are two small files.
 *   Only the files in `HELP_SYNC_FILES` are replaced (a temp file with a random name is created with `wx` and renamed); other files the user placed are not deleted.
 * - It is part of the app, not a user file, so it does not go through `FsAccess`. The destination is only the fixed two levels under `home`, and
 *   **nothing is written unless `~/<data name>` and `~/<data name>/help` are real folders, not symlinks** (never follow a symlink to write elsewhere). rename
 *   replaces the link itself even if the destination is a symlink, so it does not follow it. On the bundled side, nothing whose realpath leaves the bundled folder is copied.
 *   A failure does not stop launch (the caller swallows it).
 * - `{{backend.*}}` in `index.html` is filled from the table in `compat/`, as when Help is opened (constraint 6). The product name `{{app.name}}` is filled from
 *   `shared/product.json` (TODO 1254).
 *
 * Does not import electron (`test/help-sync.test.ts` verifies with a temporary folder).
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { insideRoot, readCapped } from './bundled-file.js'
import { MAX_HELP_BYTES, fillHelpNames, type BackendNames } from '@shared/help.js'
import { openNoFollowSync } from '../common/os/open-flags.js'
import { appIdentity, homeDataDir } from '../common/app-identity.js'

/** Files to copy (names directly under the bundled folder). Only `html` has the document's terms filled in. */
export const HELP_SYNC_FILES: readonly { readonly name: string; readonly fillNames: boolean }[] = [
  { name: 'index.html', fillNames: true },
  // TODO 1254: it contains the product name (`{{app.name}}`), so fill it in.
  { name: 'ai-guide.md', fillNames: true }
]

/** Export destination `~/<data name>/help` (TODO 1263: `~/Temoto/help` on a new machine, `~/aios/help` where the legacy userData exists). */
export function helpExportDir(home: string, dataName?: string): string {
  return join(homeDataDir(home, dataName), 'help')
}

const VERSION_MARK = '.version'

export interface HelpSyncOptions {
  /** The bundled folder (`helpRoot(appPath)`). */
  readonly root: string
  readonly home: string
  /** Version marker (version + commit). Only written to `.version` as a record; not used to decide whether to copy. */
  readonly version: string
  readonly names: BackendNames
  /** TODO 1263: the data name (`~/<name>/help` and `{{app.dataName}}`). Default: the identity fixed at launch. */
  readonly dataName?: string
}

export type HelpSyncResult = 'written' | 'unchanged'

/**
 * Read the destination file. **Only if lstat says it is a regular file**, it is opened with `O_NOFOLLOW | O_NONBLOCK` and checked again with fstat;
 * anything over the limit (`MAX_HELP_BYTES`) is not read. A symlink, FIFO, `/dev/zero` and the like give null without reading (the caller replaces it).
 */
function readText(path: string): string | null {
  let fd: number | null = null
  try {
    if (!lstatSync(path).isFile()) return null
    fd = openNoFollowSync(path, constants.O_RDONLY)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_HELP_BYTES) return null
    const buffer = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < stat.size) {
      const read = readSync(fd, buffer, offset, stat.size - offset, offset)
      if (read === 0) break
      offset += read
    }
    return buffer.subarray(0, offset).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function writeAtomic(path: string, text: string): void {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`
  // `wx` = O_CREAT | O_EXCL: fails instead of following a symlink of the same name placed beforehand.
  writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' })
  try {
    renameSync(temp, path)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

/** true for a real folder, false if missing. Throws for a symlink or a non-folder (nothing is written). */
function isRealDir(path: string): boolean {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return false
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`help export refuses non-directory: ${path}`)
  return true
}

/** Prepare the two destination levels without following symlinks. */
function ensureExportDir(home: string, dataName: string): string {
  const parent = homeDataDir(home, dataName)
  if (!isRealDir(parent)) mkdirSync(parent)
  const dir = helpExportDir(home, dataName)
  if (!isRealDir(dir)) mkdirSync(dir)
  // Check once more (a race) that it was not swapped after mkdir.
  isRealDir(parent)
  isRealDir(dir)
  return dir
}

/** Write only files whose contents differ from the bundled ones (or that are missing). If no bundled file can be read, write nothing. */
export function syncHelpDocs(options: HelpSyncOptions): HelpSyncResult {
  const realRoot = realpathSync(options.root)
  const dataName = options.dataName ?? appIdentity().dataName
  const texts: { name: string; text: string }[] = []
  for (const file of HELP_SYNC_FILES) {
    // Even if one is missing (or realpath / open throws), still copy the other.
    let raw: string | null
    try {
      const real = realpathSync(join(options.root, file.name))
      if (!insideRoot(realRoot, real)) continue
      raw = readCapped(real, MAX_HELP_BYTES)
    } catch {
      continue
    }
    if (raw === null) continue
    texts.push({ name: file.name, text: file.fillNames ? fillHelpNames(raw, options.names, dataName) : raw })
  }
  if (texts.length === 0) return 'unchanged'
  const dir = ensureExportDir(options.home, dataName)
  let wrote = false
  for (const item of texts) {
    const target = join(dir, item.name)
    // If the destination is not a regular file (symlink, FIFO, etc.), replace it without reading (rename replaces the link itself).
    const current = readText(target)
    if (current === item.text) continue
    writeAtomic(target, item.text)
    wrote = true
  }
  const mark = `${options.version}\n`
  if (readText(join(dir, VERSION_MARK)) !== mark) writeAtomic(join(dir, VERSION_MARK), mark)
  return wrote ? 'written' : 'unchanged'
}
