/**
 * Turn dropped things into a list of `file://` URIs (item 98).
 *
 * A `File` from Finder is turned into a URI by the preload's `drop.uriFor`, and for a
 * Drop from aios's file list the URI carried in `text/uri-list` is used as it is. **The renderer does not decide whether it is a folder**
 * (a `File` cannot be known until its contents are read): the decision, reparenting, and count checks are main's.
 *
 * **TODO 677**: if `remembered` is non-null, return it as it is without reading `DataTransfer`. This is so that a native drag originating from the Files
 * tree (`files-drag.ts`), when it comes back into aios, need not be distinguished from a real drop
 * from Finder (the caller passes `currentFilesDrag()`).
 * **Fix from code-review**: however, if a real `File` is on `data.files` and its name matches none of `remembered`
 * (= a new real Finder drop overlapped a stale memory that was never expired), `remembered` is not used and the real one is read
 * (`mismatchesRememberedFiles`).
 */
import { mismatchesRememberedFiles } from './files-drag.js'

export interface DroppedData {
  readonly files: ArrayLike<unknown>
  getData(format: string): string
}

export function droppedUris(
  data: DroppedData,
  uriFor: (file: unknown) => string,
  remembered: readonly string[] | null = null
): string[] {
  if (remembered !== null && !mismatchesRememberedFiles(data.files, remembered)) return [...remembered]
  const uris: string[] = []
  for (const file of Array.from(data.files)) {
    const uri = uriFor(file)
    if (uri !== '' && !uris.includes(uri)) uris.push(uri)
  }
  for (const line of data.getData('text/uri-list').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('file:') && !uris.includes(trimmed)) uris.push(trimmed)
  }
  return uris
}

/** Whether the dragged thing is a file (Finder) or a list of URIs. Text selections and the like are not accepted. */
export function carriesFiles(types: readonly string[]): boolean {
  return types.includes('Files') || types.includes('text/uri-list')
}

export { mismatchesRememberedFiles }
