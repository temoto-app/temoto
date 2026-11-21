/**
 * Secret redaction before saving (ARCHITECTURE.md 4.3.1 / constraint 10 / 8.1).
 *
 * Even when `tool_result` is not saved, secrets can get into tool arguments (`curl -H "Authorization: Bearer …"`,
 * `mysql -pPASSWORD`), answer bodies and **user messages**.
 * Known patterns are masked before writing to the DB.
 *
 * Placement (item 286, wave 16 bundle A): the renderer also passes tool arguments through it while they are still being received (unsaved), so it lives in `src/shared/`.
 * Pure functions only, independent of the DOM and node. `src/common/redact.ts` re-exports from here (the imports on the main / index side stay as they are).
 *
 * Premise: **regex redaction misses things.** It only means something together with
 * whole-DB encryption (chapter 8). This is a layer to "reduce the accumulated amount";
 * do not treat it alone as the basis of protection.
 */

/** The mask. The original length is not kept (the length is information too). */
const MASK = '[redacted]'
/** The mask (counted inside the body the gateway's `respond` cut, TODO 855). */
export const REDACTION_MASK = MASK

/**
 * The maximum number of bytes by which, per mask, the masked body can be **longer** than before masking (TODO 855).
 * For patterns whose value minimum is 1 character (`password` / `cli-password-flag`) it is `[redacted]` (10) - 1 = 9,
 * and `private-key` goes from the shortest key (only the BEGIN/END lines, 52) to the replacement (64), so 12. Others have a value minimum of 8 or more, so 2 or less.
 * Used when the gateway cuts a body containing masks, to underestimate the bytes advanced in the canonical copy.
 * **Revisit it when a pattern is added** (`test/gateway-respond.test.ts` checks every pattern).
 */
export const REDACTION_MAX_GROWTH = 12

interface Pattern {
  readonly name: string
  readonly re: RegExp
  /** Builds the replacement string. The captured "parts that may be shown" are kept. The first argument is the whole match (`_m`). */
  readonly replace: (...groups: string[]) => string
}

/**
 * TODO 752 (owner decision (a), 2026-10-12): if the value is a type name or an expression, treat it as code shape and do not
 * apply redaction. E.g. `string` in `password: string`, `str` in `def login(password: str)`.
 */
const CODE_TYPE_NAMES = new Set([
  'string',
  'str',
  'number',
  'int',
  'bool',
  'boolean',
  'String',
  'None',
  'null',
  'undefined'
])

/**
 * TODO 761 (fix to 752, 2026-10-12): only a value whose `.`-separated chain of identifiers **ends** in a call `(...)` or
 * an index `[...]` is treated as code shape (`process.cwd()` / `z.string().min(8)` /
 * `os.environ[...]`). The original implementation matched on just "an identifier followed by one `.`",
 * and let genuine tokens such as `access_token=ya29.a0AfH6SMBx...` (dot-separated but not
 * a call) through as "code shape" (it relied on the value's character class excluding `(`, so the call's
 * own `(` never entered the captured value). Now the call / index itself is included in the value
 * before judging (paired with the value capture of the form `(?:[^\s(){}\[\],;]|\(...\)|\[...\])+` just before CODE_SHAPE_RE -
 * part of the same fix as TODO 752 (b)).
 */
const CODE_SHAPE_RE =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\([^\s()]*\)|\[[^\s[\]]*\])*(?:\([^\s()]*\)|\[[^\s[\]]*\])$/

/**
 * Known heads of environment variable references. A reference that does not end in a call or index (`process.env.SECRET_VALUE`,
 * a bare `os.environ`) is also treated as code shape if the head matches.
 */
