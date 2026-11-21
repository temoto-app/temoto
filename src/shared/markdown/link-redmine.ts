/**
 * Turns Redmine ticket numbers in an answer body into links (TODO 811, `shared/redmine-link.ts`). A markdown-it core rule.
 *
 * **To avoid false positives, it picks up only these two** (a bare number string is not picked up):
 * - The form `#22955` in the body (text) (`#` + 3 to 9 digits, not preceded by a word character, `#`, `&` or `/`). `#1`, `#12` and colors like `#fff` are not picked up.
 * - Cells in a table column whose heading is `#` / (the Japanese word for ticket) / `ticket` / `issue`, when the content is only a number (`22955` / `#22955`, 1 to 9 digits).
 * Code blocks, inline `code`, anything already inside a link, and image alt text are left alone. It does not run
 * for renders without `env.redmineBase` (a validated setting).
 */
import type MarkdownIt from 'markdown-it'
import type { Token } from 'markdown-it'
import { redmineIssueUrl } from '../redmine-link.js'

/** `#22955` in the body. Not preceded by a word character, `#`, `&` or `/`, and not followed by a word character. */
const PROSE_ISSUE = /(?<![\w#&/])#([1-9]\d{2,8})(?!\w)/g

/** Headings regarded as a ticket column (the whole content). */
const TICKET_HEADER = /^(?:#|チケット|ticket|issue)$/i

/** The table cell content is only a number. */
const CELL_ISSUE = /^#?([1-9]\d{0,8})$/

interface RedmineEnv {
  readonly redmineBase?: string
}

export function linkRedminePlugin(md: InstanceType<typeof MarkdownIt>): void {
  md.core.ruler.push('aios_link_redmine', (state) => {
    const base = (state.env as RedmineEnv | undefined)?.redmineBase
    if (typeof base !== 'string' || base === '') return
    const makeLink = (href: string, level: number): [Token, Token] => {
      const open = new state.Token('link_open', 'a', 1)
      open.attrs = [['href', href]]
      open.markup = 'aios-redmine'
      open.info = 'auto'
      open.level = level
      const close = new state.Token('link_close', 'a', -1)
      close.markup = 'aios-redmine'
      close.info = 'auto'
      close.level = level
      return [open, close]
    }
    // Collects the ticket column numbers for each table.
    let ticketColumns = new Set<number>()
    let inHead = false
    let column = -1
    let currentCellIsTicket = false
    for (const block of state.tokens) {
      switch (block.type) {
        case 'table_open':
          ticketColumns = new Set()
          break
        case 'table_close':
          ticketColumns = new Set()
          currentCellIsTicket = false
          inHead = false
          column = -1
          break
        case 'thead_open':
          inHead = true
          break
        case 'thead_close':
          inHead = false
          break
        case 'tr_open':
          column = -1
          break
        case 'th_open':
        case 'td_open':
          column += 1
          currentCellIsTicket = block.type === 'td_open' && ticketColumns.has(column)
          break
        case 'inline': {
          if (block.children === null) break
          if (inHead) {
            if (TICKET_HEADER.test(block.content.trim())) ticketColumns.add(column)
            break
          }
          if (currentCellIsTicket) {
            const cell = CELL_ISSUE.exec(block.content.trim())
            const href = cell?.[1] === undefined ? null : redmineIssueUrl(base, cell[1])
            const only = block.children.length === 1 ? block.children[0]! : null
            if (href !== null && only !== null && only.type === 'text') {
              const [open, close] = makeLink(href, only.level)
              only.level += 1
              block.children = [open, only, close]
              break
            }
          }
          const children: Token[] = []
          let depth = 0
          for (const token of block.children) {
            if (token.type === 'link_open') depth += 1
            else if (token.type === 'link_close') depth -= 1
            if (depth > 0 || token.type !== 'text' || !token.content.includes('#')) {
              children.push(token)
              continue
            }
            let at = 0
            let any = false
            PROSE_ISSUE.lastIndex = 0
            let match: RegExpExecArray | null
            while ((match = PROSE_ISSUE.exec(token.content)) !== null) {
              const href = redmineIssueUrl(base, match[1]!)
              if (href === null) continue
              any = true
              if (match.index > at) {
                const before = new state.Token('text', '', 0)
                before.content = token.content.slice(at, match.index)
                before.level = token.level
                children.push(before)
              }
              const [open, close] = makeLink(href, token.level)
              const label = new state.Token('text', '', 0)
              label.content = match[0]
              label.level = token.level + 1
              children.push(open, label, close)
              at = match.index + match[0].length
            }
            if (!any) {
              children.push(token)
              continue
            }
            if (at < token.content.length) {
              const after = new state.Token('text', '', 0)
              after.content = token.content.slice(at)
              after.level = token.level
              children.push(after)
            }
          }
          block.children = children
          break
        }
        default:
          break
      }
    }
  })
}
