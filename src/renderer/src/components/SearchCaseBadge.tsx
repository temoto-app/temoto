/**
 * The faint `Aa` badge at the right of the search field (TODO 291, owner decision (2)).
 *
 * With smart case (only a term containing an uppercase letter is case-sensitive), it is shown only when the result on screen
 * was obtained case-sensitively, so the user can tell why `system.ts` does not match.
 * It looks like VS Code's search-field `Aa`, but **pressing it does not toggle anything** (just a badge).
 * Whether the search was case-sensitive is put in the result by the index process (`caseSensitive`). The renderer does not decide.
 */
import { useT } from '../i18n/index.js'

export function SearchCaseBadge(props: { readonly shown: boolean }): React.JSX.Element | null {
  const t = useT()
  if (!props.shown) return null
  return (
    <span className="search-case-badge" title={t('search.caseSensitive.title')}>
      {t('search.caseSensitive.badge')}
    </span>
  )
}
