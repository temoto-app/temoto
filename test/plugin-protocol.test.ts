/**
 * Judgment for delivering `aios-plugin://<id>/<path>` (`pluginFileOf`, 7.8 / TODO 524).
 *
 * - Anything outside the plugin's directory (`..`, a symlink escape) gives 403
 * - A disabled plugin serves **only its icon** (`servingDirectoryOf`). Other files give 404
 *
 * Electron's `protocol` is not used (the judgment is a pure function). The model is not called either.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ protocol: {} }))

const { pluginFileOf } = await import('../src/main/protocol.js')

let base: string
let dir: string

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'aios-plugin-protocol-')))
  dir = join(base, 'plugin')
  mkdirSync(join(dir, 'viewer'), { recursive: true })
  writeFileSync(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  writeFileSync(join(dir, 'viewer', 'index.html'), '<!doctype html>')
  writeFileSync(join(base, 'secret.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** Imitates, in the shape of `PluginHost`, an enabled plugin (everything inside the directory) and a disabled plugin (only the icon). */
function source(enabled: boolean) {
  return {
    servingDirectoryOf: (pluginId: string, relativePath: string): string | null => {
      if (pluginId !== 'aios.sample') return null
      if (enabled) return dir
      return relativePath === 'icon.svg' ? dir : null
    }
  }
}

describe('aios-plugin:// の配信 (pluginFileOf)', () => {
  it('有効の plugin はディレクトリの中のファイルを返す', () => {
    expect(pluginFileOf(source(true), 'aios-plugin://aios.sample/icon.svg')).toBe(join(dir, 'icon.svg'))
    expect(pluginFileOf(source(true), 'aios-plugin://aios.sample/viewer/index.html')).toBe(
      join(dir, 'viewer', 'index.html')
    )
  })

  it('外へ出るパスは中に畳まれ、symlink の脱出は 403、無いファイルと知らない plugin は 404', () => {
    // `..` is collapsed from the leading `/` and does not go above the root (URL parsing collapses `%2E%2E/`, and normalize collapses ones containing `%2F`).
    // → it looks for `secret.svg` inside the directory and finds none, so 404. An outside `secret.svg` is never returned.
    expect(pluginFileOf(source(true), 'aios-plugin://aios.sample/%2E%2E/secret.svg')).toBe(404)
    expect(pluginFileOf(source(true), 'aios-plugin://aios.sample/viewer/%2E%2E%2F%2E%2E%2Fsecret.svg')).toBe(404)
    symlinkSync(join(base, 'secret.svg'), join(dir, 'escape.svg'))
    expect(pluginFileOf(source(true), 'aios-plugin://aios.sample/escape.svg')).toBe(403)
    expect(pluginFileOf(source(true), 'aios-plugin://aios.sample/missing.svg')).toBe(404)
    expect(pluginFileOf(source(true), 'aios-plugin://aios.other/icon.svg')).toBe(404)
  })

  it('無効の plugin はアイコンだけ (viewer の HTML は 404)', () => {
    expect(pluginFileOf(source(false), 'aios-plugin://aios.sample/icon.svg')).toBe(join(dir, 'icon.svg'))
    expect(pluginFileOf(source(false), 'aios-plugin://aios.sample/viewer/index.html')).toBe(404)
  })

  it('知らない @… は版でなくファイルパス、知っている @<版>/ は版 (TODO 1144 段 3)', () => {
    mkdirSync(join(dir, '@scope'), { recursive: true })
    writeFileSync(join(dir, '@scope', 'lib.js'), '1')
    const old = join(base, 'old')
    mkdirSync(join(old, 'viewer'), { recursive: true })
    writeFileSync(join(old, 'viewer', 'index.html'), '<!doctype html>')
    const known = {
      servingDirectoryOf: (id: string, _p: string, revision: string | null): string | null => {
        if (id !== 'aios.sample') return null
        if (revision === null) return dir
        return revision === '0.9.0' ? old : null
      }
    }
    expect(pluginFileOf(known, 'aios-plugin://aios.sample/@scope/lib.js')).toBe(join(dir, '@scope', 'lib.js'))
    expect(pluginFileOf(known, 'aios-plugin://aios.sample/@0.9.0/viewer/index.html')).toBe(join(old, 'viewer', 'index.html'))
  })
})
