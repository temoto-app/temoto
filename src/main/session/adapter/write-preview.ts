/**
 * Re-reads a tool's arguments into a neutral shape, for the approval frame's diff (item 97, ARCHITECTURE.md 7.6.4) and Plan's plan (item 112, 4.2.3).
 *
 * **Tool names and argument keys are backend-specific** (constraint 6), so only this file and `compat/` read them.
 * Which tool has which shape (`toolKinds.map[*].preview`) and the plan tool and its fields (`planMode`) are held by the table,
 * and the argument keys (such as `old_string`) are held by this file. Applying them to the file's current contents to build before and after is done in
 * main (`approval/write-diff.ts`); this is pure functions that do not read files.
 */
import type { WriteChange, WritePreview } from '../types.js'
import type { CompatTable } from './compat.js'
import { PATH_KEYS, firstString } from './progress.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A string field. An empty string is also accepted as a value (there are replacements with empty and empty files). */
function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' ? value : null
}

/** One `Edit` (or one element of the form that holds several replacements). */
function replaceEdit(
  input: Record<string, unknown>
): { oldText: string; newText: string; replaceAll: boolean } | null {
  const oldText = stringField(input, 'old_string')
  const newText = stringField(input, 'new_string')
  if (oldText === null || newText === null) return null
  return { oldText, newText, replaceAll: input['replace_all'] === true }
}

function changeOf(kind: 'edit' | 'write' | 'notebook', input: Record<string, unknown>): WriteChange | null {
  if (kind === 'write') {
    const content = stringField(input, 'content')
    return content === null ? null : { kind: 'overwrite', content }
  }
  if (kind === 'edit') {
    // The old multi-replacement form (`edits: [{old_string, new_string, replace_all}]`) is read in the same shape.
    const list = input['edits']
    if (Array.isArray(list)) {
      const edits = []
      for (const entry of list) {
        if (!isRecord(entry)) return null
        const edit = replaceEdit(entry)
        if (edit === null) return null
        edits.push(edit)
      }
      return edits.length === 0 ? null : { kind: 'replace', edits }
    }
    const edit = replaceEdit(input)
    return edit === null ? null : { kind: 'replace', edits: [edit] }
  }
  const rawMode = input['edit_mode']
  const mode = rawMode === 'insert' || rawMode === 'delete' ? rawMode : 'replace'
  const newSource = stringField(input, 'new_source') ?? ''
  if (mode !== 'delete' && stringField(input, 'new_source') === null) return null
  const cellId = stringField(input, 'cell_id')
  return { kind: 'notebookCell', cellId: cellId === '' ? null : cellId, newSource, mode }
}

/**
 * The change contents of a write-type tool call (item 97, the approval frame's diff). Only for a tool with the table's `preview`, and only when the
 * path and contents can be read. A relative path is returned as is (making it absolute is for the caller, which knows the cwd).
 */
export function writePreviewOf(table: CompatTable, toolName: string, input: unknown): WritePreview | null {
  const kind = table.toolKinds.map[toolName]?.preview
  if (kind === undefined || !isRecord(input)) return null
  const path = firstString(input, PATH_KEYS)
  if (path === null) return null
  const change = changeOf(kind, input)
  return change === null ? null : { path, change }
}

/**
 * If this is a tool call that enters or leaves plan mode, its direction and the plan file's path (item 275).
 * `exit` is the presentation of a plan (`exitTool`) and `enter` is `enterTool`. Null if not in the table or another tool.
 */
export function planTransitionOf(
  table: CompatTable,
  toolName: string,
  input: unknown
): { readonly transition: 'enter' | 'exit'; readonly planFile: string | null } | null {
  const plan = table.planMode
  if (plan === undefined) return null
  if (plan.enterTool !== undefined && toolName === plan.enterTool) return { transition: 'enter', planFile: null }
  if (toolName !== plan.exitTool) return null
  const field = plan.planFileField
  const file = field !== undefined && isRecord(input) ? stringField(input, field) : null
  return { transition: 'exit', planFile: file === null || file.trim() === '' || file.length > 2000 ? null : file }
}

/**
 * If this approval request is the presentation of a plan, the plan body (item 112). If it is the presenting tool but the field cannot be read, an empty string
 * (leaning toward stopping). Null if the table has no `planMode` or it is another tool.
 */
export function planProposalOf(table: CompatTable, toolName: string, input: unknown): string | null {
  const plan = table.planMode
  if (plan === undefined || toolName !== plan.exitTool) return null
  if (!isRecord(input)) return ''
  return stringField(input, plan.planField) ?? ''
}
