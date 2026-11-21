/**
 * The rotating spinner (ARCHITECTURE.md 5.1.3 / TODO 14, TODO 45).
 *
 * Two circles: a thin ring and an arc rotating over it. The rotation is CSS (`@keyframes progress-spin`,
 * the period is in one place, `--spin-period` of `.progress-spinner`). SMIL is not used.
 * The shape is `aria-hidden`, and the meaning is carried by the parent (`role="status"` etc.).
 *
 * **What rotates is the outer `<span>`, not the svg (2026-10-25).** Blink handles the transform of the svg's child (circle) in
 * layout, and the svg root's transform too is committed on the main thread every frame, and neither
 * goes onto the compositor. This was the cause of the renderer constantly eating 30% CPU in a running aios.
 * Only the transform of an ordinary element (span) becomes a compositor animation. The measurement is in the comment of `.progress-spinner`
 * in `styles.css`.
 *
 * Used by both the intermediate report (ProgressBlock) and the sidebar thread rows (ThreadList).
 * Positioning is overridden by the caller's `className` (the default is the absolute placement for intermediate reports).
 */
export function Spinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={className === undefined ? 'progress-spinner' : `progress-spinner ${className}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 16 16" width="12" height="12">
        <circle className="track" cx="8" cy="8" r="6" fill="none" strokeWidth="2" />
        <circle
          className="head"
          cx="8"
          cy="8"
          r="6"
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}
