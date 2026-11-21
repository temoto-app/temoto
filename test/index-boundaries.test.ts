/**
 * **Test of the completion condition of P1 itself** (docs/OPTIMIZATION_BRIEF.md 3.8).
 *
 *   "The index and the scan are out of main, and nothing flows back"
 *
 * It calls from here the same check as the lint (`npm run lint:index`), so that `npm test` also fails on it. In addition, it confirms with planted violating files **that the check really catches violations** (built the same way as the plugin boundary check of Phase 4).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error -- the lint itself is a .mjs and has no types (built the same way as the constraint 6 lint)
import { checkIndexBoundaries } from '../scripts/lint-index-boundaries.mjs'
import { makeTestDir } from './helpers/tmp.js'

const repoRoot = new URL('..', import.meta.url).pathname
const temporary: string[] = []

interface Violation {
  readonly file: string
  readonly line: number
  readonly message: string
}

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway src tree for running the planted violations through the check. */
function fixture(files: Record<string, string>): string {
  const root = makeTestDir('index-boundary')
  temporary.push(root)
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

function check(root: string): Violation[] {
  return checkIndexBoundaries(root) as Violation[]
}

describe('completion criterion: indexing and scanning are out of main', () => {
  it('the current codebase has no violations at all', () => {
    expect(check(repoRoot)).toEqual([])
  })

  it('catches an electron import from the index process', () => {
    const root = fixture({
      'src/index-kernel/evil.ts': "import { app } from 'electron'\n",
      'src/index-host/evil.ts': "import { utilityProcess } from 'electron'\n"
    })
    const violations = check(root)
    expect(violations).toHaveLength(2)
    expect(violations.every((v) => v.message.includes('electron'))).toBe(true)
  })

  it('catches an import of src/main/ from the index process', () => {
    const root = fixture({
      'src/index-kernel/evil.ts': "import { FsAccess } from '../main/fs/access.js'\n"
    })
    expect(check(root).some((v) => v.message.includes('src/main'))).toBe(true)
  })

  it('does not allow even a type-only import from the index process (leaves no room for the bundles to connect)', () => {
    const root = fixture({
      'src/index-kernel/evil.ts': "import type { FsAccess } from '../main/fs/access.js'\n"
    })
    expect(check(root).some((v) => v.message.includes('src/main'))).toBe(true)
  })

  it('catches an import from common to main / the index side', () => {
    const root = fixture({
      'src/common/evil.ts':
        "import { IndexStore } from '../index-kernel/store.js'\n" +
        "import { openDatabase } from '../main/db/index.js'\n"
    })
    const violations = check(root)
    expect(violations.some((v) => v.message.includes('src/index-kernel'))).toBe(true)
    expect(violations.some((v) => v.message.includes('src/main'))).toBe(true)
  })

  it('catches a **value** import from main to the index side', () => {
    const root = fixture({
      'src/main/evil.ts': "import { IndexStore } from '../index-kernel/store.js'\n"
    })
    expect(check(root).some((v) => v.message.includes('src/index-kernel'))).toBe(true)
  })

  it('lets an `import type` from main to the index side through (types do not remain in the bundle)', () => {
    const root = fixture({
      'src/main/ok.ts': "import type { IndexStore } from '../index-kernel/store.js'\n"
    })
    expect(check(root)).toEqual([])
  })

  it('catches it even with a dynamic import', () => {
    const root = fixture({
      'src/index-kernel/evil.ts': "const main = await import('../main/index.js')\n"
    })
    expect(check(root).some((v) => v.message.includes('src/main'))).toBe(true)
  })

  it('catches it even with a side-effect-only import', () => {
    const root = fixture({ 'src/common/evil.ts': "import 'electron'\n" })
    expect(check(root).some((v) => v.message.includes('electron'))).toBe(true)
  })

  it('lets allowed forms through (@shared and a relative import within the same directory)', () => {
    const root = fixture({
      'src/index-kernel/ok.ts':
        "import type { SearchScope } from '@shared/search.js'\n" +
        "import { foldPath } from '../common/uri.js'\n" +
        "import { IndexStore } from './store.js'\n",
      'src/index-kernel/store.ts': 'export class IndexStore {}\n',
      'src/common/uri.ts': 'export const foldPath = (v: string): string => v\n'
    })
    expect(check(root)).toEqual([])
  })
})
