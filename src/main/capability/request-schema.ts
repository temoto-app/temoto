/**
 * Validation of Broker requests from the plugin-host to main (review A-3, ARCHITECTURE.md 7.7).
 *
 * The plugin-host is a separate trust domain, and values from it, like the renderer's IPC, are **not trusted to have the right types**.
 * Previously `frame.payload as never` went straight to `Broker.handle`, so a non-string `uri`
 * crashed with a TypeError (the result was a denial but the reason was `error`), `headers` passed even as an array,
 * and the `document` fields of `index.put` went straight into SQL binds.
 *
 * The policy is the same as `manifest.ts`: **an unknown key is rejected (`.strict()`)**, a wrong type is rejected,
 * and nothing is filled in by guessing. What fails here is recorded in the audit by the Broker as `deny('invalid-request')`.
 * Ranges (length limits) are set to "sizes a legitimate use never reaches", and the decisions themselves (declaration, consent,
 * policy) remain the Broker's job.
 */
import { z } from 'zod'
import { MAX_PLUGIN_INDEX_SOURCE, MAX_PLUGIN_READ_CHUNK_BYTES, type BrokerRequest } from '@shared/plugin.js'
import { MAX_RESPONSE_BYTES } from './net-policy.js'
import { UI_SIDEBAR_ROWS, UI_STATUS } from './surface-schema.js'
import { TRIGGER_LIMITS } from '@shared/trigger.js'
import { MAX_GIT_LOG, isGitRelativePath, isGitSide } from '@shared/plugin-git.js'
import { isGitRev } from '@shared/git-rev.js'

/** Length of a URI / URL. Paths are limited to about 4 KB by the OS, so this suffices even with encoding. */
const MAX_URI = 8192
/** Body (a document for the index, a send body). 8 MB, the same as the response limit. */
const MAX_BODY = MAX_RESPONSE_BYTES

const URI = z.string().min(1).max(MAX_URI)
const NAME = z.string().min(1).max(128)
/** HTTP header name (a token of RFC 9110). Newlines and `:` are not allowed in it. */
const HEADER_NAME = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
/** Do not allow CR / LF / NUL in a header value (header injection). */
const HEADER_VALUE = z
  .string()
  .max(8192)
  .regex(/^[^\r\n\0]*$/)

const HEADERS = z
  .record(HEADER_NAME, HEADER_VALUE)
  .refine((headers) => Object.keys(headers).length <= 64, 'too many headers')

const BYTES = z.instanceof(Uint8Array).refine((value) => value.byteLength <= MAX_BODY, 'too large')

const FS_READ = z
  .object({
    capability: z.literal('fs'),
    op: z.literal('read'),
    uri: URI,
    encoding: z.enum(['utf8', 'bytes']).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    length: z.number().int().min(1).max(MAX_PLUGIN_READ_CHUNK_BYTES).optional()
  })
  .strict()

const NET_FETCH = z
  .object({
    capability: z.literal('network'),
    op: z.literal('fetch'),
    url: URI,
    method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    headers: HEADERS.optional(),
    body: z.union([z.string().max(MAX_BODY), BYTES]).optional(),
    auth: NAME.optional()
  })
  .strict()

const CREDENTIALS_STATUS = z
  .object({ capability: z.literal('credentials'), op: z.literal('status'), name: NAME })
  .strict()

const SOURCE = z.string().min(1).max(MAX_PLUGIN_INDEX_SOURCE)

const INDEX_PUT = z
  .object({
    capability: z.literal('index'),
    op: z.literal('put'),
    document: z
      .object({
        source: SOURCE,
        sourceId: z.string().min(1).max(1024),
        title: z.string().max(1024),
        uri: URI,
        body: z.string().max(MAX_BODY),
        updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
      })
      .strict()
  })
  .strict()

const INDEX_REMOVE = z
  .object({
    capability: z.literal('index'),
    op: z.literal('remove'),
    source: SOURCE,
    sourceId: z.string().min(1).max(1024)
  })
  .strict()

const UI_NOTIFY = z
  .object({
    capability: z.literal('ui'),
    op: z.literal('notify'),
    title: z.string().min(1).max(256),
    body: z.string().max(4096).optional()
  })
  .strict()

