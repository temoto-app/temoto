/**
 * File name -> icon and color (TODO 404, wave 21 bundle E, ARCHITECTURE.md 5.3.1). Pure functions (tests in
 * `test/file-icons.test.ts`).
 *
 * The mapping of VS Code's default file icon theme **Seti** (seti-ui's `styles/components/icons/mapping.less` and
 * VS Code's `vs-seti-icon-theme.json`) is copied, narrowed down to about 40 main kinds. Anything not in the table gets the generic `default`.
 *
 * The 9 Seti colors (blue / green / yellow / orange / red / pink / purple / grey-light / white) are rounded to 8
 * CSS variables (`--file-icon-<color>`). Seti's `white` (= the generic file mark, `.txt`) and the
 * folder mark that Seti does not provide are `muted` (= the row's subdued text `--fg-dim`; no new variable is added). Seti's `grey` / `ignore`
 * (`.gitignore`'s #41535b) are pulled toward `grey` (they would vanish on a dark surface).
 *
 * Lookup (the first hit wins):
 *   1. The file name itself (case-insensitive. `package.json` / `Dockerfile` / `.gitignore` …)
 *   2. The start of the file name (derivatives such as `Dockerfile.dev` / `LICENSE-MIT`)
 *   3. Compound extensions, longest first (`.d.ts` / `.test.ts` / `.spec.tsx` …)
 *   4. The last extension (`.ts` …)
 */
import type { FileIconName } from './icons/file-icons/seti-shapes.js'
import { SPECIAL_FOLDER_SHAPES, type SpecialFolderName } from './icons/file-icons/special-folder-shapes.js'
import { displayPath } from '@shared/uri.js'

export type FileIconColor =
  | 'blue'
  | 'green'
  | 'yellow'
  | 'amber'
  | 'teal'
  | 'orange'
  | 'red'
  | 'pink'
  | 'purple'
  | 'grey'
  | 'muted'

export interface FileIcon {
  readonly icon: FileIconName
  readonly color: FileIconColor
}

