/**
 * Validation of the renderer's report that a part of the workspace copy failed (TODO 1337 (11)). The renderer is not a trust
 * boundary for log content: only a thread id and kind names from a fixed set are accepted, so no value or path reaches the log.
 */
export const WORKSPACE_COPY_KINDS: readonly string[] = ['viewerMemory', 'viewerHistory', 'filerHistory', 'dismissedSelection']

export interface WorkspaceCopyFailureLine {
  readonly threadId: string
  readonly kinds: readonly string[]
}

const THREAD_ID = /^[A-Za-z0-9_-]{1,64}$/

export function sanitizeWorkspaceCopyFailure(threadId: unknown, kinds: unknown): WorkspaceCopyFailureLine | null {
  if (typeof threadId !== 'string' || !THREAD_ID.test(threadId) || !Array.isArray(kinds)) return null
  const known = kinds.filter((kind): kind is string => typeof kind === 'string' && WORKSPACE_COPY_KINDS.includes(kind))
  if (known.length === 0) return null
  return { threadId, kinds: [...new Set(known)] }
}
