// TODO 493 (wave 25 bundle E): fixes for the snags in scripts/install.sh (the from-source path) and compat/install-backend.sh.
// The shell is not run. The text is read the same way as release-config.test.ts does (it involves prompts and the network, so it is not executed).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const installSh = readFileSync(new URL('../scripts/install.sh', import.meta.url), 'utf8')
const installBackendSh = readFileSync(new URL('../compat/install-backend.sh', import.meta.url), 'utf8')

describe('compat/install-backend.sh (TODO 493 A/A\')', () => {
  it('標準入力が既に端末なら </dev/tty を付け替えない (Bun の EINVAL: invalid argument, kqueue 対策)', () => {
    expect(installBackendSh).toMatch(/if \[ -t 0 \]; then\s*\n\s*login_ok=1\s*\n\s*"\$CLI" auth login \|\|/)
  })

  it('ログインの対話が始められなくても die せず、CLI を起動して /login を案内して先へ進む', () => {
    const marker = '端末で \\`$CLI\\` を起動して \\`/login\\` を実行する'
    expect(installBackendSh).toContain(marker)
    // There is no exit after this line (going on means reaching the end of the file).
    const idx = installBackendSh.indexOf(marker)
    expect(installBackendSh.slice(idx)).not.toMatch(/exit 1/)
  })

  it('案内の文言は auth login か /login に揃っている (<CLI> login と書かない)', () => {
    expect(installBackendSh).not.toMatch(/\$CLI` login\b/)
  })
})

describe('scripts/install.sh (TODO 493 B/C/D)', () => {
  it('die は「もう一度 scripts/install.sh」と --check を案内する (共通の die 関数 1 つ)', () => {
    expect(installSh).toMatch(/die\(\) \{\n\s*echo "install: \$\*" >&2\n\s*echo "install: .*もう一度 scripts\/install\.sh.*--check.*" >&2\n\s*exit 1\n\}/)
  })

  it('git pull の失敗は認証/repo が見えない場合と分岐した場合を stderr で見分ける', () => {
    expect(installSh).toContain('Repository not found')
    expect(installSh).toContain('core.sshCommand')
    expect(installSh).toContain('手元の commit が分岐している?')
  })

  it('頭の注はもう「秘密の gist」を置き場として案内しない (492 で入口は Releases の install-temoto.sh)', () => {
    expect(installSh).not.toContain('秘密の gist')
    expect(installSh).toContain('install-temoto.sh')
  })
})
