/**
 * The small menu shown when the export icon (TODO 864 / 865) is pressed (TODO 866, owner decision 2026-10-18):
 * the entries to save as PDF, as HTML, and as Markdown (TODO 1014). Shared by the heading's upper right (the whole conversation) and the hover on one's own message (one question and answer).
 * It closes when pressed, and main asks for the destination with a dialog every time.
 */
import { useT } from '../i18n/index.js'
import { exportThread, useExportState, type ExportTarget } from '../export-pdf.js'
import { ExportIcon } from '../icons/ExportIcon.js'
import { MenuPopover } from './MenuPopover.js'

export function ExportMenu({
  threadId,
  target,
  className,
  buttonClassName,
  iconSize = 16
}: {
  threadId: string
  target: ExportTarget
  /** The placement class (added to `menu-anchor`). */
  className: string
  buttonClassName?: string
  iconSize?: number
}): React.JSX.Element {
  const t = useT()
  const state = useExportState(threadId, target)
  const label = t(target.kind === 'all' ? 'export.thread' : 'export.turn')
  return (
    <MenuPopover
      label={label}
      icon={<ExportIcon size={iconSize} />}
      className={`export-menu ${className}`}
      {...(buttonClassName === undefined ? {} : { buttonClassName })}
      role="menu"
      busy={state === 'busy'}
      disabled={state !== 'idle'}
      align="right"
    >
      {(close) => (
        <>
          <button
            type="button"
            role="menuitem"
            className="export-menu-pdf"
            onClick={() => {
              close()
              void exportThread(threadId, target, 'pdf')
            }}
          >
            {t('export.pdf')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="export-menu-html"
            onClick={() => {
              close()
              void exportThread(threadId, target, 'html')
            }}
          >
            {t('export.html')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="export-menu-md"
            onClick={() => {
              close()
              void exportThread(threadId, target, 'md')
            }}
          >
            {t('export.md')}
          </button>
        </>
      )}
    </MenuPopover>
  )
}
