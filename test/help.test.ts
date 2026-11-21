/**
 * Resolution and reading of `help://` for Help (TODO 1174, ARCHITECTURE.md 7.4.13) (`src/main/help.ts`, does not depend on electron).
 *
 * - Checks the URI (`parseHelpUri`): refuses a wrong scheme, pages it does not know, paths or credentials, and unknown languages.
 * - Does not leave the bundled folder: names not in the table are not read, and a symlink pointing outside is not read.
 * - The viewer names `aios.html` directly, and has no field that ties it to a file.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { helpUri, parseHelpUri } from '../src/shared/help.js'
import { HELP_VIEWER_ID, helpRoot, openHelp, resolveHelpFile } from '../src/main/help.js'
import type { ResolvedViewer } from '../src/shared/plugin.js'
import { makeTestDir, removeTestDir } from './helpers/tmp.js'

const repoRoot = join(__dirname, '..')
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) removeTestDir(dir)
})

function fixture(): { root: string; outside: string } {
  const base = makeTestDir('help')
  dirs.push(base)
  const root = join(base, 'help')
  mkdirSync(root)
  const outside = join(base, 'secret.html')
  writeFileSync(outside, '<p>outside</p>')
  return { root, outside }
}

const viewer: ResolvedViewer = {
  pluginId: HELP_VIEWER_ID,
  name: 'HTML',
  url: 'aios-plugin://aios.html/viewer/index.html',
  editable: true,
  delivery: 'text',
  linkTargetUri: 'file:///somewhere/else.html'
}

describe('parseHelpUri', () => {
  it('reads help://index and the language', () => {
    expect(parseHelpUri('help://index?lang=ja')).toEqual({ page: 'index', lang: 'ja' })
    expect(parseHelpUri('help://index?lang=en')).toEqual({ page: 'index', lang: 'en' })
    expect(parseHelpUri('help://index/')).toEqual({ page: 'index', lang: 'en' })
    // If lang is missing, the default (the display language) is used.
    expect(parseHelpUri('help://index', 'ja')).toEqual({ page: 'index', lang: 'ja' })
    expect(parseHelpUri(helpUri('ja'))).toEqual({ page: 'index', lang: 'ja' })
  })

  it('a different scheme, unknown page, path, credentials, port, unknown language and non-strings are null', () => {
    for (const uri of [
      'file:///Users/me/index.html',
      'aios-res://local/x/index.html',
      'help://other',
      'help://index/../../etc/passwd',
      'help://index/index.html',
      'help://user:pw@index',
      'help://index:80',
      'help://index?lang=fr',
      'help://constructor',
      'help://__proto__',
      'help:index',
      ''
    ]) {
      expect(parseHelpUri(uri), uri).toBeNull()
    }
    expect(parseHelpUri(42)).toBeNull()
    expect(parseHelpUri(null)).toBeNull()
    expect(parseHelpUri(`help://index?lang=ja&x=${'a'.repeat(300)}`)).toBeNull()
  })
})

describe('resolveHelpFile / openHelp', () => {
  it('reads index.html of the bundled folder, and the viewer is looked up by naming aios.html', () => {
    const { root } = fixture()
    writeFileSync(join(root, 'index.html'), '<p>help</p>')
    const asked: Array<[string, string]> = []
    const doc = openHelp(
      {
        root,
        locale: () => 'ja',
        resolveViewerWith: (uri, pluginId) => {
          asked.push([uri, pluginId])
          return viewer
        }
      },
      'help://index'
    )
    expect(doc?.text).toBe('<p>help</p>')
    // If the URI has no lang, the display language is used.
    expect(doc?.lang).toBe('ja')
    expect(asked).toEqual([['file:///index.html', HELP_VIEWER_ID]])
    // Only the fields needed for the temporary display (fields tied to a file and editing are not passed).
    expect(doc?.viewer).toEqual({
      pluginId: HELP_VIEWER_ID,
      name: 'HTML',
      url: viewer.url,
      editable: false,
      delivery: 'text'
    })
  })

  it('if aios.html is disabled, the body is returned and the viewer is null', () => {
    const { root } = fixture()
    writeFileSync(join(root, 'index.html'), '<p>help</p>')
    const doc = openHelp({ root, locale: () => 'en', resolveViewerWith: () => null }, 'help://index?lang=en')
    expect(doc).toEqual({ text: '<p>help</p>', lang: 'en', viewer: null })
  })

  it('does not read a symlink that points outside the folder', () => {
    const { root, outside } = fixture()
    symlinkSync(outside, join(root, 'index.html'))
    expect(resolveHelpFile(root, 'help://index')).toBeNull()
    expect(openHelp({ root, locale: () => 'en', resolveViewerWith: () => viewer }, 'help://index')).toBeNull()
  })

  it('null if the file is missing or the URI is invalid', () => {
    const { root } = fixture()
    expect(resolveHelpFile(root, 'help://index')).toBeNull()
    writeFileSync(join(root, 'index.html'), 'x')
    expect(resolveHelpFile(root, 'help://index/../secret.html')).toBeNull()
    expect(resolveHelpFile(root, 'file:///etc/passwd')).toBeNull()
    expect(resolveHelpFile(join(root, 'missing'), 'help://index')).toBeNull()
  })

  it('does not read anything that is not a regular file (index.html is a folder)', () => {
    const { root } = fixture()
    mkdirSync(join(root, 'index.html'))
    expect(openHelp({ root, locale: () => 'en', resolveViewerWith: () => viewer }, 'help://index')).toBeNull()
  })

  it("index.html exists in the repository's resources/help/ (the same `<appPath>/resources/help` in dev, the shell and the distributed build)", () => {
    const root = helpRoot(repoRoot)
    expect(root).toBe(join(repoRoot, 'resources', 'help'))
    const file = resolveHelpFile(root, helpUri('ja'))
    expect(file?.lang).toBe('ja')
    expect(file?.path.endsWith(join('resources', 'help', 'index.html'))).toBe(true)
  })
})
