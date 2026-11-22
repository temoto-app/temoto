/**
 * Which notes the local-model panel shows about the context length and the derived models of the retired button (review fix, wave 100).
 * Pure so a test can pin the combinations: the removal advice must never appear while the derived models are the only thing that sets the context length.
 */
import type { LocalModelAdvice } from '@shared/local-models.js'
import type { MessageKey } from './ja.js'

export interface AdviceNote {
  readonly key: MessageKey
  readonly params: Readonly<Record<string, string>>
}

/** Why the context length is not sent per request (null when it is). */
export function contextNoteOf(advice: Pick<LocalModelAdvice, 'contextBlocker' | 'defaultContext'>, context: string): AdviceNote | null {
  const blocker = advice.contextBlocker
  if (blocker === null) return null
  switch (blocker.kind) {
    case 'bundle-missing':
      return { key: 'localAdvice.contextUnavailable', params: { context } }
    case 'backend-old':
      return { key: 'localAdvice.contextBackendOld', params: { context, minVersion: blocker.minVersion } }
    case 'own-provider':
      return { key: 'localAdvice.contextOwnProvider', params: { context } }
  }
}

/** The note about derived models made by the retired button (null when there are none). Removal is only advised when the context length is sent per request. */
export function legacyNoteOf(advice: Pick<LocalModelAdvice, 'contextPerRequest' | 'legacyModels'>): AdviceNote | null {
  if (advice.legacyModels.length === 0) return null
  return { key: advice.contextPerRequest ? 'localAdvice.legacy' : 'localAdvice.legacyKept', params: { models: advice.legacyModels.join(', ') } }
}
