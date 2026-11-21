/**
 * TODO 995: a small popover next to a link that could not be resolved (disappears in a few seconds). Positioned at the lower left of the link that was pressed.
 * It is added to the band (`LinkNotice`), not a replacement for it. It does not steal clicks (`pointer-events: none`).
 */
import { useEffect } from 'react'
import { useT } from '../i18n/index.js'
import { useLinkPopover } from '../linkNoticeStore.js'

export function LinkPopover(): React.JSX.Element | null {
  const t = useT()
  const popover = useLinkPopover((state) => state.popover)
  const clear = useLinkPopover((state) => state.clear)

  useEffect(() => {
    if (popover === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      // The Esc that closed the popover is not passed on to other Esc handling (aborting a turn, denying an approval).
      event.preventDefault()
      event.stopPropagation()
      clear()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [popover, clear])

  if (popover === null) return null
  // Shift it so it does not overflow at the window edge (a short sentence within 200px wide).
  const left = Math.max(8, Math.min(popover.x, window.innerWidth - 208))
  const top = Math.min(popover.y + 6, window.innerHeight - 40)
  return (
    <div className="link-popover" role="status" style={{ left, top }}>
      {t(popover.kind === 'notFound' ? 'linkPopover.notFound' : 'linkPopover.denied')}
    </div>
  )
}
