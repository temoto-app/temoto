// TODO 931 (wave 49 bundle E): holes in the installer's pgrep / SHA256SUMS.
// Does not run the shell (does not touch the real stable or ~/Applications); reads the text instead (TODO 1263 code-review: one function
// is lifted out of the text and run alone, in a temporary directory).
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

const read = (p: string): string => readFileSync(new URL(`../scripts/${p}`, import.meta.url), 'utf8')
const installAios = read('install-temoto.sh')
const installSh = read('install.sh')

describe('detecting a running installer (TODO 931)', () => {
  it('install-temoto.sh uses a single pgrep pattern anchored at both ends, and does not match the gateway', () => {
    expect(installAios).not.toMatch(/pgrep[^\n]*MacOS\/aios\|/)
    const m = installAios.match(/^AIOS_PGREP="(.*)"$/m)
    expect(m).not.toBeNull()
    // TODO 1254: the check is in one place, aios_running (both the "already installed" branch before installing and the check before replacing call it)
    expect(installAios.match(/-f "\$AIOS_PGREP"/g)).toHaveLength(1)
    expect(m![1]!.startsWith('^')).toBe(true)
    expect(m![1]).toBe('^($VERSIONS/[^/]*/$APP_NAME|$APP)/Contents/MacOS/$PRODUCT\\$')
    // Hit or miss on the shape itself (put placeholder values in the shell's $VERSIONS / $APP / $APP_NAME / $PRODUCT and treat it as an ERE)
    const re = new RegExp('^(/v/[^/]*/Temoto.app|/app/Temoto.app)/Contents/MacOS/Temoto$')
    expect(re.test('/v/0.1.0/Temoto.app/Contents/MacOS/Temoto')).toBe(true)
    expect(re.test('/v/0.1.0/Temoto.app/Contents/MacOS/Temoto /x/gateway.js')).toBe(false)
    // Also fix both ends of the shape of a distribution installed under the previous name (aios.app)
    const legacy = installAios.match(/^LEGACY_PGREP="(.*)"$/m)
    expect(legacy![1]).toBe('^($VERSIONS/[^/]*/aios.app|$LEGACY_APP)/Contents/MacOS/aios\\$')
    expect(installAios.match(/-f "\$LEGACY_PGREP"/g)).toHaveLength(1)
  })

  it('install.sh also anchors to the end of the line', () => {
    expect(installSh).toMatch(/aios_running\(\) \{ pgrep [^\n]*"\^\$APP\/Contents\/MacOS\/aios\(-bin\)\?\\\$"/)
  })

  it('checks that SHA256SUMS has exactly one line for each required file before running shasum -c', () => {
    const loop = installAios.indexOf('for f in "$zip" install-backend.sh; do')
    expect(loop).toBeGreaterThan(0)
    expect(installAios).toMatch(/awk -v f="\$f" '\$2 == f'/)
    expect(loop).toBeLessThan(installAios.indexOf('grep -E "  ($zip|install-backend'))
    expect(installAios).toMatch(/awk '\$2 == "install-backend\.sh"'/)
  })
})

// TODO 1263 code-review: 0.92.x is already Temoto.app (matched by AIOS_PGREP) but signed local.aios. Quitting only the new identifier
// left it running and the swap gave up after 60 s. The identifiers come from the Info.plist of the bundles the pattern covers.
describe('identifiers for quitting a running Temoto.app (TODO 1263 code-review)', () => {
  const fn = /^temoto_bundle_ids\(\) \{\n[\s\S]*?\n\}$/m.exec(installAios)?.[0] ?? ''

  it("for a running Temoto.app, sends quit for each identifier held in the version's Info.plist (including the previous local.aios)", () => {
    expect(installAios).toMatch(/^LEGACY_BUNDLE_ID=local\.aios$/m)
    expect(fn).toContain('for bundle in "$APP" "$VERSIONS"/*/"$APP_NAME"; do')
    expect(fn).toContain(`/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Contents/Info.plist"`)
    expect(fn).toContain('[ "$ident" = "$LEGACY_BUNDLE_ID" ] && legacy_id=1')
    // The quit for a running Temoto.app goes through the list (not the new identifier alone)
    const quit = /if temoto_running; then\n([\s\S]*?)\n {2}fi/.exec(installAios)?.[1] ?? ''
    expect(quit).toContain('for id in $(temoto_bundle_ids); do')
    expect(quit).toContain('osascript -e "tell application id \\"$id\\" to quit"')
    expect(quit).not.toContain('$BUNDLE_ID')
  })

  const plist = (id: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>\n`

  it.runIf(process.platform === 'darwin')('the function itself: both if 0.92.x (local.aios) exists in the version directory or the real one, otherwise only the new identifier', () => {
    const dir = makeTestDir('install-quit-ids')
    try {
      const app = join(dir, 'Applications', 'Temoto.app')
      const versions = join(dir, 'versions')
      const put = (bundle: string, id: string): void => {
        mkdirSync(join(bundle, 'Contents'), { recursive: true })
        writeFileSync(join(bundle, 'Contents', 'Info.plist'), plist(id))
      }
      const env = {
        ...process.env,
        APP: app,
        VERSIONS: versions,
        APP_NAME: 'Temoto.app',
        BUNDLE_ID: 'io.github.temoto-app.temoto',
        LEGACY_BUNDLE_ID: 'local.aios'
      }
      const ids = (): string[] =>
        execFileSync('bash', ['-c', `set -euo pipefail\n${fn}\ntemoto_bundle_ids`], { encoding: 'utf8', env })
          .split('\n')
          .filter((line) => line !== '')
      // Nothing installed yet
      expect(ids()).toEqual(['io.github.temoto-app.temoto'])
      put(app, 'io.github.temoto-app.temoto')
      expect(ids()).toEqual(['io.github.temoto-app.temoto'])
      // 0.92.x left in a version directory
      put(join(versions, '0.92.2', 'Temoto.app'), 'local.aios')
      expect(ids()).toEqual(['io.github.temoto-app.temoto', 'local.aios'])
      // 0.92.x as the real $APP
      rmSync(versions, { recursive: true })
      put(app, 'local.aios')
      expect(ids()).toEqual(['io.github.temoto-app.temoto', 'local.aios'])
      // Any other identifier is not asked
      put(app, 'com.example.other')
      expect(ids()).toEqual(['io.github.temoto-app.temoto'])
    } finally {
      removeTestDir(dir)
    }
  })
})
