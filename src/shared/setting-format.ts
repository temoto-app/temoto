/**
 * The "shape" of an extension's setting field item (`format`, fix X of TODO 1225, ARCHITECTURE 7.2.1). It makes the extension choose from **a table of fixed named shapes that main owns**
 * (the same place as `format` in VS Code's `contributes.configuration`). Extensions are not allowed to write an arbitrary regex (`pattern`) - applying an external extension's
 * expression on main's JS thread can be stalled by the expression's shape (the same kind of harm as the "39-second unresponsiveness" of 2026-09-22. Security review).
 *
 * Every check is a **hand-written validation that looks at the length limit first**, uses no backtracking regex, and is linear in the input length. Both uppercase and lowercase are accepted.
 *
 * - `email`: `local@domain` (exactly one `@`). The local part is 1-64 characters and contains no whitespace, control characters or `@ < > ( ) [ ] , ; : "`.
 * - `hostname`: one or more labels (1-63 alphanumerics and `-`, alphanumeric at start and end) joined by `.`. Up to 253 characters in total. A trailing `.` is not accepted.
 * - `email-or-domain`: `email`, `@` + domain, or a domain. A domain is a `hostname` with two or more labels (`localhost` is not accepted).
 *   The form of `aios.gmail`'s sender allow table (`plugins/aios.gmail/host/trigger.ts` holds a copy of the same rule - because it cannot import under constraint 8.
 *   `test/plugin-gmail-trigger.test.ts` pins that they do not diverge, and that if they do diverge it falls on the closing side).
 */

export const SETTING_FORMATS = ['email', 'hostname', 'email-or-domain'] as const
export type SettingFormat = (typeof SETTING_FORMATS)[number]

export function isSettingFormat(value: unknown): value is SettingFormat {
  return typeof value === 'string' && (SETTING_FORMATS as readonly string[]).includes(value)
}

/** Length limit of one item (the RFC 5321 address limit). Anything longer is not looked into. */
const MAX_ITEM = 254
const MAX_HOSTNAME = 253
const MAX_LABEL = 63
const MAX_LOCAL = 64

function isAlnum(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

/** Whether it is a hostname with at least `minLabels` labels. */
function isHostname(text: string, minLabels: number): boolean {
  if (text.length === 0 || text.length > MAX_HOSTNAME) return false
  let labels = 0
  let start = 0
  for (let i = 0; i <= text.length; i += 1) {
    if (i < text.length && text.charCodeAt(i) !== 0x2e) continue
    const length = i - start
    if (length === 0 || length > MAX_LABEL) return false
    if (!isAlnum(text.charCodeAt(start)) || !isAlnum(text.charCodeAt(i - 1))) return false
    for (let k = start; k < i; k += 1) {
      const code = text.charCodeAt(k)
      if (!isAlnum(code) && code !== 0x2d) return false
    }
    labels += 1
    start = i + 1
  }
  return labels >= minLabels
}

/** Characters not allowed in the local part (whitespace, control characters, delimiters). */
function isLocalChar(code: number): boolean {
  if (code <= 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false
  if (code === 0xa0 || code === 0x2028 || code === 0x2029 || code === 0xfeff || code === 0x3000) return false
  return !'@<>()[],;:"\\'.includes(String.fromCharCode(code))
}

function isEmail(text: string): boolean {
  const at = text.indexOf('@')
  if (at <= 0 || at > MAX_LOCAL || text.indexOf('@', at + 1) !== -1) return false
  for (let i = 0; i < at; i += 1) if (!isLocalChar(text.charCodeAt(i))) return false
  return isHostname(text.slice(at + 1), 2)
}

/** Whether one value (a string or one table item) fits the shape. An empty string is handled by the caller (false here). */
export function matchesSettingFormat(format: SettingFormat, text: string): boolean {
  if (text.length === 0 || text.length > MAX_ITEM) return false
  switch (format) {
    case 'email':
      return isEmail(text)
    case 'hostname':
      return isHostname(text, 1)
    case 'email-or-domain':
      if (text.charCodeAt(0) === 0x40) return isHostname(text.slice(1), 2)
      return text.includes('@') ? isEmail(text) : isHostname(text, 2)
  }
}
