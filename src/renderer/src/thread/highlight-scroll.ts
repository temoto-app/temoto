/**
 * The decision to scroll to the destination of in-conversation search (`highlightEventId`) (TODO 940).
 * Once scrolled, it does not move again while the same highlight lasts. This keeps a running thread from pulling back to the
 * message every time an item is added. While it is not in the DOM yet (waiting for the previous page to load) the caller searches again.
 */
export function shouldScrollToHighlight(scrolledId: string | null, highlightId: string | null): boolean {
  return highlightId !== null && scrolledId !== highlightId
}
