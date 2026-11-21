/**
 * How the pinned task-list display counts (item 118, ARCHITECTURE.md 4.6.5). Pure functions that touch neither the DOM nor the store,
 * checked directly by `test/todo-list.test.ts`.
 *
 * - The number in the heading is "done / total".
 * - The one line shown when collapsed is "the first in progress", or if none "the first not started", or nothing if everything is settled.
 * - An in-progress row shows the progressive sentence (`activeForm`). If none, the to-do sentence (`content`).
 * - Whether it was closed (the X) is remembered by "the rewrite id of the list when it was closed". When a new rewrite arrives, it is shown again.
 */
import type { TodoItem } from '@shared/agent.js'
import type { TodoList } from '@shared/thread.js'

export interface TodoCounts {
  readonly done: number
  readonly total: number
}

export function todoCounts(items: readonly TodoItem[]): TodoCounts {
  let done = 0
  for (const item of items) if (item.status === 'completed') done += 1
  return { done, total: items.length }
}

/** The "current line" attached to the collapsed heading. */
export function currentTodo(items: readonly TodoItem[]): TodoItem | null {
  return (
    items.find((item) => item.status === 'in_progress') ??
    items.find((item) => item.status === 'pending') ??
    null
  )
}

/** The sentence shown on a row. For in-progress, the progressive sentence is preferred. */
export function todoText(item: TodoItem): string {
  return item.status === 'in_progress' && item.activeForm !== null ? item.activeForm : item.content
}

/** Whether to show the pinned display. Not shown for an empty list, or a list with no rewrite since it was closed. */
export function shouldShowTodos(todos: TodoList | null, dismissedToolUseId: string | null): boolean {
  if (todos === null || todos.items.length === 0) return false
  return todos.toolUseId !== dismissedToolUseId
}
