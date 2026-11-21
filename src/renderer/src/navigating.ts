/**
 * The marker for "a move opened by back / forward" (TODO 801). **Shared** by the viewer's history (`viewerHistory.ts`, TODO 369) and the global history
 * (`navHistory.ts`): when the global back / forward changes the conversation and opens a file, it could be pushed twice into both.
 * Both `select` and the store's `subscribe` listeners are synchronous, so raising and lowering it around the call is enough. It counts, so nesting does not break it.
 */
let depth = 0

export function isNavigating(): boolean {
  return depth > 0
}

export function withNavigating<T>(run: () => T): T {
  depth += 1
  try {
    return run()
  } finally {
    depth -= 1
  }
}
