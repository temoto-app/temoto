/**
 * Pinned display of the parent model's task list (item 118, ARCHITECTURE.md 4.6.5).
 *
 * - Shown at the end of ThreadPane, just above the sub-agent list and the approval frame. Completed / in progress / not started
 *   are told apart by mark and text appearance. In progress uses the progressive form.
 * - **Collapsible** (press the heading) and **closable** (x). Even if closed, when the model rewrites the list
 *   (a new rewrite id) it appears again. Both are remembered per thread (within the window only, not saved).
 * - **Re-rendering is confined to this component** (item 88). It selects only `runtime.todos`, and when the contents are the same
 *   thread-index.ts reuses the same object, so it is not redrawn on every `turn_usage`.
 * - The value is main's record (`ThreadRuntime.todos`), not built from the timeline's event list -
 *   so a list that exists only in a page before "load more" shows up, and the same one shows after a restart.
 */
import { useState } from 'react'
import type { TodoList as TodoListValue } from '@shared/thread.js'
import { useThreads } from '../threadStore.js'
import { useT } from '../i18n/index.js'
import { currentTodo, shouldShowTodos, todoCounts, todoText } from '../thread/todos.js'

interface ViewState {
  readonly collapsed: boolean
  /** The list-rewrite id at the time it was closed. */
  readonly dismissed: string | null
}

const INITIAL: ViewState = { collapsed: false, dismissed: null }

/** Memory of collapsed / closed per thread (within this window only). Kept when switching between threads. */
const remembered = new Map<string, ViewState>()

const MARKS = { completed: '✓', in_progress: '●', pending: '○' } as const

export function TodoList({ threadId }: { threadId: string }): React.JSX.Element | null {
  const t = useT()
  const todos = useThreads(
    (state): TodoListValue | null => state.threadsById[threadId]?.runtime.todos ?? null
  )
  const [, setTick] = useState(0)
  const view = remembered.get(threadId) ?? INITIAL
  const update = (next: ViewState): void => {
    remembered.set(threadId, next)
    setTick((n) => n + 1)
  }

  if (todos === null || !shouldShowTodos(todos, view.dismissed)) return null
  const { done, total } = todoCounts(todos.items)
  const current = currentTodo(todos.items)
  return (
    <div className="todo-list" aria-label={t('todos.label')}>
      <div className="todo-header">
        <button
          type="button"
          className="todo-toggle"
          aria-expanded={!view.collapsed}
          title={view.collapsed ? t('todos.expand') : t('todos.collapse')}
          onClick={() => update({ ...view, collapsed: !view.collapsed })}
        >
          <span className="todo-caret" aria-hidden="true">
            {view.collapsed ? '▸' : '▾'}
          </span>
          {t('todos.heading', { done, total })}
        </button>
        {view.collapsed && current !== null ? (
          <span className={`todo-current todo-${current.status}`} title={todoText(current)}>
            {todoText(current)}
          </span>
        ) : (
          <span className="todo-spacer" />
        )}
        <button
          type="button"
          className="todo-close"
          title={t('todos.close')}
          aria-label={t('todos.close')}
          onClick={() => update({ ...view, dismissed: todos.toolUseId })}
        >
          ✕
        </button>
      </div>
      {view.collapsed ? null : (
        <ul>
          {todos.items.map((item, index) => (
            <li key={index} className={`todo-row todo-${item.status}`}>
              <span className="todo-mark" aria-label={t(`todos.status.${item.status}`)}>
                {MARKS[item.status]}
              </span>
              <span className="todo-text" title={todoText(item)}>
                {todoText(item)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
