/**
 * Turns a Redmine ticket number in an answer into a link to the Redmine ticket (TODO 811, wave 44 bundle A).
 * A pure function, independent of the DOM and Node. The rule for making a link (which numbers to pick up) is in
 * `shared/markdown/link-redmine.ts`; this file only validates the setting's URL and maps number -> URL.
 *
 * - It holds just one Redmine base URL in the setting (`web.redmineBaseUrl`) (owner decision 2026-10-18. Not done when there are several Redmines).
 *   **https only**, no credentials, no query or fragment. A sub-path (`https://host/redmine`) is allowed.
 * - Does nothing when unset (empty). The link is a normal https link, so clicking it opens it in the Web view (`src/main/web/`).
 */

/** Upper limit of the setting's length. */
export const REDMINE_BASE_URL_MAX = 2048

/**
 * The setting's string -> a normalized base URL (no trailing `/`). Unusable values (empty, not https, with credentials, with a query/fragment,
 * no host) give null.
 */
export function normalizeRedmineBase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '' || text.length > REDMINE_BASE_URL_MAX) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname === '') return null
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

/** Ticket number (a string of a positive integer) -> `<base>/issues/<n>`. null if the base is unusable or the number is invalid. */
export function redmineIssueUrl(base: unknown, issue: string): string | null {
  const normalized = normalizeRedmineBase(base)
  if (normalized === null || !/^[1-9]\d{0,8}$/.test(issue)) return null
  return `${normalized}/issues/${issue}`
}
