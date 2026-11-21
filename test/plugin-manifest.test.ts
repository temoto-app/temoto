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

describe('manifest validation', () => {
  it('reads a minimal manifest', () => {
    const manifest = parseManifest(minimal)
    expect(manifest.id).toBe('aios.sample')
    expect(manifest.capabilities).toEqual({})
  })

  it('id is limited to reverse-domain form', () => {
    expect(() => parseManifest({ ...minimal, id: 'Sample' })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, id: 'aios' })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, id: 'aios..x' })).toThrow(ManifestError)
    // Used as the URL authority, so slashes and spaces are not allowed.
    expect(() => parseManifest({ ...minimal, id: 'aios.a/b' })).toThrow(ManifestError)
  })

  it('TODO 920: index.write is only the namespace of its own id (rejects built-ins, other plugins, and confusable prefixes)', () => {
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

  it('does not load when there is an unknown key (does not complete by guessing)', () => {
    expect(() => parseManifest({ ...minimal, backdoor: true })).toThrow(ManifestError)
    expect(() =>
      parseManifest({ ...minimal, capabilities: { process: { spawn: true } } })
    ).toThrow(ManifestError)
  })

  it('entry cannot point outside the plugin directory', () => {
    expect(() =>
      parseManifest({ ...minimal, viewer: { entry: '/etc/passwd' } })
    ).toThrow(ManifestError)
    expect(() =>
      parseManifest({ ...minimal, viewer: { entry: '../../src/main/index.js' } })
    ).toThrow(ManifestError)
  })

  it('resolveEntry also rejects a specifier that escapes', () => {
    expect(resolveEntry('/plugins/a', 'viewer/index.html')).toBe('/plugins/a/viewer/index.html')
    expect(() => resolveEntry('/plugins/a', '../b/x.js')).toThrow(ManifestError)
  })

  it('network hosts are limited to hostname shape', () => {
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

describe('reading declarations', () => {
  it('a plugin with a viewer gets fs (the implicit grant in 7.2)', () => {
    const manifest = parseManifest({ ...minimal, viewer: { entry: 'viewer/index.html' } })
    expect(declaredCapabilities(manifest)).toContain('fs')
  })

  it('an empty network declaration is not set as a capability', () => {
    const manifest = parseManifest({ ...minimal, capabilities: { network: { hosts: [] } } })
    expect(declaredCapabilities(manifest)).not.toContain('network')
  })

  it('a viewer-only plugin does not start plugin-host', () => {
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

describe('the real bundled plugins', () => {
  for (const id of ['aios.text', 'aios.markdown', 'aios.image', 'aios.diff', 'aios.video', 'aios.office', 'aios.pdf', 'aios.html', 'aios.zip']) {
    it(`the manifest of ${id} passes validation`, () => {
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

describe('top-level keys (TODO 368)', () => {
  it('displayName / description / icon / publisher can all be read as optional', () => {
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

  it('checks type, length, and emptiness; icon cannot point outside the directory, like entry', () => {
    expect(() => parseManifest({ ...minimal, displayName: '' })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, displayName: '   ' })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, description: 42 })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, description: 'x'.repeat(257) })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, publisher: 'x'.repeat(65) })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, icon: '/etc/icon.png' })).toThrow(ManifestError)
    expect(() => parseManifest({ ...minimal, icon: '../icon.png' })).toThrow(ManifestError)
  })

  it('icon is limited to .svg / .png (TODO 524)', () => {
    expect(parseManifest({ ...minimal, icon: 'icon.svg' }).icon).toBe('icon.svg')
    expect(parseManifest({ ...minimal, icon: 'media/Icon.PNG' }).icon).toBe('media/Icon.PNG')
    for (const icon of ['icon', 'icon.gif', 'icon.html', 'icon.svg.js', 'media/../../icon.svg']) {
      expect(() => parseManifest({ ...minimal, icon })).toThrow(ManifestError)
    }
  })

  it('the structure is unchanged: still .strict(), and VS Code contributes and similar are not read', () => {
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
    it(`${id} has displayName and a one-line description (EN)`, () => {
      const raw = JSON.parse(readFileSync(join(repoRoot, 'plugins', id, 'manifest.json'), 'utf8'))
      const manifest = parseManifest(raw)
      expect(manifest.displayName).toMatch(/^[A-Za-z][A-Za-z ]*$/)
      expect(manifest.description).toMatch(/^[\x20-\x7e]+\.$/)
    })
  }
})

describe('contributions to the Activity Bar (TODO 523 / 721)', () => {
  it('reads title / openUrl', () => {
    const manifest = parseManifest({
      ...minimal,
      activityBar: { title: 'Gmail', openUrl: 'https://mail.google.com/' }
    })
    expect(manifest.activityBar).toEqual({ title: 'Gmail', openUrl: 'https://mail.google.com/' })
    // It is readable even without it.
    expect(parseManifest(minimal).activityBar).toBeUndefined()
  })

  it('TODO 721: reads openWith (web / external); missing or unknown values are dropped', () => {
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

  it('openUrl is limited to http(s) with a host (same rule as isWebViewerUrl)', () => {
    for (const openUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', 'https://', 'mailto:a@b.test']) {
      expect(() => parseManifest({ ...minimal, activityBar: { title: 'X', openUrl } })).toThrow(ManifestError)
    }
  })

  it('title cannot be empty; unknown keys are not loaded (.strict())', () => {
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

describe('icon existence and staying inside the directory (TODO 524, iconFileOf)', () => {
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

  it('returns a file inside as a /-separated relative path; null when there is no icon', () => {
    withDir((dir) => {
      expect(iconFileOf(dir, withIcon('icon.svg'))).toBe('icon.svg')
      expect(iconFileOf(dir, withIcon('./media/icon.png'))).toBe('media/icon.png')
      expect(iconFileOf(dir, parseManifest(minimal))).toBeNull()
    })
  })

  it('a missing file, a directory, and a symlink pointing outside are null (the plugin itself still loads)', () => {
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

  it('every standard plugin has icon.svg, and it exists in the canonical directory', () => {
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