/** TODO 848: GET only. A plugin can pass neither headers nor a body (cookies belong to the Web view session). */
const BROWSER_FETCH_PAGE = z
  .object({ capability: z.literal('browser'), op: z.literal('fetchPage'), url: URI })
  .strict()

/**
 * TODO 1216: report one event. This checks only shape and length (the `prompt` limit is the size of "a reference only"). Declaration and consent are the Broker's;
 * control characters in the title, URL schemes, working folder, duplicates, and rules are checked by main's `TriggerService`.
 */
const TRIGGERS_EMIT = z
  .object({
    capability: z.literal('triggers'),
    op: z.literal('emit'),
    event: z
      .object({
        trigger: z.string().min(1).max(TRIGGER_LIMITS.id),
        key: z.string().min(1).max(TRIGGER_LIMITS.key),
        title: z.string().min(1).max(TRIGGER_LIMITS.title),
        url: z.string().min(1).max(TRIGGER_LIMITS.url).optional(),
        cwd: z.string().min(1).max(TRIGGER_LIMITS.cwd).optional(),
        prompt: z.string().min(1).max(TRIGGER_LIMITS.prompt)
      })
      .strict()
  })
  .strict()

/**
 * TODO 834 stage 1: the read-only git operations. `repo` is a `file:` URI (the Broker checks the grant and the policy); revs pass `isGitRev`
 * (never `-`-leading, no `:`) and paths pass `isGitRelativePath` (relative, no `..`, no `.git`, no control characters). Anything else is
 * `invalid-request` before it reaches the decision. The argv is built by main from these values only.
 */
const GIT_REV = z.string().refine((value) => isGitRev(value))
const GIT_STATUS = z.object({ capability: z.literal('git'), op: z.literal('status'), repo: URI }).strict()
const GIT_DIFF = z
  .object({
    capability: z.literal('git'),
    op: z.literal('diff'),
    repo: URI,
    from: GIT_REV.optional(),
    to: GIT_REV.optional(),
    staged: z.boolean().optional()
  })
  .strict()
  // `to` needs `from`, and a staged diff has no `to` (its right side is the index).
  .refine((value) => (value.to === undefined || value.from !== undefined) && !(value.staged === true && value.to !== undefined))
const GIT_SHOW = z
  .object({
    capability: z.literal('git'),
    op: z.literal('show'),
    repo: URI,
    rev: z.string().refine((value) => isGitSide(value)),
    path: z.string().refine((value) => isGitRelativePath(value))
  })
  .strict()
const GIT_LOG = z
  .object({
    capability: z.literal('git'),
    op: z.literal('log'),
    repo: URI,
    rev: GIT_REV.optional(),
    limit: z.number().int().min(1).max(MAX_GIT_LOG).optional(),
    skip: z.number().int().min(0).max(1_000_000).optional()
  })
  .strict()

/** TODO 1225: read its own settings. No arguments (which extension's values is decided by the connection). */
const SETTINGS_GET = z.object({ capability: z.literal('settings'), op: z.literal('get') }).strict()

const BROKER_REQUEST = z.union([
  SETTINGS_GET,
  FS_READ,
  NET_FETCH,
  CREDENTIALS_STATUS,
  INDEX_PUT,
  INDEX_REMOVE,
  UI_NOTIFY,
  UI_SIDEBAR_ROWS,
  UI_STATUS,
  BROWSER_FETCH_PAGE,
  TRIGGERS_EMIT,
  GIT_STATUS,
  GIT_DIFF,
  GIT_SHOW,
  GIT_LOG
])

/** A `BrokerRequest` if it passes validation, null otherwise. **It does not throw.** */
export function parseBrokerRequest(raw: unknown): BrokerRequest | null {
  const result = BROKER_REQUEST.safeParse(raw)
  return result.success ? (result.data as BrokerRequest) : null
}

/**
 * The capability name / operation name recorded in the audit log. The contents of a request that failed validation cannot be trusted, so
 * **only short lowercase words** are copied and anything else becomes `invalid` (arbitrary strings cannot be written into the audit).
 */
export function auditLabel(raw: unknown, key: 'capability' | 'op'): string {
  if (typeof raw !== 'object' || raw === null) return 'invalid'
  const value = (raw as Record<string, unknown>)[key]
  return typeof value === 'string' && /^[a-z]{1,32}$/.test(value) ? value : 'invalid'
}
