/**
 * Re-checking the input of scheduled runs (TODO 323). Called from the IPC (`ipc.ts`). Independent of electron (called directly from tests).
 */
import {
  LATER_MAX_ATTACHMENTS,
  LATER_MAX_TEXT,
  MIN_SCHEDULE_INTERVAL_MINUTES,
  type LaterAttachment,
  type LaterInput,
  validateScheduledJobInput,
  type ScheduledJobInput
} from '@shared/schedule.js'
import { reasonError } from '@shared/reason.js'
import { isThinkingLevel } from '@shared/agent.js'

/** Upper limit on the number of characters of the reduced version (data URL). */
const LATER_MAX_THUMBNAIL = 200_000

/**
 * Check input from the renderer. If bad, throw a reason code. The working folder goes through `assertDirectory`
 * (`FsAccess.assertAllowed(uri, true)`) - it must be a directory and not hit an exclusion.
 */
export function checkJobInput(
  value: unknown,
  assertDirectory: (uri: string) => void,
  now: number = Date.now()
): ScheduledJobInput {
  const result = validateScheduledJobInput(value, now)
  if (typeof result === 'string') {
    if (result === 'schedule-too-frequent') {
      throw reasonError(result, { minutes: MIN_SCHEDULE_INTERVAL_MINUTES })
    }
    if (result === 'invalid-value') throw reasonError(result, { field: 'schedule' })
    throw reasonError(result)
  }
  if (result.action.kind === 'prompt' && result.action.cwdUri !== null) assertDirectory(result.action.cwdUri)
  return result
}

/** The id of a job that came over IPC. */
export function asId(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > 200) {
    throw reasonError('invalid-value', { field: 'id' })
  }
  return value
}

/** TODO 989: check one attachment (shape only. The contents of a `file:` and the permission are re-checked by main at send time). */
function checkLaterAttachment(value: unknown): LaterAttachment {
  if (typeof value !== 'object' || value === null) throw reasonError('invalid-value', { field: 'attachments' })
  const v = value as Record<string, unknown>
  const { uri, name, kind, mediaType, bytes, base64 } = v
  if (typeof uri !== 'string' || uri === '' || typeof name !== 'string') {
    throw reasonError('invalid-value', { field: 'attachments' })
  }
  if (kind !== 'image' && kind !== 'reference') throw reasonError('invalid-value', { field: 'attachments' })
  if (mediaType !== null && typeof mediaType !== 'string') throw reasonError('invalid-value', { field: 'attachments' })
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) throw reasonError('invalid-value', { field: 'attachments' })
  if (base64 !== undefined && typeof base64 !== 'string') throw reasonError('invalid-value', { field: 'attachments' })
  const thumbnail = v['thumbnail']
  // The reduced version is a data URL of around 40 KB. The shape check is done again at send time by `sentAttachmentsOf`.
  if (thumbnail !== undefined && (typeof thumbnail !== 'string' || thumbnail.length > LATER_MAX_THUMBNAIL)) {
    throw reasonError('invalid-value', { field: 'attachments' })
  }
  return {
    uri,
    name,
    kind,
    mediaType,
    bytes,
    ...(base64 === undefined ? {} : { base64 }),
    ...(thumbnail === undefined ? {} : { thumbnail })
  }
}

/** TODO 989: check the arguments of "send later" that came over IPC. */
export function checkLaterInput(threadId: unknown, input: unknown): { threadId: string; input: LaterInput } {
  if (typeof threadId !== 'string' || threadId === '') throw reasonError('invalid-value', { field: 'threadId' })
  if (typeof input !== 'object' || input === null) throw reasonError('invalid-value', { field: 'input' })
  const v = input as Record<string, unknown>
  const { text, attachments, at } = v
  if (typeof text !== 'string' || text.length > LATER_MAX_TEXT) throw reasonError('invalid-value', { field: 'text' })
  if (!Array.isArray(attachments) || attachments.length > LATER_MAX_ATTACHMENTS) {
    throw reasonError('invalid-value', { field: 'attachments' })
  }
  const checked = attachments.map(checkLaterAttachment)
  if (text.trim() === '' && checked.length === 0) throw reasonError('invalid-value', { field: 'text' })
  if (typeof at !== 'number' || !Number.isFinite(at)) throw reasonError('invalid-value', { field: 'at' })
  const modelId = v['modelId']
  const thinking = v['thinking']
  const scope = v['settingsScope']
  return {
    threadId,
    input: {
      text,
      attachments: checked,
      at,
      ...(typeof modelId === 'string' || modelId === null ? { modelId } : {}),
      ...(isThinkingLevel(thinking) || thinking === null ? { thinking } : {}),
      ...(scope === 'thread' || scope === 'message' ? { settingsScope: scope } : {})
    }
  }
}
