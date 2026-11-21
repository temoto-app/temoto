/**
 * Built-in slash commands and the work-list tool (items 117 / 118, ARCHITECTURE.md 4.5.3.1 / 4.6.5).
 *
 * **Command names, tool names and argument keys are placed only in `compat/claude-code.json`, and this file reads them**
 * (constraint 6). What reaches the renderer and `shared/` is only "the list of usable command names" (the backend's report,
 * corrected, in the same shape as item 68) and the neutral work list (`TodoItem[]`).
 */
import type { TodoItem, TodoStatus } from '@shared/agent.js'
import type { CompatTable } from './compat.js'

/** Upper bound on the number of work-list rows. Keeps IPC and storage from ballooning even if the model writes an abnormally long list. */
export const MAX_TODO_ITEMS = 100
/** Upper bound on the text of one work-list row. */
export const MAX_TODO_TEXT_CHARS = 300

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Turns the command list the backend reported into "what actually works over stream-json" (item 117).
 * Adds the ones that work though they are not in the list (`alwaysAvailable`), and
 * drops the ones that are listed but do not work (`unavailable`). The order of the report is kept, and added ones go at the end. **null (= unknown) stays null** - adding to
 * an unknown list would mean "only the added names are usable", and the Composer would block everything else.
 */
export function adjustCommands(
  table: CompatTable,
  reported: readonly string[] | null
): readonly string[] | null {
  if (reported === null) return null
  const builtins = table.builtinCommands
  if (builtins === undefined) return reported
  const unavailable = new Set(builtins.unavailable)
  const out = reported.filter((name) => !unavailable.has(name))
  for (const name of builtins.alwaysAvailable) {
    if (!unavailable.has(name) && !out.includes(name)) out.push(name)
  }
  return out
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= MAX_TODO_TEXT_CHARS ? flat : `${flat.slice(0, MAX_TODO_TEXT_CHARS)}…`
}

const TODO_STATUSES: ReadonlySet<string> = new Set<TodoStatus>(['pending', 'in_progress', 'completed'])

/**
 * If the call is to a tool that rewrites the work list, returns the list after rewriting in a neutral shape (item 118).
 * null for a tool not in the table or arguments of the wrong shape (= not a work list). An empty list is an empty array (= a signal that everything is
 * done and the pinned display should go away). Rows with no text are dropped, and unknown statuses are mapped to `pending`.
 */
export function todoItemsFromInput(
  table: CompatTable,
  toolName: string,
  input: unknown
): readonly TodoItem[] | null {
  const entry = table.todoTools?.map[toolName]
  if (entry === undefined || !isRecord(input)) return null
  const list = input[entry.listKey]
  if (!Array.isArray(list)) return null
  const items: TodoItem[] = []
  for (const raw of list) {
    if (items.length >= MAX_TODO_ITEMS) break
    if (!isRecord(raw)) continue
    const content = raw[entry.contentKey]
    if (typeof content !== 'string' || content.trim() === '') continue
    const active = raw[entry.activeFormKey]
    const reported = raw[entry.statusKey]
    const mapped = typeof reported === 'string' ? entry.statuses[reported] : undefined
    const status: TodoStatus =
      mapped !== undefined && TODO_STATUSES.has(mapped) ? (mapped as TodoStatus) : 'pending'
    items.push({
      content: clip(content),
      activeForm: typeof active === 'string' && active.trim() !== '' ? clip(active) : null,
      status
    })
  }
  return items
}
