/**
 * Converts the response of the context usage breakdown (item 155, spike 26) to a neutral shape. A pure function;
 * `test/context-breakdown.test.ts` regression-tests it against the real thing (`test/fixtures/context-usage-response.json`).
 *
 * - Category classification trusts the response's `kind` (the backend's schema says
 *   "classify by kind, not by name"). An old response without `kind` is split by name (`freeCategory` / `bufferCategories`) and `isDeferred`.
 * - The backend's `color` (a terminal color name) is not used; compat's `tones` maps to aios's color roles.
 * - Unreadable fields are dropped (not turned into 0 or empty). If the total and the window size cannot be read, the whole response is null.
 * - Other fields of the response (`gridRows` / `mcpTools` / `skills` / `messageBreakdown` / `apiUsage` ...) are not used.
 */
import { CONTEXT_TONES, type ContextCategoryKind, type ContextTone } from '@shared/context-breakdown.js'
import type { AgentContextUsage } from '../types.js'
import type { ContextUsageVocabulary } from './compat.js'

const KINDS: readonly ContextCategoryKind[] = ['used', 'free', 'buffer', 'deferred']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function kindOf(row: Record<string, unknown>, name: string, vocab: ContextUsageVocabulary): ContextCategoryKind {
  const reported = row['kind']
  if (typeof reported === 'string' && (KINDS as readonly string[]).includes(reported)) {
    return reported as ContextCategoryKind
  }
  if (name === vocab.freeCategory) return 'free'
  if (vocab.bufferCategories.includes(name)) return 'buffer'
  if (row['isDeferred'] === true) return 'deferred'
  return 'used'
}

function toneOf(name: string, vocab: ContextUsageVocabulary): ContextTone {
  const tone = vocab.tones[name]
  return tone !== undefined && (CONTEXT_TONES as readonly string[]).includes(tone) ? (tone as ContextTone) : 'other'
}

export function readContextUsage(body: unknown, vocab: ContextUsageVocabulary): AgentContextUsage | null {
  if (!isRecord(body)) return null
  const totalTokens = count(body['totalTokens'])
  const maxTokens = count(body['maxTokens'])
  if (totalTokens === null || maxTokens === null || maxTokens === 0) return null
  const categories: AgentContextUsage['categories'][number][] = []
  for (const row of Array.isArray(body['categories']) ? body['categories'] : []) {
    if (!isRecord(row) || typeof row['name'] !== 'string') continue
    const tokens = count(row['tokens'])
    if (tokens === null) continue
    const name = row['name']
    const kind = kindOf(row, name, vocab)
    categories.push({ name, tokens, kind, tone: kind === 'used' ? toneOf(name, vocab) : null })
  }
  const memoryFiles: AgentContextUsage['memoryFiles'][number][] = []
  for (const file of Array.isArray(body['memoryFiles']) ? body['memoryFiles'] : []) {
    if (!isRecord(file) || typeof file['path'] !== 'string' || file['path'] === '') continue
    memoryFiles.push({
      path: file['path'],
      type: typeof file['type'] === 'string' ? file['type'] : '',
      tokens: count(file['tokens']) ?? 0
    })
  }
  const percentage = count(body['percentage'])
  const model = body['model']
  return {
    model: typeof model === 'string' && model !== '' ? model : null,
    totalTokens,
    maxTokens,
    percentage: percentage ?? Math.round((totalTokens / maxTokens) * 100),
    categories,
    memoryFiles
  }
}