const ENV_REF_PREFIX_RE = /^(?:process\.env\.|os\.environ(?:\.|\[|\b)|import\.meta\.env\.|getenv\()/

/** True if the value looks like "code shape" (TODO 752 (a)). When it matches, redaction is not applied. */
function isCodeLikeValue(value: string): boolean {
  return CODE_TYPE_NAMES.has(value) || CODE_SHAPE_RE.test(value) || ENV_REF_PREFIX_RE.test(value)
}

/**
 * TODO 761 (fix to 752 (b), 2026-10-12): **paired** `()` `[]` `{}` inside a value are included in the value, and
 * it stops at an unpaired closing bracket (such as the `)` of the calling statement). The original implementation removed brackets wholesale from the value's
 * character class, so `password=Pa(ss)w0rd!` was split into `[redacted](ss)w0rd!` and
 * `mysql -pS3cr[et]99` into `-p[redacted][et]99` (paired brackets are part of the real value
 * but were cut in the middle). `excludeExtra` takes characters such as `"` `'` that only the caller wants to stop at
 * additionally (password stops before quotes, `,` and `;`. mysql's `-p` allows quotes).
 */
function balancedValuePattern(excludeExtra: string): string {
  const single = `[^\\s(){}\\[\\]${excludeExtra}]`
  return `(?:${single}|\\([^\\s()]*\\)|\\[[^\\s[\\]]*\\]|\\{[^\\s{}]*\\})+`
}

/**
 * TODO 858: just before a key name. `\b` treats `_` as a word character, so it does not hold for environment variable forms such as `DB_PASSWORD=` / `GITHUB_TOKEN=`.
 * Starting is fine as long as the preceding character is not alphanumeric (= even right after `_`).
 */
const KEY_START = '(?<![A-Za-z0-9])'

/**
 * Patterns crush only "the key's value" and keep the surrounding context.
 * Erasing the context makes the conversation unreadable and defeats the storage purpose of 4.3.1 (restore and search).
 */
const PATTERNS: readonly Pattern[] = [
  // Authorization: Bearer xxx / Authorization: Basic xxx
  {
    name: 'authorization-header',
    re: /(authorization["']?\s*[:=]\s*["']?)(bearer\s+|basic\s+|token\s+)?([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (_m, head = '', scheme = '') => `${head}${scheme}${MASK}`
  },
  // A bare Bearer token
  {
    name: 'bearer',
    re: /\b(bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi,
    replace: (_m, head = '') => `${head}${MASK}`
  },
  // AWS access key ID and secret
  {
    name: 'aws-access-key-id',
    re: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16})\b/g,
    replace: () => MASK
  },
  {
    name: 'aws-env',
    re: /\b(AWS_(?:SECRET_ACCESS_KEY|ACCESS_KEY_ID|SESSION_TOKEN)\s*[:=]\s*["']?)([^\s"'&(){}[\]]{8,})/g,
    replace: (m, head = '', value = '') => (isCodeLikeValue(value) ? m : `${head}${MASK}`)
  },
  // PEM private key. Dropped together with the body
  {
    name: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => `-----BEGIN PRIVATE KEY----- ${MASK} -----END PRIVATE KEY-----`
  },
  // password= / passwd= / pwd=
  // TODO 752 (b)/761: remove unpaired ( ) , ; { } [ ] from the value's character class, keep paired brackets
  // (`Pa(ss)w0rd!`) as part of the value, and still stop at the closing bracket of the calling statement (the `)` of `password: str)`)
  // (`balancedValuePattern`). (a): do not apply when the captured value is a type name or an expression (code shape,
  // `isCodeLikeValue`) (`password: string` / `password: str`).
  {
    name: 'password',
    re: new RegExp(`${KEY_START}(pass(?:wd|word)?|pwd)(["']?\\s*[:=]\\s*["']?)(${balancedValuePattern('"\'&;,')})`, 'gi'),
    replace: (m, key = '', sep = '', value = '') => (isCodeLikeValue(value) ? m : `${key}${sep}${MASK}`)
  },
  // -p<password> of the mysql family. Crushing `-p` unconditionally would also catch `git log -p` and
  // `--pretty=`, so it is limited by command name.
  {
    name: 'cli-password-flag',
    re: new RegExp(`\\b(mysql|mysqldump|mariadb)\\b([^\\n]{0,80}?\\s-p)(${balancedValuePattern('')})`, 'g'),
    replace: (m, cmd = '', head = '', value = '') => (isCodeLikeValue(value) ? m : `${cmd}${head}${MASK}`)
  },
  // api_key= / apikey= / api-key= / secret= / client_secret=
  {
    name: 'api-key',
    re: /(?<![A-Za-z0-9])((?:api[_-]?key|apikey|secret[_-]?key|access[_-]?key|private[_-]?key|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)([^\s"'&;,(){}[\]]{8,})/gi,
    replace: (m, head = '', value = '') => (isCodeLikeValue(value) ? m : `${head}${MASK}`)
  },
  // token= (it also catches short values, so it is a separate pattern from api-key)
  {
    name: 'token',
    re: /(?<![A-Za-z0-9])(token["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{12,})/gi,
    replace: (m, head = '', value = '') => (isCodeLikeValue(value) ? m : `${head}${MASK}`)
  },
  // TODO 858: credentials in URLs (`postgres://user:pass@host`, `mongodb+srv://admin:pass@…`).
  // Not applied when the value is a placeholder symbol such as `${PASS}` / `<password>`.
  {
    name: 'url-credentials',
    re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi,
    replace: (m, head = '', value = '', at = '') =>
      /^(?:\$|<.*>$|\{\{|%[0-9A-Fa-f]{2}$)/.test(value) ? m : `${head}${MASK}${at}`
  },
  // TODO 858: the signature of a signed URL (`?sig=…` / `&signature=…` / `X-Amz-Signature=…`)
  {
    name: 'url-signature',
    re: /([?&](?:sig|signature|x-amz-signature|x-amz-security-token|x-goog-signature)=)([^\s&#"']{8,})/gi,
    replace: (_m, head = '') => `${head}${MASK}`
  },
  // Key formats of major services (those identifiable by a prefix)
  {
    name: 'service-key',
    re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
    replace: () => MASK
  },
  {
    name: 'github-token',
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replace: () => MASK
  },
  {
    name: 'slack-token',
    re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => MASK
  },
  {
    name: 'google-api-key',
    re: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    replace: () => MASK
  },
  // JSON Web Token
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => MASK
  }
]

export interface RedactionResult {
  readonly text: string
  /** Names of the patterns that matched. Used for the log and the UI's "N items masked". The values themselves are not kept. */
  readonly hits: readonly string[]
}

/** Applies redaction to one string. */
export function redactText(input: string): RedactionResult {
  let text = input
  const hits: string[] = []
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0
    if (!pattern.re.test(text)) continue
    pattern.re.lastIndex = 0
    const before = text
    text = text.replace(pattern.re, (...args) => {
      const groups = args.slice(0, -2).map((g) => (typeof g === 'string' ? g : ''))
      return pattern.replace(...groups)
    })
    // TODO 752: when code shape (isCodeLikeValue) is hit, replace returns the original whole match
    // unchanged. It looks like a match but nothing was actually masked, so it is not counted as a hit.
    if (text !== before) hits.push(pattern.name)
  }
  return { text, hits }
}

/** The range of a hit of `redactionRanges` (UTF-16 positions, `[start, end)`). */
export interface RedactionRange {
  readonly start: number
  readonly end: number
}

const PEM_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
const PEM_END_RE = /-----END [A-Z ]*PRIVATE KEY-----/g

/**
 * Returns the **ranges** that redaction masks inside `input` (wave 42 code-review bundle X). Overlaps are merged and sorted by position.
 * When the gateway hands part of the canonical copy (a page, a chunk) to the AI, applying `redactText` to only that part
 * misses a secret split at the boundary (`…DB_PA` | `SSWORD=hunter2secret`), which slips through. The caller computes this on a window with
 * context added before and after the returned range, and masks the hits that intersect the returned range (`redactSlice`).
 *
 * - Each pattern is applied to `input` **separately** (`redactText` applies them in order and searches on top of the previous replacement, but
 *   a replacement only shortens the value, so hits found separately cover the union of those).
 * - A range is the value part, excluding the head (`password=`) and tail (the `@` of `url-credentials`) that the replacement keeps.
 * - `private-key` is BEGIN to END as a whole. With `opts.openStart` / `opts.openEnd` (the canonical copy continues before / after
 *   the window), an unpaired END is masked from the window's start and an unpaired BEGIN to the window's end (the window cut the key in the middle).
 *
 * The behavior of `redactText` does not depend on this (the storage gate stays as before).
 */
export function redactionRanges(
  input: string,
  opts: { readonly openStart?: boolean; readonly openEnd?: boolean } = {}
): RedactionRange[] {
  const ranges: RedactionRange[] = []
  for (const pattern of PATTERNS) {
    if (pattern.name === 'private-key') continue
    for (const m of input.matchAll(pattern.re)) {
      const whole = m[0]
      const groups = [...m].map((g) => (typeof g === 'string' ? g : ''))
      const replaced = pattern.replace(...groups)
      if (replaced === whole) continue
      const at = m.index ?? 0
      const maskAt = replaced.indexOf(MASK)
      const head = maskAt < 0 ? '' : replaced.slice(0, maskAt)
      const tail = maskAt < 0 ? '' : replaced.slice(maskAt + MASK.length)
      if (maskAt >= 0 && whole.startsWith(head) && whole.endsWith(tail) && head.length + tail.length < whole.length) {
        ranges.push({ start: at + head.length, end: at + whole.length - tail.length })
      } else {
        ranges.push({ start: at, end: at + whole.length })
      }
    }
  }
  // PEM private key: pair BEGIN and END in position order (the same pairing as `redactText`'s shortest match).
  const markers: { at: number; end: number; begin: boolean }[] = []
  for (const m of input.matchAll(PEM_BEGIN_RE)) markers.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, begin: true })
  for (const m of input.matchAll(PEM_END_RE)) markers.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, begin: false })
  markers.sort((a, b) => a.at - b.at)
  let open: number | null = null
  for (const marker of markers) {
    if (marker.begin) {
      open ??= marker.at
    } else if (open !== null) {
      ranges.push({ start: open, end: marker.end })
      open = null
    } else if (opts.openStart === true) {
      ranges.push({ start: 0, end: marker.end })
    }
  }
  if (open !== null && opts.openEnd === true) ranges.push({ start: open, end: input.length })
  return mergeRanges(ranges)
}

function mergeRanges(ranges: RedactionRange[]): RedactionRange[] {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start)
  const out: { start: number; end: number }[] = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else out.push({ start: range.start, end: range.end })
  }
  return out
}

/** The context of `redactSlice`. */
export interface RedactionContext {
  /** The canonical copy just before the returned body (hundreds of bytes to a few KiB). */
  readonly before: string
  /** The canonical copy just after the returned body. */
  readonly after: string
  /** The canonical copy also continues before `before` (= `before` does not reach the start of the canonical copy). */
  readonly moreBefore: boolean
  /** The canonical copy also continues after `after`. */
  readonly moreAfter: boolean
}

/**
 * Applies redaction to a part `text` of the canonical copy, using a window with context added before and after (wave 42 code-review bundle X).
 * Computes `redactionRanges` on the window (`before + text + after`) and replaces each hit that intersects `text` with a single `[redacted]`.
 * As a finish, `redactText` is also applied to `text` alone (insurance against hits the window missed).
 * The growth per mask is at most 9 bytes since the intersection is at least 1 character (<= `REDACTION_MAX_GROWTH`).
 */
export function redactSlice(text: string, context: RedactionContext): RedactionResult {
  const window = context.before + text + context.after
  const offset = context.before.length
  const ranges = redactionRanges(window, {
    openStart: context.moreBefore,
    openEnd: context.moreAfter
  })
  let out = ''
  let cursor = 0
  let masked = false
  for (const range of ranges) {
    const start = Math.max(range.start - offset, 0)
    const end = Math.min(range.end - offset, text.length)
    if (end <= start || end <= cursor) continue
    const from = Math.max(start, cursor)
    out += text.slice(cursor, from) + MASK
    cursor = end
    masked = true
  }
  out += text.slice(cursor)
  const second = redactText(out)
  const hits = masked ? ['window', ...second.hits] : second.hits
  return { text: second.text, hits }
}

/** TODO 858: whether a key name is sensitive. Remove `_` `-`, lowercase it, and judge by the end (`max_tokens` / `tokenizer` do not match). */
const SENSITIVE_KEY_SUFFIXES = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'credential',
  'credentials',
  'privatekey',
  'accesskey',
  'secretkey'
]
function isSensitiveKey(key: string): boolean {
  const k = key.replace(/[_\-\s]/g, '').toLowerCase()
  return SENSITIVE_KEY_SUFFIXES.some((s) => k === s || k.endsWith(s))
}

/** Applies redaction recursively to strings only, keeping the JSON structure. */
export function redactJson<T>(value: T): { value: T; hits: readonly string[] } {
  const hits = new Set<string>()
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const result = redactText(node)
      for (const hit of result.hits) hits.add(hit)
      return result.text
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(node)) {
        // TODO 858: if the key name is sensitive, mask the whole value (strings and numbers) regardless of its shape.
        if ((typeof child === 'string' && child !== '') || typeof child === 'number') {
          if (isSensitiveKey(key)) {
            hits.add('json-key')
            out[key] = MASK
            continue
          }
        }
        out[key] = walk(child)
      }
      return out
    }
    return node
  }
  return { value: walk(value) as T, hits: [...hits] }
}

/** The list of redaction pattern names (for the settings screen's description and for tests). */
export const REDACTION_PATTERN_NAMES: readonly string[] = PATTERNS.map((p) => p.name)
