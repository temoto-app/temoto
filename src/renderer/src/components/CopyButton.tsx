/**
 * The code copy button (T17, 5.1.2). Shared by the code frame in the body (`MarkdownBody` of ThreadPane) and the command of a tool call
 * (item 286, `ToolInput`). Moved from ThreadPane in item 286 (the contents are unchanged).
 */
import { useEffect, useState } from 'react'
import { CheckIcon } from '../icons/CheckIcon.js'
import { CopyIcon } from '../icons/CopyIcon.js'
import { useT } from '../i18n/index.js'

/**
 * Copying a code block (5.1.2, T17).
 *
 * It uses `navigator.clipboard.writeText` as is. It was measured to **work even from a `sandbox: true` renderer
 * loaded from file://** (the T17 fact in the repository guide), so no path was added to
 * the preload. On failure it silently does nothing (not showing the
 * checkmark is itself the signal for "it did not go in").
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** The copy button. When pressed, it changes to a checkmark for 1.5 seconds (no toast is made). */
export function CopyButton({ code }: { code: string }): React.JSX.Element {
  const t = useT()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className={copied ? 'code-copy copied' : 'code-copy'}
      title={copied ? t('common.copied') : t('common.copyCode')}
      aria-label={t('common.copyCode')}
      onClick={() => {
        void copyToClipboard(code).then((ok) => {
          if (ok) setCopied(true)
        })
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}
