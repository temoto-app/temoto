/**
 * Drag of a search result row (TODO 288). Passes the URI as `text/uri-list` to the prompt field and so on.
 * The receiving side is 258's `droppedUris` (`drop-uris.ts`); nothing changes from here.
 *
 * Only **fs file hits** are draggable. Conversation / transcript hits are not files, and
 * folders are not draggable, matching the tree rows (`draggable={!isDirectory}`).
 */
import type { SearchHit } from '@shared/search.js'

export function isDraggableHit(hit: Pick<SearchHit, 'source' | 'kind'>): boolean {
  return hit.source === 'fs' && hit.kind !== 'directory'
}

export interface DragStartLike {
  readonly dataTransfer: {
    setData(format: string, data: string): void
    effectAllowed: string
  } | null
}

export function startHitDrag(event: DragStartLike, uri: string): void {
  if (event.dataTransfer === null) return
  event.dataTransfer.setData('text/uri-list', uri)
  event.dataTransfer.effectAllowed = 'copy'
}
