/**
 * The text of collapsed contents (decision 5 of TODO 496, ARCHITECTURE 5.1.7). In-thread search looks through the drawn DOM, so for contents that are
 * collapsed and not drawn, a component builds here the "text that appears when opened" and matches against it (`useFindPending`). It does not
 * exactly match how it is drawn (Markdown symbols, field headings): if there is no hit after opening, the search box moves on to the next match.
 */
import { toolInputView, displayToolSummary } from './tool-input.js'
import type { TimelineItem } from './timeline.js'

/** The text that appears when a tool row is opened: the arguments (formatted like `ToolInput`) and the result body, which is only at hand while receiving. */
export function toolFindText(item: TimelineItem): string {
  if (item.kind !== 'tool') return ''
  const parts: string[] = []
  if (item.input !== null) {
    const view = toolInputView(item.input)
    if (view.kind === 'json') parts.push(view.json)
    else {
      if (view.command !== null) parts.push(view.command)
      if (view.description !== null) parts.push(view.description)
      for (const field of view.fields) parts.push(`${field.key}\n${field.value}`)
      if (view.rest !== null) parts.push(view.rest)
    }
  }
  // The result body is not persisted (constraint 10). Only the row being received has `text`.
  if (item.result?.text !== undefined) parts.push(item.result.text)
  return parts.join('\n')
}

/** The text of a row hidden behind "+N" in a subagent block (material drawn the same way as visible rows). */
export function itemFindText(item: TimelineItem): string {
  switch (item.kind) {
    case 'user':
    case 'assistant':
      return item.text
    case 'tool': {
      const head = `${item.name}\n${displayToolSummary(item.input, item.summary)}`
      const plan = item.plan ?? ''
      return [head, toolFindText(item), plan].filter((part) => part !== '').join('\n')
    }
    default:
      return ''
  }
}
