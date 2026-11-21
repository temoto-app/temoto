/**
 * "New thread" (TODO 408). The same worldwide-standard "square with a pencil" (compose) as ChatGPT's New chat and
 * the new-message button of Apple Mail / Messages. Only the top right of a rounded square is cut away,
 * and a pencil is stuck diagonally into that gap (the pencil's tip is inside the square, the cap side peeks out).
 *
 * Both the create-with-dialog side (the top of the Activity Bar, removed from the `ThreadList.tsx` heading) and the
 * create-immediately side (`NewChatButton.tsx`, formerly `ChatBubbleIcon`) use this one icon
 * (item 408's default: the only difference is the tooltip text). Color is `currentColor` only (7.4.1).
 * The same 24px, viewBox 24, and 1.5 stroke width as the other Activity Bar icons (`ThreadsIcon` etc.).
 */
export function ComposeIcon(): React.JSX.Element {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/*
        TODO 954: the drawing looked smaller inside the 24 frame than the other Activity Bar icons (Files spans 5 to 19), so it was scaled
        1.25 times about the center (12, 12). The stroke width is divided by the scale to 1.2 (= 1.5 / 1.25) so it does not get thicker.
      */}
      <g transform="translate(12 12) scale(1.25) translate(-12 -12)" strokeWidth="1.2">
        {/* A rounded square. Only the top right corner is open, as the pencil's way through. */}
        <path d="M14 5H7a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7" />
        {/* The diagonal pencil: the tip (toward the lower left) is inside the square, the cap (upper right) peeks out from the cut corner. */}
        <path d="M19.7 8.7 18.3 7.3 10.7 14.9 10 17 12.1 16.3Z" />
      </g>
    </svg>
  )
}
