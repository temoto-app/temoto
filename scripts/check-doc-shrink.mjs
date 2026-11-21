#!/usr/bin/env node
/**
 * Checks that large documents are not cut off partway (TODO 184, `npm run lint:docs`).
 *
 * On 2026-09-27, a half-written guide that the merge script had been writing was cut at 262,144 bytes by another session's `sed -i`,
 * and committed as it was. The table of guarded documents is docs/doc-guard.json
 * (scripts/ is scanned by lint:terms, so the file names are not written here).
 *
 * - shrink: fails if the working-tree version is smaller than `git show HEAD:<path>` by maxShrink or more.
 *   It is not checked when the file is not in HEAD or when git is not usable.
 * - tail: the file ends correctly as UTF-8 (not cut in the middle of a character), and it ends with a newline.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

/** The tail check. Returns null if there is no problem, or the reason as a string if there is one. @param {Uint8Array} bytes */
export function tailProblem(bytes) {
  if (bytes.length === 0) return '空のファイル'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return 'UTF-8 として読めない (文字の途中で切れている)'
  }
  if (bytes[bytes.length - 1] !== 0x0a) return '改行で終わっていない'
  return null
}

/**
 * The shrink check. Returns null if there is no problem.
 * @param {number} before the byte count in HEAD @param {number} after the byte count in the working tree @param {number} maxShrink
 */
export function shrinkProblem(before, after, maxShrink) {
  if (before <= 0) return null
  const ratio = (before - after) / before
  if (ratio >= maxShrink) {
    return `HEAD の ${before} バイトから ${after} バイトへ ${(ratio * 100).toFixed(1)}% 縮んだ (上限 ${maxShrink * 100}%)`
  }
  return null
}

/** @param {string} repoRoot @param {string} path */
function headBytes(repoRoot, path) {
  try {
    return execFileSync('git', ['show', `HEAD:${path}`], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
}

/** @param {string} repoRoot @param {string} entry */
function expand(repoRoot, entry) {
  const full = join(repoRoot, entry)
  let st
  try {
    st = statSync(full)
  } catch {
    return []
  }
  if (!st.isDirectory()) return [entry]
  return readdirSync(full)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `${entry}/${name}`)
}

/** The location of the table of guarded documents (from the repo root). */
export const GUARD_PATH = 'docs/doc-guard.json'

/**
 * @param {string} repoRoot
 * @returns {{ problems: string[], checked: number, skipped: string | null }}
 */
export function run(repoRoot) {
  // TODO 1185 (owner decision 2026-11-08): if the target is missing, skip. The public repo copies neither docs/ nor the guide, so the table is absent altogether.
  // But if it was in HEAD and is now gone, empty, or broken in the working tree, the guard was switched off silently, so stop.
  let raw
  try {
    raw = readFileSync(join(repoRoot, GUARD_PATH), 'utf8')
  } catch {
    if (headBytes(repoRoot, GUARD_PATH) !== null) {
      return { problems: [`${GUARD_PATH}: HEAD にあるのに読めない (消えている?)`], checked: 0, skipped: null }
    }
    return { problems: [], checked: 0, skipped: `${GUARD_PATH} が無い` }
  }
  let config
  try {
    config = JSON.parse(raw)
    if (!Array.isArray(config?.tail) || !Array.isArray(config?.shrink)) throw new Error('tail / shrink が配列でない')
  } catch (e) {
    return { problems: [`${GUARD_PATH}: 表として読めない (${e instanceof Error ? e.message : String(e)})`], checked: 0, skipped: null }
  }
  const problems = []
  let checked = 0
  for (const entry of config.tail) {
    for (const path of expand(repoRoot, entry)) {
      checked += 1
      const problem = tailProblem(readFileSync(join(repoRoot, path)))
      if (problem) problems.push(`${path}: ${problem}`)
    }
  }
  // Only a commit that shrinks a document on purpose (for example, moving a section into a note) can switch off the shrink check, with an environment variable. The tail check is not switched off.
  const shrinkAllowed = process.env.AIOS_DOC_SHRINK_OK === '1'
  for (const { path, maxShrink } of shrinkAllowed ? [] : config.shrink) {
    const before = headBytes(repoRoot, path)
    let now
    try {
      now = readFileSync(join(repoRoot, path))
    } catch {
      // If it is not in HEAD either, the target simply does not exist (skip). If it is in HEAD but missing from the working tree, it was deleted (stop).
      if (before !== null) problems.push(`${path}: 読めない (消えている?)`)
      continue
    }
    if (before === null) continue
    const problem = shrinkProblem(before.length, now.length, maxShrink)
    if (problem) problems.push(`${path}: ${problem}`)
  }
  return { problems, checked, skipped: null }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const { problems, checked, skipped } = run(repoRoot)
  if (skipped !== null) {
    console.log(`lint:docs skip — ${skipped} (守る文書が無い)`)
    process.exit(0)
  }
  if (problems.length > 0) {
    console.error('文書が切れているか、大きく縮んでいます (TODO 184):')
    for (const p of problems) console.error(`  ${p}`)
    console.error('意図した縮みなら AIOS_DOC_SHRINK_OK=1 を付けて走らせる (末尾の検査は外れない)。')
    process.exit(1)
  }
  console.log(`lint:docs OK — ${checked} 文書の末尾と縮みを検査`)
}
