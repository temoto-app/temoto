import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// TODO 1285: the install scripts print English by default and Japanese only when the locale says so
// (the first non-empty of LC_ALL / LC_MESSAGES / LANG, "ja" as a prefix). These runs only hit paths that change nothing:
// an unknown option (exits before anything else) and `install-backend.sh --check` with an empty HOME (reports and exits).
const JA = /[぀-ヿ一-鿿]/
const home = mkdtempSync(join(tmpdir(), 'install-lang-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

function run(script: string, args: string[], locale: Record<string, string>) {
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: home, ...locale }
  const r = spawnSync('bash', [script, ...args], { env, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('install scripts output language', () => {
  const scripts = ['scripts/install.sh', 'scripts/install-temoto.sh']
  for (const script of scripts) {
    it(`${script}: English with no locale, with LANG=C and with LANG=en_US`, () => {
      const locales: Record<string, string>[] = [{}, { LANG: 'C' }, { LANG: 'en_US.UTF-8' }]
      for (const locale of locales) {
        const r = run(script, ['--no-such-option'], locale)
        expect(r.status).toBe(2)
        expect(r.out).toContain('unknown option: --no-such-option')
        expect(r.out).not.toMatch(JA)
      }
    })
    it(`${script}: Japanese when LANG starts with ja`, () => {
      const r = run(script, ['--no-such-option'], { LANG: 'ja_JP.UTF-8' })
      expect(r.status).toBe(2)
      expect(r.out).toContain('知らないオプション: --no-such-option')
    })
    it(`${script}: LC_ALL beats LANG, and an empty LC_ALL falls through`, () => {
      expect(run(script, ['--x'], { LC_ALL: 'en_US.UTF-8', LANG: 'ja_JP.UTF-8' }).out).not.toMatch(JA)
      expect(run(script, ['--x'], { LC_ALL: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' }).out).toMatch(JA)
      expect(run(script, ['--x'], { LC_ALL: '', LC_MESSAGES: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' }).out).toMatch(JA)
      expect(run(script, ['--x'], { LC_ALL: '', LC_MESSAGES: '', LANG: 'ja_JP.UTF-8' }).out).toMatch(JA)
    })
  }

  it('compat/install-backend.sh --check: English by default, Japanese with a ja locale', () => {
    const en = run('compat/install-backend.sh', ['--check'], { LANG: 'en_US.UTF-8' })
    expect(en.status).toBe(1)
    expect(en.out).toContain('CLI: missing')
    expect(en.out).not.toMatch(JA)
    const ja = run('compat/install-backend.sh', ['--check'], { LANG: 'ja_JP.UTF-8' })
    expect(ja.status).toBe(1)
    expect(ja.out).toContain('CLI: 無い')
  })

  it('no user-facing message is Japanese-only: every Japanese line goes through a message helper', () => {
    for (const f of ['scripts/install.sh', 'scripts/install-temoto.sh', 'compat/install-backend.sh']) {
      for (const [i, line] of readFileSync(f, 'utf8').split('\n').entries()) {
        if (!JA.test(line) || /^\s*#/.test(line)) continue
        expect(line, `${f}:${i + 1}`).toMatch(/\b(say|die|lack|step|ask_yes|usage_err|pick)\b/)
      }
    }
  })
})
