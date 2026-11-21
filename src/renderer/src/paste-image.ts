/**
 * Dispatch of ⌘V in the prompt field (item 319, ARCHITECTURE.md 4.5). Only the decision, independent of the DOM.
 *
 * 1. A file that has a path (copied in Finder) -> the same attachment route as Drop (`attach`).
 * 2. There is text (`text/plain`) -> the default paste. **When both an image and text are present (Office, a Numbers
 *    cell, etc.) the text wins and the image is ignored** (like the VS Code editor and the CLI, it does not
 *    take over a text paste).
 * 3. An image without a path (a screenshot, the browser's "copy image") -> have main read it and attach it
 *    (`paste.image`). The renderer does not carry the bytes.
 * 4. Anything else -> the default paste.
 */

/** The parts of `DataTransfer` that are looked at here (tests pass a fake). */
export interface PasteData {
  readonly files: ArrayLike<unknown>
  readonly items?: ArrayLike<{ readonly kind: string; readonly type: string }>
  getData(format: string): string
}

export type PasteAction =
  | { readonly kind: 'attach'; readonly uris: readonly string[] }
  | { readonly kind: 'image' }
  | { readonly kind: 'default' }

export function pasteAction(data: PasteData, uriFor: (file: unknown) => string): PasteAction {
  const uris: string[] = []
  for (const file of Array.from(data.files)) {
    const uri = uriFor(file)
    if (uri !== '' && !uris.includes(uri)) uris.push(uri)
  }
  if (uris.length > 0) return { kind: 'attach', uris }

  if (data.getData('text/plain') !== '') return { kind: 'default' }

  const isImageFile = (file: unknown): boolean =>
    typeof file === 'object' &&
    file !== null &&
    typeof (file as { type?: unknown }).type === 'string' &&
    (file as { type: string }).type.startsWith('image/')
  const hasImage =
    Array.from(data.files).some(isImageFile) ||
    Array.from(data.items ?? []).some((item) => item.kind === 'file' && item.type.startsWith('image/'))
  return hasImage ? { kind: 'image' } : { kind: 'default' }
}
