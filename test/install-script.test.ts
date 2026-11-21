// TODO 493 (wave 25 bundle E): fixes for the snags in scripts/install.sh (the from-source path) and compat/install-backend.sh.
// The shell is not run. The text is read the same way as release-config.test.ts does (it involves prompts and the network, so it is not executed).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const installSh = readFileSync(new URL('../scripts/install.sh', import.meta.url), 'utf8')
const installBackendSh = readFileSync(new URL('../compat/install-backend.sh', import.meta.url), 'utf8')

describe('compat/install-backend.sh (TODO 493 A/A\')', () => {
  it("if stdin is already a terminal, </dev/tty is not rebound (Bun's EINVAL: invalid argument, kqueue workaround)", () => {
    expect(installBackendSh).toMatch(/if \[ -t 0 \]; then\s*\n\s*login_ok=1\s*\n\s*"\$CLI" auth login \|\|/)
  })

  it('even if the login dialog cannot start, it does not die; it starts the CLI, points to /login and moves on', () => {
    const marker = '端末で \\`$CLI\\` を起動して \\`/login\\` を実行する'
    expect(installBackendSh).toContain(marker)
    // There is no exit after this line (going on means reaching the end of the file).
    const idx = installBackendSh.indexOf(marker)
    expect(installBackendSh.slice(idx)).not.toMatch(/exit 1/)
  })

  it('the guidance text is aligned to auth login or /login (does not write <CLI> login)', () => {
    expect(installBackendSh).not.toMatch(/\$CLI` login\b/)
  })
})

describe('scripts/install.sh (TODO 493 B/C/D)', () => {
  it('die points to 「もう一度 scripts/install.sh」 and --check (one shared die function)', () => {
    expect(installSh).toMatch(/die\(\) \{\n\s*echo "install: \$\(pick "\$@"\)" >&2\n\s*echo "install: .*もう一度 scripts\/install\.sh.*--check.*" >&2\n\s*exit 1\n\}/)
    expect(installSh).toMatch(/die\(\) \{[^}]*run scripts\/install\.sh again[^}]*--check/)
  })

  it('a git pull failure distinguishes, on stderr, the case where auth / the repo is not visible from the case where it diverged', () => {
    expect(installSh).toContain('Repository not found')
    expect(installSh).toContain('core.sshCommand')
    expect(installSh).toContain('手元の commit が分岐している?')
  })

  it('the header note no longer points to a 「秘密の gist」 as the place to get it (in 492 the entry point is install-temoto.sh from Releases)', () => {
    expect(installSh).not.toContain('秘密の gist')
    expect(installSh).toContain('install-temoto.sh')
  })
})
