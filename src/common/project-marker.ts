/**
 * The I/O side of "does the parent directory hold a project marker" (TODO 1324).
 *
 * `classify` stays pure and takes the answer as an argument. Every caller that does not already hold the parent's listing
 * (watch diffs, listing, the read gate, create, the Broker) asks here, so the scan, the watch, the listing, the Broker and
 * create all get the same answer from the same code. The scan is the one exception that reads names it already has
 * (`hasProjectMarker` over its readdir result) and adds no I/O.
 *
 * **Only names are looked at.** A directory's content can be planted by someone else, so this does a single `readdir` of the
 * parent and compares names: it never opens a marker, never follows a symlink and never touches a FIFO. A parent that cannot be
 * read (gone, denied) counts as "no marker", which errs on the visible side.
 *
 * No electron import (`src/common/` may be loaded by the index process).
 */
import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  classify,
  classifyAccess,
  classifyReference,
  hasProjectMarker,
  isProjectDirName,
  type ExclusionRules,
  type ExclusionVerdict,
  type PathAccess
} from './exclusions.js'

/** Whether the directory `dir` holds a project marker. One `readdir`, names only. */
export function dirHasProjectMarker(dir: string, rules: ExclusionRules): boolean {
  try {
    return hasProjectMarker(readdirSync(dir), rules)
  } catch {
    return false
  }
}

/** The parent's marker answer, looked up only when the entry can depend on it (a directory with one of the four names). */
function parentMarkerFor(
  absolutePath: string,
  name: string,
  isDirectory: boolean,
  rules: ExclusionRules
): boolean {
  if (!isDirectory || !isProjectDirName(name, rules)) return false
  const parent = dirname(absolutePath)
  if (parent === absolutePath) return false
  return dirHasProjectMarker(parent, rules)
}

/** `classify` with the parent looked up on disk when needed. */
export function classifyOnDisk(
  absolutePath: string,
  name: string,
  isDirectory: boolean,
  rules: ExclusionRules
): ExclusionVerdict {
  return classify(absolutePath, name, isDirectory, rules, parentMarkerFor(absolutePath, name, isDirectory, rules))
}

/** `classifyAccess` with the parent looked up on disk when needed. */
export function classifyAccessOnDisk(
  absolutePath: string,
  name: string,
  isDirectory: boolean,
  rules: ExclusionRules,
  access: PathAccess
): ExclusionVerdict {
  return classifyAccess(
    absolutePath,
    name,
    isDirectory,
    rules,
    access,
    parentMarkerFor(absolutePath, name, isDirectory, rules)
  )
}

/** `classifyReference` with the parent looked up on disk when needed. */
export function classifyReferenceOnDisk(
  absolutePath: string,
  name: string,
  isDirectory: boolean,
  rules: ExclusionRules
): ExclusionVerdict {
  return classifyReference(absolutePath, name, isDirectory, rules, parentMarkerFor(absolutePath, name, isDirectory, rules))
}
