/**
 * TODO 404 (wave 21 bundle E): icons by kind for the Files tree and the search results (colored Seti).
 *
 * - `fileIconFor`: extension / file name → shape and color. Upper and lower case, compound extensions (`.d.ts` / `.test.ts`), matches by file name (`Dockerfile` / `package.json` / `.gitignore`), a leading dot, and anything not in the table
 * - Every shape in the table is in `SETI_SHAPES`, and every color has a styles.css variable and class
 * - No hard-coded colors in the bundled shapes and parts (7.4.1); nothing is read from outside (CSP)
 * - `FileIcon` rendering: currentColor, the color class, and the white parts of zip are cut out with a mask
 *
 * The Seti license text (matching THIRD_PARTY_NOTICES.md and About) was generalized in TODO 438 and moved to `test/third-party-notices.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fileIconFor, FILE_ICON_COLORS, SPECIAL_FOLDER_COLORS, specialFolderFor } from '../src/renderer/src/file-icons.js'
import { SPECIAL_FOLDER_SHAPES } from '../src/renderer/src/icons/file-icons/special-folder-shapes.js'
import { SETI_SHAPES } from '../src/renderer/src/icons/file-icons/seti-shapes.js'
import { FileIcon } from '../src/renderer/src/icons/file-icons/FileIcon.js'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8')

describe('fileIconFor (TODO 404)', () => {
  it.each([
    ['index.ts', 'typescript', 'blue'],
    ['App.tsx', 'react', 'blue'],
    ['main.js', 'javascript', 'yellow'],
    ['view.jsx', 'react', 'blue'],
    ['data.json', 'json', 'yellow'],
    ['README.md', 'markdown', 'blue'],
    ['styles.css', 'css', 'blue'],
    ['index.html', 'html', 'orange'],
    ['tool.py', 'python', 'blue'],
    ['build.sh', 'shell', 'green'],
    ['ci.yaml', 'yml', 'purple'],
    ['ci.yml', 'yml', 'purple'],
    ['Cargo.toml', 'config', 'grey'],
    ['Cargo.lock', 'lock', 'green'],
    ['photo.png', 'image', 'purple'],
    ['photo.jpg', 'image', 'purple'],
    ['logo.svg', 'svg', 'purple'],
    ['paper.pdf', 'pdf', 'red'],
    ['clip.mp4', 'video', 'pink'],
    ['song.mp3', 'audio', 'purple'],
    ['report.docx', 'word', 'blue'],
    ['sheet.xlsx', 'xls', 'green'],
    ['archive.zip', 'zip', 'grey'],
    ['notes.txt', 'default', 'muted'],
    ['table.csv', 'csv', 'green'],
    ['schema.sql', 'db', 'pink'],
    ['main.rs', 'rust', 'grey'],
    ['main.go', 'go', 'blue'],
    ['Main.java', 'java', 'red'],
    ['main.c', 'c', 'blue'],
    ['main.cpp', 'cpp', 'blue'],
    ['App.swift', 'swift', 'orange'],
    ['app.rb', 'ruby', 'red'],
    ['styles.scss', 'sass', 'pink'],
    ['feed.xml', 'xml', 'orange']
  ])('%s → %s (%s)', (name, icon, color) => {
    expect(fileIconFor(name, false)).toEqual({ icon, color })
  })

  it('大文字小文字を区別しない', () => {
    expect(fileIconFor('PHOTO.JPG', false)).toEqual({ icon: 'image', color: 'purple' })
    expect(fileIconFor('Index.TS', false)).toEqual({ icon: 'typescript', color: 'blue' })
    expect(fileIconFor('PACKAGE.JSON', false)).toEqual({ icon: 'npm', color: 'red' })
  })

  it('複合拡張子は長いほうから (Seti: テストは orange、.d.ts は TypeScript のまま)', () => {
    expect(fileIconFor('types.d.ts', false)).toEqual({ icon: 'typescript', color: 'blue' })
    expect(fileIconFor('store.test.ts', false)).toEqual({ icon: 'typescript', color: 'orange' })
    expect(fileIconFor('store.spec.ts', false)).toEqual({ icon: 'typescript', color: 'orange' })
    expect(fileIconFor('Pane.test.tsx', false)).toEqual({ icon: 'react', color: 'orange' })
    expect(fileIconFor('electron.vite.config.ts', false)).toEqual({ icon: 'typescript', color: 'blue' })
    expect(fileIconFor('backup.tar.gz', false)).toEqual({ icon: 'zip', color: 'grey' })
  })

  it('ファイル名での一致が拡張子より先', () => {
    expect(fileIconFor('package.json', false)).toEqual({ icon: 'npm', color: 'red' })
    expect(fileIconFor('package-lock.json', false)).toEqual({ icon: 'npm', color: 'red' })
    expect(fileIconFor('tsconfig.json', false)).toEqual({ icon: 'tsconfig', color: 'blue' })
    expect(fileIconFor('yarn.lock', false)).toEqual({ icon: 'lock', color: 'green' })
    expect(fileIconFor('Dockerfile', false)).toEqual({ icon: 'docker', color: 'blue' })
    expect(fileIconFor('DOCKERFILE', false)).toEqual({ icon: 'docker', color: 'blue' })
    expect(fileIconFor('Dockerfile.dev', false)).toEqual({ icon: 'docker', color: 'blue' })
    expect(fileIconFor('docker-compose.yml', false)).toEqual({ icon: 'docker', color: 'pink' })
    expect(fileIconFor('.gitignore', false)).toEqual({ icon: 'git', color: 'grey' })
    expect(fileIconFor('LICENSE', false)).toEqual({ icon: 'license', color: 'yellow' })
    expect(fileIconFor('LICENSE.md', false)).toEqual({ icon: 'license', color: 'yellow' })
    expect(fileIconFor('.env.local', false)).toEqual({ icon: 'config', color: 'grey' })
  })

  it('頭のドットは拡張子の区切りに数えない・表に無いものは汎用の印', () => {
    expect(fileIconFor('.bashrc', false)).toEqual({ icon: 'default', color: 'muted' })
    expect(fileIconFor('.eslintrc.json', false)).toEqual({ icon: 'json', color: 'yellow' })
    expect(fileIconFor('Makefile.bak', false)).toEqual({ icon: 'default', color: 'muted' })
    expect(fileIconFor('noext', false)).toEqual({ icon: 'default', color: 'muted' })
    expect(fileIconFor('weird.xyz123', false)).toEqual({ icon: 'default', color: 'muted' })
    expect(fileIconFor('', false)).toEqual({ icon: 'default', color: 'muted' })
    expect(fileIconFor('trailing.', false)).toEqual({ icon: 'default', color: 'muted' })
  })

  it('フォルダは名前によらず folder / folder-open (開閉)', () => {
    expect(fileIconFor('src', true)).toEqual({ icon: 'folder', color: 'muted' })
    expect(fileIconFor('src', true, true)).toEqual({ icon: 'folder-open', color: 'muted' })
    expect(fileIconFor('node.js', true)).toEqual({ icon: 'folder', color: 'muted' })
  })
})

describe('同梱の形と色 (TODO 404)', () => {
  const css = read('src/renderer/src/styles.css')

  it('色の全部に --file-icon-<色> の変数とクラスがある (muted は既存の --fg-dim)', () => {
    for (const color of FILE_ICON_COLORS) {
      expect(css).toContain(`--file-icon-${color}:`)
      expect(css).toContain(`.file-icon-${color} { color: var(--file-icon-${color}); }`)
    }
    expect(css).toContain('.file-icon-muted { color: var(--fg-dim); }')
  })

  it('形と部品に色の直書きが無く (7.4.1)、外から読まない (CSP)', () => {
    for (const file of [
      'src/renderer/src/icons/file-icons/seti-shapes.ts',
      'src/renderer/src/icons/file-icons/FileIcon.tsx',
      'src/renderer/src/file-icons.ts'
    ]) {
      const source = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(source.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) ?? [], file).toEqual([])
      expect(source, file).not.toMatch(/https?:/)
    }
  })

  it('どの形も viewBox と 1 本以上の path を持つ', () => {
    for (const [name, shape] of Object.entries(SETI_SHAPES)) {
      expect(shape.viewBox, name).toMatch(/^[\d.]+ [\d.]+ [\d.]+ [\d.]+$/)
      expect(shape.paths.length, name).toBeGreaterThan(0)
    }
  })
})

describe('FileIcon の描画 (TODO 404)', () => {
  it('currentColor で塗り、色はクラスで当てる・読み上げには出さない', () => {
    const html = renderToStaticMarkup(createElement(FileIcon, { name: 'a.ts', isDirectory: false }))
    expect(html).toContain('class="file-icon file-icon-blue"')
    expect(html).toContain('fill="currentColor"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('data-icon="typescript"')
    expect(html).not.toContain('<mask')
  })

  it('フォルダの開閉で形が替わる', () => {
    const closed = renderToStaticMarkup(createElement(FileIcon, { name: 'src', isDirectory: true }))
    const open = renderToStaticMarkup(createElement(FileIcon, { name: 'src', isDirectory: true, expanded: true }))
    expect(closed).toContain('data-icon="folder"')
    expect(open).toContain('data-icon="folder-open"')
  })

  it('zip の白い部分は mask で抜く (地が透ける)', () => {
    const html = renderToStaticMarkup(createElement(FileIcon, { name: 'a.zip', isDirectory: false }))
    const id = /<mask id="([^"]+)"/.exec(html)?.[1]
    expect(id).toMatch(/^file-icon-cut-[A-Za-z0-9_-]+$/)
    expect(html).toContain(`mask="url(#${id})"`)
  })
})

describe('ホーム直下の特別なフォルダ (TODO 958)', () => {
  const home = 'file:///Users/alice'
  it.each([
    ['Downloads', 'Downloads'],
    ['Desktop', 'Desktop'],
    ['Documents', 'Documents'],
    ['Movies', 'Movies'],
    ['Music', 'Music'],
    ['Pictures', 'Pictures'],
    ['Public', 'Public'],
    ['Library', 'Library'],
    ['Applications', 'Applications'],
    ['.Trash', 'Trash']
  ])('ホーム直下の %s は専用', (dir, expected) => {
    expect(specialFolderFor(`${home}/${dir}`, home)).toBe(expected)
  })

  it('ルート直下の /Applications も専用 (TODO 968)', () => {
    expect(specialFolderFor('file:///Applications', home)).toBe('Applications')
    expect(specialFolderFor('file:///Applications', '')).toBe('Applications')
    expect(specialFolderFor('file:///Applications/x', home)).toBeNull()
  })

  it('ホーム直下以外・別の名前・ホームが未着は普通のフォルダ', () => {
    expect(specialFolderFor(`${home}/proj/Documents`, home)).toBeNull()
    expect(specialFolderFor('file:///Documents', home)).toBeNull()
    expect(specialFolderFor(`${home}/Trash`, home)).toBeNull()
    expect(specialFolderFor(`${home}/Docs`, home)).toBeNull()
    expect(specialFolderFor(`${home}/constructor`, home)).toBeNull()
    expect(specialFolderFor(`${home}/Downloads`, '')).toBeNull()
  })

  it('全部の形に色があり、描画は専用の形・色のクラスで、輪郭なしの絵だけ。開閉でも同じ形', () => {
    for (const name of Object.keys(SPECIAL_FOLDER_SHAPES) as (keyof typeof SPECIAL_FOLDER_SHAPES)[]) {
      expect(SPECIAL_FOLDER_COLORS[name], name).toBeDefined()
      const html = renderToStaticMarkup(createElement(FileIcon, { name, isDirectory: true, special: name }))
      expect(html).toContain(`data-icon="folder-${name}"`)
      expect(html).not.toContain('<mask')
      const open = renderToStaticMarkup(createElement(FileIcon, { name, isDirectory: true, expanded: true, special: name }))
      expect(open).toContain(`data-icon="folder-${name}"`)
    }
    const html = renderToStaticMarkup(createElement(FileIcon, { name: 'Downloads', isDirectory: true, special: 'Downloads' }))
    expect(html).toContain('file-icon-green')
    expect(SPECIAL_FOLDER_COLORS.Documents).toBe('amber')
    expect(SPECIAL_FOLDER_COLORS.Public).not.toBe('yellow')
  })

  it('TODO 1011: 拡大は 2.1 倍、Movies は変数で 2 色、Applications / Documents は穴を evenodd で抜く', () => {
    for (const shape of Object.values(SPECIAL_FOLDER_SHAPES)) {
      for (const p of shape.paths) expect((p as { transform: string }).transform).toContain('scale(2.1)')
    }
    const movies = renderToStaticMarkup(createElement(FileIcon, { name: 'Movies', isDirectory: true, special: 'Movies' }))
    expect(movies).toContain('var(--file-icon-movies-bg)')
    expect(movies).toContain('var(--file-icon-movies-mark)')
    expect(movies).not.toMatch(/#[0-9a-f]{3,6}/i)
    for (const name of ['Applications', 'Documents'] as const) {
      const html = renderToStaticMarkup(createElement(FileIcon, { name, isDirectory: true, special: name }))
      expect(html, name).toContain('fill-rule="evenodd"')
    }
  })

  it('special を渡しても、ファイルは専用にならない', () => {
    const html = renderToStaticMarkup(createElement(FileIcon, { name: 'a.ts', isDirectory: false, special: 'Downloads' }))
    expect(html).toContain('data-icon="typescript"')
  })
})
