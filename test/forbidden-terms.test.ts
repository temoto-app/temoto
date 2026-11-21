/**
 * Tests of the lint for constraint 6 itself.
 * Confirms not only that there are no violations, but also that violations can be detected.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const script = join(repoRoot, 'scripts/lint-forbidden-terms.mjs')

describe('lint:terms', () => {
  it('現在のコードベースは違反なし', () => {
    const out = execFileSync('node', [script], { encoding: 'utf8' })
    expect(out).toContain('違反なし')
  })

  it('禁止語は compat/ にだけ literal で置かれている', () => {
    const config = JSON.parse(readFileSync(join(repoRoot, 'compat/forbidden-terms.json'), 'utf8'))
    expect(config.terms.length).toBeGreaterThan(0)
    // In Phase 2 the allowed scope was narrowed to the Adapter only (so that SessionManager is also checked).
    expect(config.allowedPaths).toContain('src/main/session/adapter/')
    expect(config.allowedPaths).toContain('compat/')
    // The lint itself does not hold the forbidden words as literals (if it did, it would violate itself).
    const source = readFileSync(script, 'utf8').toLowerCase()
    for (const term of config.terms) expect(source).not.toContain(term.toLowerCase())
  })

  it('src/ に禁止語を置くと検出する', () => {
    const config = JSON.parse(readFileSync(join(repoRoot, 'compat/forbidden-terms.json'), 'utf8'))
    const term = config.terms[0] as string
    const probe = join(repoRoot, 'src/main/__lint_probe__.ts')
    writeFileSync(probe, `export const backend = '${term}'\n`)
    try {
      expect(() => execFileSync('node', [script], { encoding: 'utf8', stdio: 'pipe' })).toThrow()
    } finally {
      rmSync(probe, { force: true })
    }
  })

  it('Adapter の中なら許される', () => {
    const config = JSON.parse(readFileSync(join(repoRoot, 'compat/forbidden-terms.json'), 'utf8'))
    const term = config.terms[0] as string
    const dir = join(repoRoot, 'src/main/session/adapter')
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, '__lint_probe__.ts')
    writeFileSync(probe, `export const backend = '${term}'\n`)
    try {
      const out = execFileSync('node', [script], { encoding: 'utf8' })
      expect(out).toContain('違反なし')
    } finally {
      rmSync(probe, { force: true })
    }
  })

  it('SessionManager 側 (Adapter の外) は検査対象', () => {
    // Confirms that constraint 6, "code that touches the CLI stays within one Adapter module", is checked literally.
    // The directory directly under src/main/session/ is not an allowed area.
    const config = JSON.parse(readFileSync(join(repoRoot, 'compat/forbidden-terms.json'), 'utf8'))
    const term = config.terms[0] as string
    const probe = join(repoRoot, 'src/main/session/__lint_probe__.ts')
    writeFileSync(probe, `export const backend = '${term}'\n`)
    try {
      expect(() => execFileSync('node', [script], { encoding: 'utf8', stdio: 'pipe' })).toThrow()
    } finally {
      rmSync(probe, { force: true })
    }
  })
})
