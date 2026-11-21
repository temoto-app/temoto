/**
 * Draws one line's Markdown marks (`` `code` ``, bold, and links) as React elements (TODO 453).
 * Used to show the headings and description lines of `THIRD_PARTY_NOTICES.md` in About (`BuildInfoSection`) and the extension detail (TODO 459).
 * It is not inserted as HTML (`dangerouslySetInnerHTML` is not used), so no sanitizing is needed.
 * Links are not made clickable: only the text is shown and the destination goes in the popover (title); there is no need to jump out from a license display.
 */
import { parseInlineMarkdown } from '@shared/third-party-notices.js'

export function InlineMarkdown({ text }: { readonly text: string }): React.JSX.Element {
  return (
    <>
      {parseInlineMarkdown(text).map((span, i) => {
        switch (span.kind) {
          case 'text':
            return <span key={i}>{span.text}</span>
          case 'code':
            return (
              <code key={i} className="inline-code">
                {span.text}
              </code>
            )
          case 'strong':
            return <strong key={i}>{span.text}</strong>
          case 'link':
            return (
              <span key={i} className="inline-link" title={span.href}>
                {span.text}
              </span>
            )
        }
      })}
    </>
  )
}
