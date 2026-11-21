/**
 * The window that originated a search query (TODO 497, ARCHITECTURE 6.1).
 *
 * The index process remembers the query number (P6) per (column, window) and discards a search with an old number without running it.
 * The renderer counts numbers from 1 per window, so the webContents id is used to tell windows apart (only main knows it; the renderer cannot forge it).
 *
 * When the books are dropped:
 * - `destroyed` - the window closed.
 * - `did-navigate` - the main frame reloaded (Cmd+R reload, reload after a crash). The id stays the same but only the renderer's
 *   number goes back to 1, so without dropping, the first few queries would lose to the previous numbers. It does not fire for in-page navigation (hash).
 *
 * It takes a form independent of electron (`OriginSender`) so tests can substitute it.
 */
export interface OriginSender {
  readonly id: number
  once(event: 'destroyed', listener: () => void): unknown
  on(event: 'did-navigate', listener: () => void): unknown
}

export class SearchOrigins {
  private readonly known = new Set<number>()

  constructor(private readonly forget: (origin: number) => void) {}

  /** The id of the originating window. For a window seen for the first time, arranges to drop the books when it closes / reloads. */
  of(sender: OriginSender): number {
    const id = sender.id
    if (!this.known.has(id)) {
      this.known.add(id)
      sender.once('destroyed', () => {
        this.known.delete(id)
        this.forget(id)
      })
      sender.on('did-navigate', () => this.forget(id))
    }
    return id
  }

  /** Number of windows already arranged (for tests). */
  size(): number {
    return this.known.size
  }
}
