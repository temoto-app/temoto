/**
 * Re-reads the arguments of OpenCode's write tools into a neutral shape (TODO 1020, the approval frame diff and draft conflicts of item 97).
 *
 * The tool name is the one after mapping with the `permission.actions` of `compat/opencode.json` (`Edit` / `Write`). OpenCode 2.1 asks edit /
 * write / apply_patch all with action `edit`, so **the shape is decided by the argument keys, not the tool name** (the table's `writes`).
 * Only pure functions that do not read files (building the before and after is main's `approval/write-diff.ts`).
 */
import type { WriteChange, WritePreview } from '../types.js'
import type { OpenCodeTable } from './compat.js'

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstPath(table: OpenCodeTable, input: Rec): string | null {
  for (const key of table.writes.pathKeys) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/** Built only once per table (TODO 1020 review). */
const patchPatterns = new WeakMap<OpenCodeTable, RegExp>()

/** The first target path in the patch body (`*** Update File: a.ts`). */
function patchTarget(table: OpenCodeTable, patch: string): string | null {
  let pattern = patchPatterns.get(table)
  if (pattern === undefined) {
    pattern = new RegExp(table.writes.patchFilePattern, 'm')
    patchPatterns.set(table, pattern)
  }
  const match = pattern.exec(patch)
  const path = match?.[1]?.trim() ?? ''
  return path === '' ? null : path
}

/** The target path of a write tool (a relative path is returned as is). null for a read-only tool, a tool not in the table, or unreadable arguments. */
export function writeTargetOf(table: OpenCodeTable, toolName: string, input: unknown): string | null {
  if (!table.writes.tools.includes(toolName) || !isRecord(input)) return null
  const path = firstPath(table, input)
  if (path !== null) return path
  const patch = input[table.writes.patch]
  return typeof patch === 'string' ? patchTarget(table, patch) : null
}

function changeOf(table: OpenCodeTable, input: Rec): WriteChange | null {
  const { replace, overwrite } = table.writes
  const oldText = input[replace.old]
  const newText = input[replace.new]
  if (typeof oldText === 'string' && typeof newText === 'string') {
    return { kind: 'replace', edits: [{ oldText, newText, replaceAll: input[replace.all] === true }] }
  }
  const content = input[overwrite]
  return typeof content === 'string' ? { kind: 'overwrite', content } : null
}

/**
 * The material for the approval frame's diff. Only when the path and the contents could be read. A patch (`apply_patch`) cannot have its before and after built, so null
 * (the frame shows only the summary and "content").
 */
export function writePreviewOf(table: OpenCodeTable, toolName: string, input: unknown): WritePreview | null {
  if (!table.writes.tools.includes(toolName) || !isRecord(input)) return null
  const path = firstPath(table, input)
  if (path === null) return null
  const change = changeOf(table, input)
  return change === null ? null : { path, change }
}
