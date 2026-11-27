/**
 * The renderer-side procedure for saving a conversation as PDF / single-file HTML (TODO 818 / 866, ARCHITECTURE.md 5.1.8).
 * There are three entry points: the export icon at the top right of the heading (`ExportMenu`, TODO 865) and the thread list's right-click (`ThreadList`) export
 * the whole conversation, while the hover icon on each message (`ExportTurnButton`) exports that one question-and-answer. Pressing the icon opens a small PDF / HTML menu.
 * Assembly (`exportDocumentHtml`) is common to both formats; only the CSP and the save entry point (`savePdf` / `saveHtml`) differ.
 *
 * The body comes from main (all of it, already redacted), HTML is built here (DOMPurify is needed, so main cannot do it),
 * and the save dialog, PDF conversion, and writing are main's. Failures are shown with a reason code in the band above the window (`useThreads.error`).
 */
import { useSyncExternalStore } from 'react'
import appCss from './styles.css?raw'
import { turnOfQuestion, turnsInScope, type ExportFormat, type ExportScope } from '@shared/conversation-export.js'
import { relabelAttachmentMarks } from '@shared/attachment-mark.js'
import { exportMarkdown } from '@shared/conversation-export-md.js'
import { useThreads } from './threadStore.js'
import { useLocale } from './localeStore.js'
import { t } from './i18n/index.js'
import { threadTitleLabel } from './thread/title.js'
import { collectHasMath, collectMermaidSources, exportDocumentHtml } from './thread/export-pdf.js'
import { renderDiagram } from './thread/mermaid-render.js'

/**
 * Exporting thread -> the key of the entry point that was pressed. Repeated clicks on the same thread must not stack dialogs (one regardless of format).
 * The entry-point buttons show busy / disabled, so subscribers (`useExportState`) are notified when it changes.
 */
const running = new Map<string, string>()
const listeners = new Set<() => void>()
const notify = (): void => listeners.forEach((listener) => listener())

/** Key of the entry point (the whole conversation, or which question-and-answer). */
export const exportTargetKey = (target: ExportTarget): string => (target.kind === 'all' ? 'all' : `turn:${target.eventId}`)

export type ExportUiState = 'idle' | 'busy' | 'blocked'

/** This thread's export state: its own entry point is running (busy), another entry point is running (blocked), none (idle). */
export function useExportState(threadId: string, target: ExportTarget): ExportUiState {
  const key = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    () => running.get(threadId) ?? null
  )
  if (key === null) return 'idle'
  return key === exportTargetKey(target) ? 'busy' : 'blocked'
}

export type ExportTarget = { readonly kind: 'all' } | { readonly kind: 'turn'; readonly eventId: string }

export async function exportThread(threadId: string, target: ExportTarget, format: ExportFormat): Promise<void> {
  if (running.has(threadId)) return
  running.set(threadId, exportTargetKey(target))
  notify()
  try {
    const thread = useThreads.getState().threadsById[threadId]?.thread
    if (thread === undefined) return
    const exported = await window.aios.threads.exportTurns(threadId)
    let scope: ExportScope = { kind: 'all' }
    if (target.kind === 'turn') {
      const turn = turnOfQuestion(exported.turns, target.eventId)
      if (turn === null) return
      scope = { kind: 'turn', number: turn.number }
    }
    const locale = useLocale.getState().resolved
    const title = threadTitleLabel(t, thread.title)
    const savedAt = new Date().toLocaleString(locale)
    const turns = turnsInScope(exported.turns, scope)
    // TODO 880: ```mermaid inlines the rendered SVG (anything that cannot be rendered stays a code block). Fixed to light.
    if (format === 'md') {
      // TODO 1014: Markdown is built directly from the same turn without going through HTML (images become an `[image]` marker, mermaid stays code too).
      const markdown = exportMarkdown({
        title,
        meta: thread.cwdName === '' ? savedAt : `${thread.cwdName} · ${savedAt}`,
        turns,
        relabel: (text) => relabelAttachmentMarks(text, (name) => t('timeline.user.attachmentMark', { name }))
      })
      await window.aios.threads.saveMarkdown(threadId, scope, markdown)
      return
    }
    const diagrams = new Map<string, string>()
    for (const code of collectMermaidSources(turns)) {
      const svg = await renderDiagram(code, 'light')
      if (svg !== null) diagrams.set(code, svg)
    }
    // TODO 1342: the stylesheet with KaTeX's fonts is a lazy chunk, loaded only when an answer has math.
    const mathCss = collectHasMath(turns) ? (await import('virtual:katex-export-css')).default : undefined
    const html = exportDocumentHtml({
      title,
      meta: thread.cwdName === '' ? savedAt : `${thread.cwdName} · ${savedAt}`,
      turns,
      diagrams,
      lang: locale,
      appCss,
      ...(mathCss === undefined ? {} : { mathCss }),
      format,
      relabel: (text) => relabelAttachmentMarks(text, (name) => t('timeline.user.attachmentMark', { name }))
    })
    if (format === 'pdf') await window.aios.threads.savePdf(threadId, scope, html)
    else await window.aios.threads.saveHtml(threadId, scope, html)
  } catch (err) {
    useThreads.setState({ error: err instanceof Error ? err.message : String(err) })
  } finally {
    running.delete(threadId)
    notify()
  }
}
