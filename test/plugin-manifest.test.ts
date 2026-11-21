/**
 * Manifest validation and viewer resolution (ARCHITECTURE.md 7.1 / 7.2).
 *
 * **The format was fixed in Phase 4.** The differences from the "draft" of 7.2 are written in 12.9.
 * The premise that `capabilities` is a **declaration of an upper limit**, not a grant, is pinned down by `declaredCapabilities` and the Broker-side test (capability-fs).
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ManifestError,
  declaredCapabilities,
  iconFileOf,
  needsHost,
  parseManifest,
  resolveEntry
} from '../src/main/plugin/manifest.js'

const repoRoot = new URL('..', import.meta.url).pathname

const minimal = {
  id: 'aios.sample',
  name: 'Sample',
  version: '1.0.0'
}

describe('マニフェストの検証', () => {
  it('最小のマニフェストを読める', () => {
    const manifest = parseManifest(minimal)
    expect(manifest.id).toBe('aios.sample')
    expect(manifest.capabilities).toEqual({})
  })

  it('id は逆ドメイン形式に限る', () => {
    expect(() => parseManifest({ ...minimal, id: 'Sample' })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, id: 'aios' })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, id: 'aios..x' })).toThrow(ManifestError)
    // Used as the URL authority, so slashes and spaces are not allowed.
    expect(() => parseManifest({ ...minimal, id: 'aios.a/b' })).toThrow(ManifestError)
  })

  it('**TODO 920: index.write は自分の id の名前空間だけ** (組み込み・他の plugin・紛らわしい接頭辞を拒む)', () => {
    const withIndex = (write: string[]): unknown => ({ ...minimal, capabilities: { index: { write } } })
    expect(parseManifest(withIndex(['aios.sample', 'aios.sample:mail', 'aios.sample/notes-2'])).capabilities.index?.write).toEqual([
      'aios.sample',
      'aios.sample:mail',
      'aios.sample/notes-2'
    ])
    for (const bad of [
      'conversation',
      'transcript',
      'fs',
      'aios.other',
      'aios.other:mail',
      'aios.samplex',
      'aios.sample.evil',
      'aios.sample:',
      'aios.sample:Mail',
      'aios.sample:../x',
      `aios.sample:${'a'.repeat(200)}`
    ]) {
      expect(() => parseManifest(withIndex([bad])), bad).toThrow(ManifestError)
    }
  })

  it('知らない鍵があれば読み込まない (推測で補完しない)', () => {
    expect(() => parseManifest({ ...minimal, backdoor: true })).toThrow(ManifestError)
    expect(() =>
      parseManifest({ ...minimal, capabilities: { process: { spawn: true } } })
    ).toThrow(ManifestError)
  })

  it('entry はプラグインディレクトリの外を指せない', () => {
    expect(() =>
      parseManifest({ ...minimal, viewer: { entry: '/etc/passwd' } })
    ).toThrow(ManifestError)
    expect(() =>
      parseManifest({ ...minimal, viewer: { entry: '../../src/main/index.js' } })
    ).toThrow(ManifestError)
  })

  it('resolveEntry も外に出る指定を拒否する', () => {
    expect(resolveEntry('/plugins/a', 'viewer/index.html')).toBe('/plugins/a/viewer/index.html')
    expect(() => resolveEntry('/plugins/a', '../b/x.js')).toThrow(ManifestError)
  })

  it('network の hosts はホスト名の形に限る', () => {
    expect(() =>
      parseManifest({ ...minimal, capabilities: { network: { hosts: ['https://x.com/a'] } } })
    ).toThrow(ManifestError)
    const ok = parseManifest({
      ...minimal,
      capabilities: { network: { hosts: ['*.example.com', 'api.example.com'] } }
    })
    expect(ok.capabilities.network?.hosts).toHaveLength(2)
  })
})

describe('宣言の読み取り', () => {
  it('viewer を持つプラグインには fs が立つ (7.2 の暗黙の許可)', () => {
    const manifest = parseManifest({ ...minimal, viewer: { entry: 'viewer/index.html' } })
    expect(declaredCapabilities(manifest)).toContain('fs')
  })

  it('空の network 宣言は能力として立てない', () => {
    const manifest = parseManifest({ ...minimal, capabilities: { network: { hosts: [] } } })
    expect(declaredCapabilities(manifest)).not.toContain('network')
  })

  it('viewer だけのプラグインは plugin-host を起こさない', () => {
    expect(needsHost(parseManifest({ ...minimal, viewer: { entry: 'v/index.html' } }))).toBe(false)
    // A viewer that claims by the kind of contents (item 104). An unknown kind is dropped.
    expect(parseManifest({ ...minimal, viewer: { entry: 'v/index.html', payloads: ['diff'] } }).viewer?.payloads).toEqual(['diff'])
    expect(() => parseManifest({ ...minimal, viewer: { entry: 'v/index.html', payloads: ['pdf'] } })).toThrow()
    // Explicit specification of how the body is delivered (code-review of TODO 906).
    expect(parseManifest({ ...minimal, viewer: { entry: 'v/index.html', delivery: 'text' } }).viewer?.delivery).toBe('text')
    expect(() => parseManifest({ ...minimal, viewer: { entry: 'v/index.html', delivery: 'blob' } })).toThrow()
    // Only xlsx can declare drafts of cell values (TODO 1212 stage 1).
    expect(parseManifest({ ...minimal, viewer: { entry: 'v/index.html', cellEdits: ['xlsx'] } }).viewer?.cellEdits).toEqual(['xlsx'])
    expect(() => parseManifest({ ...minimal, viewer: { entry: 'v/index.html', cellEdits: ['docx'] } })).toThrow()
    expect(parseManifest({ ...minimal, viewer: { entry: 'v/index.html', cellEdits: ['xlsx', 'xlsm'] } }).viewer?.cellEdits).toEqual(['xlsx', 'xlsm'])
    expect(() => parseManifest({ ...minimal, viewer: { entry: 'v/index.html', cellEdits: ['xlsb'] } })).toThrow()
    expect(
      needsHost(
        parseManifest({
          ...minimal,
          command: { entry: 'host/x.js', commands: [{ id: 'a', title: 'A' }] }
        })
      )
    ).toBe(true)
  })
})

describe('同梱プラグインの実物', () => {
  for (const id of ['aios.text', 'aios.markdown', 'aios.image', 'aios.diff', 'aios.video', 'aios.office', 'aios.pdf', 'aios.html', 'aios.zip']) {
    it(`${id} のマニフェストが検証を通る`, () => {
      const raw = JSON.parse(readFileSync(join(repoRoot, 'plugins', id, 'manifest.json'), 'utf8'))
      const manifest = parseManifest(raw)
      expect(manifest.id).toBe(id)
      expect(manifest.viewer).toBeDefined()
      // **The standard viewers declare neither network nor credentials.**
      expect(manifest.capabilities.network).toBeUndefined()
      expect(manifest.capabilities.credentials).toBeUndefined()
      // fs is also an empty declaration; what can actually be read is only the "URI the user opened" (7.2).
      expect(manifest.capabilities.fs?.read ?? []).toEqual([])
    })
  }
})

describe('上位の鍵 (TODO 368)', () => {
  it('displayName / description / icon / publisher はどれも任意で読める', () => {
    const manifest = parseManifest({
      ...minimal,
      displayName: 'Sample Viewer',
      description: 'Shows samples.',
      icon: 'media/icon.png',
      publisher: 'example'
    })
    expect(manifest.displayName).toBe('Sample Viewer')
    expect(manifest.description).toBe('Shows samples.')
    expect(manifest.icon).toBe('media/icon.png')
    expect(manifest.publisher).toBe('example')
    // It is readable even without it (manifests so far pass as they are).
    expect(parseManifest(minimal).displayName).toBeUndefined()
  })

  it('型・長さ・空を検める。icon は entry と同じくディレクトリの外を指せない', () => {
    expect(() => parseManifest({ ...minimal, displayName: '' })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, displayName: '   ' })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, description: 42 })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, description: 'x'.repeat(257) })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, publisher: 'x'.repeat(65) })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, icon: '/etc/icon.png' })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, icon: '../icon.png' })).toThrow(ManifestError)
  })

  it('icon は .svg / .png に限る (TODO 524)', () => {
    expect(parseManifest({ ...minimal, icon: 'icon.svg' }).icon).toBe('icon.svg')
    expect(parseManifest({ ...minimal, icon: 'media/Icon.PNG' }).icon).toBe('media/Icon.PNG')
    for (const icon of ['icon', 'icon.gif', 'icon.html', 'icon.svg.js', 'media/../../icon.svg']) {
      expect(() => parseManifest({ ...minimal, icon })).toThrow(ManifestError)
    }
  })

  it('構造は変えていない: .strict() のまま、VS Code の contributes などは読まない', () => {
    expect(() => parseManifest({ ...minimal, contributes: {} })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, activationEvents: [] })).toThrow(ManifestError)
  })

  for (const id of [
    'aios.text',
    'aios.markdown',
    'aios.image',
    'aios.diff',
    'aios.video',
    'aios.office',
    'aios.pdf',
    'aios.html',
    'aios.zip',
    'aios.gmail',
    'aios.calendar',
    'aios.reddit',
    'aios.bitbucket'
  ]) {
    it(`${id} は displayName と一行説明 (EN) を持つ`, () => {
      const raw = JSON.parse(readFileSync(join(repoRoot, 'plugins', id, 'manifest.json'), 'utf8'))
      const manifest = parseManifest(raw)
      expect(manifest.displayName).toMatch(/^[A-Za-z][A-Za-z ]*$/)
      expect(manifest.description).toMatch(/^[\x20-\x7e]+\.$/)
    })
  }
})

describe('Activity Bar への寄与 (TODO 523 / 721)', () => {
  it('title / openUrl を読める', () => {
    const manifest = parseManifest({
      ...minimal,
      activityBar: { title: 'Gmail', openUrl: 'https://mail.google.com/' }
    })
    expect(manifest.activityBar).toEqual({ title: 'Gmail', openUrl: 'https://mail.google.com/' })
    // It is readable even without it.
    expect(parseManifest(minimal).activityBar).toBeUndefined()
  })

  it('TODO 721: openWith (web / external) を読める。無くても・知らない値は落ちる', () => {
    const external = parseManifest({
      ...minimal,
      activityBar: { title: 'Gmail', openUrl: 'https://mail.google.com/', openWith: 'external' }
    })
    expect(external.activityBar).toEqual({
      title: 'Gmail',
      openUrl: 'https://mail.google.com/',
      openWith: 'external'
    })
    expect(() =>
      parseManifest({
        ...minimal,
        activityBar: { title: 'X', openUrl: 'https://example.com/', openWith: 'browser' }
      })
    ).toThrow(ManifestError)
  })

  it('openUrl は http(s) で host のあるものに限る (isWebViewerUrl と同じ規則)', () => {
    for (const openUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'https://', 'mailto:a@b.test']) {
      expect(() => parseManifest({ ...minimal, activityBar: { title: 'X', openUrl } })).toThrow(ManifestError)
    }
  })

  it('title は空にできない。知らない鍵は読み込まない (.strict())', () => {
    expect(() =>
      parseManifest({ ...minimal, activityBar: { title: '', openUrl: 'https://example.com/' } })
    ).toThrow(ManifestError)
    expect(() =>
      parseManifest({
        ...minimal,
        activityBar: { title: 'X', openUrl: 'https://example.com/', icon: 'icon.svg' }
      })
    ).toThrow(ManifestError)
  })
})

describe('アイコンの実在とディレクトリの内側 (TODO 524、iconFileOf)', () => {
  function withDir(body: (dir: string, outside: string) => void): void {
    const base = mkdtempSync(join(tmpdir(), 'aios-plugin-icon-'))
    try {
      const dir = join(base, 'plugin')
      const outside = join(base, 'outside')
      mkdirSync(join(dir, 'media'), { recursive: true })
      mkdirSync(outside)
      writeFileSync(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
      writeFileSync(join(dir, 'media', 'icon.png'), 'png')
      writeFileSync(join(outside, 'secret.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
      body(dir, outside)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }
  const withIcon = (icon: string) => parseManifest({ ...minimal, icon })

  it('中にあるファイルは / 区切りの相対パスで返す。icon が無ければ null', () => {
    withDir((dir) => {
      expect(iconFileOf(dir, withIcon('icon.svg'))).toBe('icon.svg')
      expect(iconFileOf(dir, withIcon('./media/icon.png'))).toBe('media/icon.png')
      expect(iconFileOf(dir, parseManifest(minimal))).toBeNull()
    })
  })

  it('無いファイル・ディレクトリ・外を指す symlink は null (plugin そのものは読み込む)', () => {
    withDir((dir, outside) => {
      expect(iconFileOf(dir, withIcon('missing.svg'))).toBeNull()
      mkdirSync(join(dir, 'folder.svg'))
      expect(iconFileOf(dir, withIcon('folder.svg'))).toBeNull()
      symlinkSync(join(outside, 'secret.svg'), join(dir, 'escape.svg'))
      expect(iconFileOf(dir, withIcon('escape.svg'))).toBeNull()
      // An svg inside that points at a file of another, outside extension is also null.
      writeFileSync(join(dir, 'notes.txt'), 'x')
      symlinkSync(join(dir, 'notes.txt'), join(dir, 'alias.svg'))
      expect(iconFileOf(dir, withIcon('alias.svg'))).toBeNull()
    })
  })

  it('標準 plugin はどれも icon.svg を持ち、正本のディレクトリで実在する', () => {
    for (const id of ['aios.text', 'aios.markdown', 'aios.image', 'aios.diff', 'aios.video', 'aios.office', 'aios.pdf', 'aios.html', 'aios.zip']) {
      const dir = join(repoRoot, 'plugins', id)
      const manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')))
      expect(iconFileOf(dir, manifest), id).toBe('icon.svg')
      const svg = readFileSync(join(dir, 'icon.svg'), 'utf8')
      // It is drawn with `<img>`, so no script runs, and it is not written in the first place (nor any external reference).
      expect(svg, id).not.toMatch(/<script|on[a-z]+=|href=|url\(/i)
    }
  })
})
