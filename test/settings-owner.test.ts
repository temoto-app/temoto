/**
 * The test of the completion condition of TODO 85 itself.
 *
 *   'Keys of `app_settings` are only written / removed by the process that owns them'
 *
 * It also calls the same check as the lint (`npm run lint:settings-owner`) from here, so `npm test` fails too. In addition, it confirms with a planted violating file that the check **really catches** violations (the same design as the P1 / Phase 4 boundary check).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error -- the lint itself is .mjs and has no types (same design as the constraint 6 lint)
import { checkSettingsOwner } from '../scripts/lint-settings-owner.mjs'
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

/** A throwaway src tree, for running planted violations through the check. */
function fixture(files: Record<string, string>): string {
  const root = makeTestDir('settings-owner')
  temporary.push(root)
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  // The check reads the table itself (`src/common/settings-keys.ts`), so copy it from the real one.
  const settingsKeysPath = 'src/common/settings-keys.ts'
  if (!(settingsKeysPath in files)) {
    const real = new URL(`../${settingsKeysPath}`, import.meta.url).pathname
    const full = join(root, settingsKeysPath)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, readFileSync(real, 'utf8'))
  }
  return root
}

function check(root: string): Violation[] {
  return checkSettingsOwner(root) as Violation[]
}

describe('completion condition: an app_settings key is written / removed only by the process of its owner', () => {
  it('the current codebase has no violation at all', () => {
    expect(check(repoRoot)).toEqual([])
  })

  it('catches a writeTyped from the index process to an owner: main key', () => {
    const root = fixture({
      'src/index-kernel/evil.ts':
        "import { UI_THEME } from '../common/settings-keys.js'\n" +
        'export function evil(settings: { writeTyped: (k: unknown, v: unknown) => void }): void {\n' +
        "  settings.writeTyped(UI_THEME, 'dark')\n" +
        '}\n'
    })
    const violations = check(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toContain('UI_THEME')
    expect(violations[0]?.message).toContain("owner: 'main'")
  })

  it('also catches a removeTyped from the index process to an owner: main key', () => {
    const root = fixture({
      'src/index-host/evil.ts':
        "import { WINDOW_BOUNDS } from '../common/settings-keys.js'\n" +
        'export function evil(settings: { removeTyped: (k: unknown) => void }): void {\n' +
        '  settings.removeTyped(WINDOW_BOUNDS)\n' +
        '}\n'
    })
    expect(check(root).some((v) => v.message.includes('WINDOW_BOUNDS'))).toBe(true)
  })

  it('catches a writeTyped from main to an owner: index key', () => {
    const root = fixture({
      'src/main/evil.ts':
        "import { SCAN_PRUNE } from '../common/settings-keys.js'\n" +
        'export function evil(settings: { writeTyped: (k: unknown, v: unknown) => void }): void {\n' +
        '  settings.writeTyped(SCAN_PRUNE, 0)\n' +
        '}\n'
    })
    const violations = check(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toContain('SCAN_PRUNE')
    expect(violations[0]?.message).toContain("owner: 'index'")
  })

  it('also catches writing featureCacheKey (an owner main function) on the index side', () => {
    const root = fixture({
      'src/index-kernel/evil.ts':
        "import { featureCacheKey } from '../common/settings-keys.js'\n" +
        'export function evil(settings: { writeTyped: (k: unknown, v: unknown) => void }): void {\n' +
        "  settings.writeTyped(featureCacheKey('9.9.9'), '{}')\n" +
        '}\n'
    })
    expect(check(root).some((v) => v.message.includes('featureCacheKey'))).toBe(true)
  })

  it('lets a writeTyped to a key of its own owner pass', () => {
    const root = fixture({
      'src/index-kernel/ok.ts':
        "import { SCAN_PRUNE } from '../common/settings-keys.js'\n" +
        'export function ok(settings: { writeTyped: (k: unknown, v: unknown) => void }): void {\n' +
        '  settings.writeTyped(SCAN_PRUNE, 0)\n' +
        '}\n',
      'src/main/ok.ts':
        "import { UI_THEME } from '../common/settings-keys.js'\n" +
        'export function ok(settings: { writeTyped: (k: unknown, v: unknown) => void }): void {\n' +
        "  settings.writeTyped(UI_THEME, 'dark')\n" +
        '}\n'
    })
    expect(check(root)).toEqual([])
  })

  it('readTyped is free for either owner (reading from both sides)', () => {
    const root = fixture({
      'src/index-kernel/ok.ts':
        "import { UI_THEME } from '../common/settings-keys.js'\n" +
        'export function ok(settings: { readTyped: (k: unknown) => unknown }): unknown {\n' +
        '  return settings.readTyped(UI_THEME)\n' +
        '}\n',
      'src/main/ok.ts':
        "import { SCAN_PRUNE } from '../common/settings-keys.js'\n" +
        'export function ok(settings: { readTyped: (k: unknown) => unknown }): unknown {\n' +
        '  return settings.readTyped(SCAN_PRUNE)\n' +
        '}\n'
    })
    expect(check(root)).toEqual([])
  })
})