/** CSS variables for colors (`muted` is the existing `--fg-dim`). The same as `.file-icon-<color>` in styles.css. */
export const FILE_ICON_COLORS = ['blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'grey'] as const

const DEFAULT_FILE: FileIcon = { icon: 'default', color: 'muted' }
const FOLDER: FileIcon = { icon: 'folder', color: 'muted' }
const FOLDER_OPEN: FileIcon = { icon: 'folder-open', color: 'muted' }

function i(icon: FileIconName, color: FileIconColor): FileIcon {
  return { icon, color }
}

/** 1. The file name itself (looked up in lowercase). */
const BY_NAME: ReadonlyMap<string, FileIcon> = new Map([
  ['package.json', i('npm', 'red')],
  ['package-lock.json', i('npm', 'red')],
  ['.npmrc', i('npm', 'red')],
  ['.npmignore', i('npm', 'red')],
  ['tsconfig.json', i('tsconfig', 'blue')],
  ['jsconfig.json', i('tsconfig', 'blue')],
  ['yarn.lock', i('lock', 'green')],
  ['dockerfile', i('docker', 'blue')],
  ['docker-compose.yml', i('docker', 'pink')],
  ['docker-compose.yaml', i('docker', 'pink')],
  ['.dockerignore', i('docker', 'grey')],
  ['.gitignore', i('git', 'grey')],
  ['.gitattributes', i('git', 'grey')],
  ['.gitmodules', i('git', 'grey')],
  ['.gitkeep', i('git', 'grey')],
  ['license', i('license', 'yellow')],
  ['licence', i('license', 'yellow')],
  ['license.md', i('license', 'yellow')],
  ['license.txt', i('license', 'yellow')],
  ['copying', i('license', 'yellow')],
  ['makefile', i('config', 'orange')],
  ['.env', i('config', 'grey')],
  ['.editorconfig', i('config', 'grey')]
])

/** 2. The start of the file name (lowercase). `Dockerfile.dev` / `LICENSE-APACHE` / `.env.local`. */
const BY_PREFIX: readonly (readonly [string, FileIcon])[] = [
  ['dockerfile', i('docker', 'blue')],
  ['license', i('license', 'yellow')],
  ['licence', i('license', 'yellow')],
  ['.env.', i('config', 'grey')]
]

/** 3-4. Extensions (lowercase, no leading dot; compound ones like `d.ts`). */
const BY_EXT: ReadonlyMap<string, FileIcon> = new Map([
  // TypeScript / JavaScript (Seti: tests are orange, TSX / JSX get the react mark)
  ['ts', i('typescript', 'blue')],
  ['mts', i('typescript', 'blue')],
  ['cts', i('typescript', 'blue')],
  ['d.ts', i('typescript', 'blue')],
  ['test.ts', i('typescript', 'orange')],
  ['spec.ts', i('typescript', 'orange')],
  ['tsx', i('react', 'blue')],
  ['test.tsx', i('react', 'orange')],
  ['spec.tsx', i('react', 'orange')],
  ['js', i('javascript', 'yellow')],
  ['mjs', i('javascript', 'yellow')],
  ['cjs', i('javascript', 'yellow')],
  ['test.js', i('javascript', 'orange')],
  ['spec.js', i('javascript', 'orange')],
  ['jsx', i('react', 'blue')],
  ['json', i('json', 'yellow')],
  ['jsonc', i('json', 'yellow')],
  ['jsonl', i('json', 'yellow')],
  // Documents and config
  ['md', i('markdown', 'blue')],
  ['markdown', i('markdown', 'blue')],
  ['txt', i('default', 'muted')],
  ['css', i('css', 'blue')],
  ['scss', i('sass', 'pink')],
  ['sass', i('sass', 'pink')],
  ['html', i('html', 'orange')],
  ['htm', i('html', 'orange')],
  ['xml', i('xml', 'orange')],
  ['yml', i('yml', 'purple')],
  ['yaml', i('yml', 'purple')],
  ['toml', i('config', 'grey')],
  ['ini', i('config', 'grey')],
  ['conf', i('config', 'grey')],
  ['lock', i('lock', 'green')],
  ['csv', i('csv', 'green')],
  ['tsv', i('csv', 'green')],
  ['sql', i('db', 'pink')],
  ['db', i('db', 'pink')],
  ['sqlite', i('db', 'pink')],
  // Languages
  ['py', i('python', 'blue')],
  ['sh', i('shell', 'green')],
  ['bash', i('shell', 'green')],
  ['zsh', i('shell', 'green')],
  ['fish', i('shell', 'green')],
  ['rs', i('rust', 'grey')],
  ['go', i('go', 'blue')],
  ['java', i('java', 'red')],
  ['c', i('c', 'blue')],
  ['h', i('c', 'purple')],
  ['cpp', i('cpp', 'blue')],
  ['cc', i('cpp', 'blue')],
  ['cxx', i('cpp', 'blue')],
  ['hpp', i('cpp', 'purple')],
  ['swift', i('swift', 'orange')],
  ['rb', i('ruby', 'red')],
  // Images, audio, video, documents, archives
  ['png', i('image', 'purple')],
  ['jpg', i('image', 'purple')],
  ['jpeg', i('image', 'purple')],
  ['gif', i('image', 'purple')],
  ['webp', i('image', 'purple')],
  ['bmp', i('image', 'purple')],
  ['avif', i('image', 'purple')],
  ['heic', i('image', 'purple')],
  ['ico', i('image', 'purple')],
  ['svg', i('svg', 'purple')],
  ['pdf', i('pdf', 'red')],
  ['mp4', i('video', 'pink')],
  ['mov', i('video', 'pink')],
  ['m4v', i('video', 'pink')],
  ['webm', i('video', 'pink')],
  ['avi', i('video', 'pink')],
  ['mkv', i('video', 'pink')],
  ['mp3', i('audio', 'purple')],
  ['wav', i('audio', 'purple')],
  ['m4a', i('audio', 'purple')],
  ['aac', i('audio', 'purple')],
  ['flac', i('audio', 'purple')],
  ['ogg', i('audio', 'purple')],
  ['doc', i('word', 'blue')],
  ['docx', i('word', 'blue')],
  ['xls', i('xls', 'green')],
  ['xlsx', i('xls', 'green')],
  ['xlsm', i('xls', 'green')],
  ['zip', i('zip', 'grey')],
  ['gz', i('zip', 'grey')],
  ['tgz', i('zip', 'grey')],
  ['tar', i('zip', 'grey')],
  ['bz2', i('zip', 'grey')],
  ['xz', i('zip', 'grey')],
  ['7z', i('zip', 'grey')],
  ['rar', i('zip', 'grey')]
])

/**
 * Look up the icon and color from a file name (not a path; the last single element). A folder is folder / folder-open depending on open state.
 * Anything not in the table gets the generic `default` (VS Code's Seti does the same).
 */
export function fileIconFor(name: string, isDirectory: boolean, expanded = false): FileIcon {
  if (isDirectory) return expanded ? FOLDER_OPEN : FOLDER
  const lower = name.toLowerCase()
  const exact = BY_NAME.get(lower)
  if (exact !== undefined) return exact
  for (const [prefix, icon] of BY_PREFIX) {
    if (lower.startsWith(prefix)) return icon
  }
  // A leading dot (the hidden file `.bashrc`) does not count as an extension separator.
  const body = lower.startsWith('.') ? lower.slice(1) : lower
  const parts = body.split('.')
  // Longest first: `a.test.d.ts` -> `test.d.ts` -> `d.ts` -> `ts`.
  for (let start = 1; start < parts.length; start += 1) {
    const ext = parts.slice(start).join('.')
    const hit = BY_EXT.get(ext)
    if (hit !== undefined) return hit
  }
  return DEFAULT_FILE
}

/**
 * TODO 958 (owner decision 2026-10-24): the color of the folders directly under home that Finder gives dedicated icons (and Trash).
 * The same names elsewhere than directly under home (`Documents` etc. inside a project) stay ordinary folders.
 */
export const SPECIAL_FOLDER_COLORS: Readonly<Record<SpecialFolderName, FileIconColor>> = {
  Downloads: 'green',
  Desktop: 'blue',
  Documents: 'amber',
  Movies: 'pink',
  Music: 'red',
  Pictures: 'orange',
  Public: 'teal',
  Library: 'grey',
  Applications: 'purple',
  Trash: 'grey'
}

/** Name directly under home -> special folder. The real Trash is `~/.Trash` (a folder named `~/Trash` is an ordinary folder). */
function specialNameOf(name: string): SpecialFolderName | null {
  if (name === '.Trash') return 'Trash'
  return name !== 'Trash' && Object.hasOwn(SPECIAL_FOLDER_SHAPES, name) ? (name as SpecialFolderName) : null
}

/**
 * If the folder's URI is a special folder directly under home, its name. Otherwise null (an ordinary folder).
 * Null if `homeUri` is empty (has not arrived yet).
 */
export function specialFolderFor(uri: string, homeUri: string): SpecialFolderName | null {
  if (!uri.startsWith('file://')) return null
  // TODO 968: `/Applications` directly under the root also gets a dedicated icon (treated the same in Finder's sidebar).
  if (uri === 'file:///Applications') return 'Applications'
  if (homeUri === '') return null
  const shown = displayPath(uri, homeUri)
  if (!shown.startsWith('~/')) return null
  const rest = shown.slice(2)
  if (rest === '' || rest.includes('/')) return null
  return specialNameOf(rest)
}
