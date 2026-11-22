#!/usr/bin/env node
// Makes build/icon.icns from build/icon.svg. It needs rsvg-convert (brew install librsvg).
// The output is committed, so it is only necessary to run this when the icon is redrawn.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const svg = join(root, 'build', 'icon.svg')
const icns = join(root, 'build', 'icon.icns')

try {
  execFileSync('rsvg-convert', ['--version'], { stdio: 'ignore' })
} catch {
  console.error('rsvg-convert が見つからない。brew install librsvg を実行してから再試行する。')
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'aios-icon-'))
const iconset = join(work, 'aios.iconset')
mkdirSync(iconset)

// The correspondence between the names that iconutil requires and the actual pixel sizes.
const variants = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

for (const [name, size] of variants) {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svg, '-o', join(iconset, name)])
}

execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icns])
rmSync(work, { recursive: true, force: true })
console.log(`icns: ${icns}`)

// TODO 1269: the menu bar template image. The name ends in `Template`, so macOS tints it for light / dark menu bars.
// It lives under resources/ (shipped inside the app next to resources/help), the SVG source stays in build/.
const traySvg = join(root, 'build', 'trayTemplate.svg')
const trayDir = join(root, 'resources', 'tray')
mkdirSync(trayDir, { recursive: true })
for (const [name, size] of [['trayTemplate.png', 22], ['trayTemplate@2x.png', 44]]) {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), traySvg, '-o', join(trayDir, name)])
}
// TODO 1302: the same glyph with a dot, shown while a conversation is running.
const trayRunningSvg = join(root, 'build', 'trayRunningTemplate.svg')
for (const [name, size] of [['trayRunningTemplate.png', 22], ['trayRunningTemplate@2x.png', 44]]) {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), trayRunningSvg, '-o', join(trayDir, name)])
}
console.log(`tray: ${trayDir}`)
