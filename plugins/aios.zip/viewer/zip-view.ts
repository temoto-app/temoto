/**
 * The wording and ordering of the `aios.zip` list (TODO 905). Pure functions independent of the DOM — tests look at them directly.
 */
import { vt } from '@pluginshared/i18n.js'
import { MAX_OPEN_ENTRY_BYTES, ZipError, type ZipEntry, type ZipErrorReason, type ZipListing } from './zip.js'

/** The byte count with one decimal place (B / KB / MB / GB). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

/** `YYYY-MM-DD HH:MM` (local time). */
export function formatModified(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** In name order (digits compared as numbers). The contents of a folder come right after the folder. */
export function sortedEntries(entries: readonly ZipEntry[]): ZipEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

export function summaryText(listing: ZipListing): string {
  let files = 0
  let folders = 0
  let size = 0
  for (const entry of listing.entries) {
    if (entry.directory) folders++
    else {
      files++
      size += entry.uncompressedSize
    }
  }
  return vt('zipSummary', { files, folders, size: formatSize(size) })
}

/** The wording of a failure reason. Reasons that are not from the zip reader (such as a network failure) stay as the string. */
export function reasonText(err: unknown): string {
  if (err instanceof ZipError) return reasonOf(err.reason)
  return err instanceof Error && err.message !== '' ? err.message : String(err)
}

function reasonOf(reason: ZipErrorReason): string {
  switch (reason) {
    case 'not-zip':
      return vt('notZip')
    case 'corrupt':
      return vt('zipReasonCorrupt')
    case 'spanned':
      return vt('zipReasonSpanned')
    case 'encrypted':
      return vt('zipReasonEncrypted')
    case 'wrong-password':
      return vt('zipReasonWrongPassword')
    case 'unsupported-encryption':
      return vt('zipReasonUnsupportedEncryption')
    case 'unsupported-method':
      return vt('zipReasonUnsupportedMethod')
    case 'too-large':
      return vt('zipReasonTooLarge', { limit: MAX_OPEN_ENTRY_BYTES / 1024 / 1024 })
    case 'suspicious-ratio':
      return vt('zipReasonSuspiciousRatio')
    case 'directory':
      return vt('zipReasonDirectory')
  }
}

/** Replace control characters in a name with visible marks (display only. The name itself is not changed). */
export function displayName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, '�')
}
