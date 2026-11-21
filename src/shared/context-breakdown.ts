/**
 * Breakdown of context usage (item 155 / ARCHITECTURE.md 4.5.1 "breakdown dialog").
 *
 * Material for the dialog shown when the donut (item 60, `ContextUsage`) is pressed. It is the result of asking the backend for "the number of tokens per
 * category of the current context", put into a neutral form. The category names keep the backend's
 * names (English) as they are, and the color is decided by `tone` (aios's color role); the color names the backend returns are
 * not used (7.4.1: colors only in CSS variables).
 */

/**
 * The color role of a category. Corresponds to the `--ctx-<tone>` CSS variables. The order is the fixed categorical order
 * (the order that passed the dataviz check, so that adjacent categories can be told apart), aligned with the backend's category order.
 */
export const CONTEXT_TONES = ['system', 'tools', 'mcp', 'agents', 'memory', 'skills', 'messages', 'other'] as const
export type ContextTone = (typeof CONTEXT_TONES)[number]

/**
 * The kind of category. `used` = occupies the window, `free` = remaining, `buffer` = reserved for auto-compaction,
 * `deferred` = outside the window (lazily loaded tool definitions. Only informational; not in the total).
 */
export type ContextCategoryKind = 'used' | 'free' | 'buffer' | 'deferred'

export interface ContextCategory {
  /** The backend's category name (shown in English as is, the same policy as item 153). */
  readonly name: string
  readonly tokens: number
  readonly kind: ContextCategoryKind
  /** Only `used` rows have it. `free` / `buffer` / `deferred` are null (a neutral color). */
  readonly tone: ContextTone | null
}

export interface ContextMemoryFile {
  /** A `file://` URI (the renderer folds it to `~` with `displayPath`). */
  readonly uri: string
  /** The backend's kind (`Project` / `User` / `Local` ...). Shown in English as is. */
  readonly type: string
  readonly tokens: number
  /**
   * Whether it can be opened in the viewer. A path that hits the exclusion rules (4.4.2) (such as under the place where the backend keeps its settings, constraint 2) is false, and
   * the renderer makes it look unclickable.
   */
  readonly openable: boolean
}

export interface ContextBreakdown {
  /** The full name of the model the backend reported. Null if none. */
  readonly model: string | null
  /** The number of tokens currently occupying the window (the usage of the last API call; an estimate before a response). */
  readonly totalTokens: number
  /** The size of the window. */
  readonly maxTokens: number
  /** The usage rate (integer %, the backend's value). */
  readonly percentage: number
  /** In the backend's order as is. */
  readonly categories: readonly ContextCategory[]
  readonly memoryFiles: readonly ContextMemoryFile[]
  /** The time it was taken (epoch ms). Added to say "when this breakdown is from" when there is no process. */
  readonly at: number
}

export interface ContextBreakdownResult {
  /** Null if it has never been obtained (the renderer shows only the same total as the donut). */
  readonly breakdown: ContextBreakdown | null
  /**
   * If true, it was just taken from the currently running process. If false, it is the last breakdown main remembered
   * (no process, or the query failed), shown with `at` added.
   */
  readonly fresh: boolean
}
