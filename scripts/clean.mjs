#!/usr/bin/env node
// Empties the build output (TODO 1203). `npm run clean`. release.mjs calls it right before the build.
//
// It deletes only out/ (but keeps out/check/, the flaky record of `npm run check`) and dist/. It does not touch node_modules, userData,
// the source, or anything outside out/ and dist/. It does not follow symbolic links; it removes the link itself.
import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** What is kept directly under out/. */
export const KEEP_IN_OUT = Object.freeze(['check'])

/**
 * The absolute paths to delete (a pure function; it touches no files).
 * @param {string} root the repository root
 * @param {readonly string[]} outEntries the names directly under out/
 * @param {boolean} hasDist whether dist/ exists
 */
export function cleanTargets(root, outEntries, hasDist) {
  const targets = []
  for (const name of [...outEntries].sort()) {
    if (KEEP_IN_OUT.includes(name)) continue
    targets.push(join(root, 'out', name))
  }
  if (hasDist) targets.push(join(root, 'dist'))
  return targets
}

/** Whether a path may be deleted: root/out/<name> (except what is kept), or root/dist itself. Anything else (one that leads out with `..`, root, node_modules, …) is false. */
export function isSafeTarget(root, target) {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  const parts = rel.split(sep)
  if (parts.length === 1) return parts[0] === 'dist'
  return parts.length === 2 && parts[0] === 'out' && parts[1] !== '' && parts[1] !== '..' && !KEEP_IN_OUT.includes(parts[1])
}

function exists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Empties root's out/ and dist/, and returns the paths that were deleted. */
export function clean(root) {
  const out = join(root, 'out')
  // If out/ itself is a link, do not follow it and delete its contents (so the target of the link is not broken).
  const outEntries = exists(out) && lstatSync(out).isDirectory() ? readdirSync(out) : []
  const targets = cleanTargets(root, outEntries, exists(join(root, 'dist')))
  for (const target of targets) {
    if (!isSafeTarget(root, target)) throw new Error(`clean: 消してはいけないパス: ${target}`)
    rmSync(target, { recursive: true, force: true })
  }
  return targets
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const removed = clean(root)
  console.log(`clean: ${removed.length} 件を消した (out/check/ は残す)${removed.length > 0 ? `: ${removed.map((p) => relative(root, p)).join(' ')}` : ''}`)
}
