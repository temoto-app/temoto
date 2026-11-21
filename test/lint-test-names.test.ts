/**
 * `npm run lint:test-names` (TODO 1285): `node scripts/test-names-i18n.mjs check test` is part of `npm run lint`.
 * It must exit 0 on the real tree, exit 1 on a planted Japanese test name, and also on a name the tool cannot extract
 * unless the allow file lists it. Quoted-only names (Japanese the test is about) stay allowed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const CLI = resolve(ROOT, 'scripts/test-names-i18n.mjs')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lint-test-names-'))
  mkdirSync(join(dir, 'test'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const check = (...args: string[]) => spawnSync('node', [CLI, 'check', ...args, 'test'], { cwd: dir, encoding: 'utf8' })
const put = (src: string) => writeFileSync(join(dir, 'test/x.test.ts'), src)

describe('lint:test-names', () => {
  it('is wired into npm run lint', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['lint:test-names']).toBe('node scripts/test-names-i18n.mjs check test')
    expect(pkg.scripts.lint).toContain('npm run lint:test-names')
  })

  it('passes on the real test tree', () => {
    const r = spawnSync('node', [CLI, 'check', 'test'], { cwd: ROOT, encoding: 'utf8' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
  })

  it('exits 0 for English names', () => {
    put(`import { it } from 'vitest'\nit('works', () => {})\n`)
    expect(check().status).toBe(0)
  })

  it('exits 1 for a planted Japanese test name and says where', () => {
    put(`import { describe, it } from 'vitest'\ndescribe('suite', () => {\n  it('日本語の名前', () => {})\n})\n`)
    const r = check('--list')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('remaining Japanese test names: 1')
    expect(r.stdout).toContain('日本語の名前')
  })

  it('allows a name that only quotes Japanese (the thing under test)', () => {
    put(`import { it } from 'vitest'\nit('splits "日本語" into tokens', () => {})\n`)
    expect(check().status).toBe(0)
  })

  it('fails on an each-table with Japanese data unless the allow file lists it', () => {
    put(`import { it } from 'vitest'\nit.each([\n  ['label', '日本語'],\n])('%s', () => {})\n`)
    const bare = check('--allow', join(dir, 'none.json'))
    expect(bare.status).toBe(1)
    expect(bare.stdout).toContain('cannot extract')
    writeFileSync(join(dir, 'allow.json'), JSON.stringify([{ file: 'test/x.test.ts', category: 'each-table', includes: "['label'", reason: 'data' }]))
    expect(check('--allow', join(dir, 'allow.json')).status).toBe(0)
    // An entry for another file does not cover it.
    writeFileSync(join(dir, 'other.json'), JSON.stringify([{ file: 'test/y.test.ts', reason: 'data' }]))
    expect(check('--allow', join(dir, 'other.json')).status).toBe(1)
  })
})
