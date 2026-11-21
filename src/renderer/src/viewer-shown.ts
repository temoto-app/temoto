/**
 * TODO 1061 (3): a pure function that builds what this window's ViewerPane is currently showing in front (`ViewerShownReport`), and a small box that sends it to
 * main only when it changes. Main puts a "shown" marker (`shown` / `inView`) on the gateway's `listOpenFiles`.
 *
 * What is in front is decided as in `ViewerPane` / `App`: a temporary view (the diff of item 104), if any, is on top; otherwise
 * if `selectedUri` is Web (`isWebPaneUri`, including a blank tab) it is the Web view, if a file the file's viewer, and if null it is closed.
 */
import { isWebPaneUri } from '@shared/web-tabs.js'
import { clipShownSelection, sameViewerShown, type ViewerShownReport, type ViewerShownSelection } from '@shared/viewer-shown.js'

export interface ViewerShownInput {
  readonly activeThreadId: string | null
  readonly selectedUri: string | null
  readonly hasTransient: boolean
  /** The current page (1-based) and selection range the viewer reported (TODO 1061 part 2). `uri` is used only when it equals the file being shown. */
  readonly page?: { readonly uri: string; readonly page: number } | null
  readonly selection?: { readonly uri: string } & ViewerShownSelection | null
  /** The selection range of the temporary diff view (TODO 1091 part 2). Used only when `hasTransient`. */
  readonly transientSelection?: ViewerShownSelection | null
  /** When the temporary view is a file inside an archive, the path inside that archive (TODO 1094). null / omitted for a temporary diff view. */
  readonly transientEntry?: string | null
}

export function viewerShownReport(input: ViewerShownInput): ViewerShownReport | null {
  const { activeThreadId: threadId, selectedUri, hasTransient } = input
  if (threadId === null) return null
  if (hasTransient) {
    // A temporary view of a file inside an archive is not a diff: report it as `file`, with the archive's URI and the inner path (TODO 1094).
    if (input.transientEntry != null && selectedUri !== null && !isWebPaneUri(selectedUri)) {
      return { threadId, kind: 'file', uri: selectedUri, entry: input.transientEntry }
    }
    const diffSel = input.transientSelection
    return { threadId, kind: 'diff', uri: null, ...(diffSel == null ? {} : { selection: clipShownSelection(diffSel) }) }
  }
  if (selectedUri === null) return { threadId, kind: 'none', uri: null }
  if (isWebPaneUri(selectedUri)) return { threadId, kind: 'web', uri: selectedUri }
  const page = input.page != null && input.page.uri === selectedUri ? input.page.page : null
  const sel = input.selection != null && input.selection.uri === selectedUri ? input.selection : null
  return {
    threadId,
    kind: 'file',
    uri: selectedUri,
    ...(page === null ? {} : { page }),
    ...(sel === null
      ? {}
      : {
          selection: clipShownSelection(sel)
        })
  }
}

/** Does not resend the same value. */
export class ViewerShownReporter {
  private last: ViewerShownReport | null | undefined = undefined

  constructor(private readonly send: (report: ViewerShownReport | null) => void) {}

  update(input: ViewerShownInput): void {
    const next = viewerShownReport(input)
    if (this.last !== undefined && sameViewerShown(this.last, next)) return
    this.last = next
    this.send(next)
  }
}
