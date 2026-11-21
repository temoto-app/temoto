/**
 * Record of the context usage breakdown (item 155 / ARCHITECTURE.md 4.5.1, "breakdown dialog").
 *
 * Owner decision (2026-09-27): when there is no process (after an idle eviction), **main remembers the last
 * breakdown it obtained and shows it with the time it was taken**. No process is started just for the breakdown.
 * If none was ever obtained, null (the renderer shows only the total, same as the donut).
 *
 * - The record is in memory only (it does not survive an app restart). It is per thread and is not kept on `Live`
 *   (an eviction removes the whole `Live`).
 * - After a conversation boundary (`/clear` / compaction, item 117) the old breakdown is dropped (same handling as the donut).
 * - A memory file path becomes a URI, and one that hits the exclusion rules (4.4.2) (under the place that holds the
 *   backend's credentials, constraint 2) gets `openable: false`. The choke point is applied again when it is opened (the renderer is not trusted).
 */
import { isAbsolute } from 'node:path'
import type { ContextBreakdown } from '@shared/context-breakdown.js'
import { pathToUri } from '../../common/uri.js'
import type { AgentContextUsage } from './types.js'

export function toContextBreakdown(
  usage: AgentContextUsage,
  at: number,
  openable: (uri: string) => boolean
): ContextBreakdown {
  return {
    model: usage.model,
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    percentage: usage.percentage,
    categories: usage.categories.map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind, tone: c.tone })),
    memoryFiles: usage.memoryFiles
      .filter((file) => isAbsolute(file.path))
      .map((file) => {
        const uri = pathToUri(file.path)
        return { uri, type: file.type, tokens: file.tokens, openable: openable(uri) }
      }),
    at
  }
}

/** The "last obtained breakdown" per thread. */
export class ContextBreakdownCache {
  private readonly last = new Map<string, ContextBreakdown>()

  constructor(private readonly openable: (uri: string) => boolean) {}

  record(threadId: string, usage: AgentContextUsage, at: number): ContextBreakdown {
    const breakdown = toContextBreakdown(usage, at, this.openable)
    this.last.set(threadId, breakdown)
    return breakdown
  }

  get(threadId: string): ContextBreakdown | null {
    return this.last.get(threadId) ?? null
  }

  forget(threadId: string): void {
    this.last.delete(threadId)
  }
}
