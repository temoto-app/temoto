/**
 * Ingestion for `aios.gmail` (TODO 952 stage 2, ARCHITECTURE 7.5). The body of the scheduled task `sync` (`scheduledTasks` in the manifest, `idle: true`).
 *
 * aios's `JobScheduler` calls it while no conversation is running, and keeps calling as long as it returns `more`. One call sends up to `REQUEST_BUDGET` requests —
 * it is not held long, and `retryAfterMs` spaces calls out (requests sent × `PACE_MS`) so the Broker limit (60 per minute) is not hit.
 * It keeps no position of its own: main stores the returned `state` in the encrypted DB and passes it back as the next argument (`SyncState`).
 *
 * Flow of one call:
 *   0. No credentials -> do nothing (`more: false`). No state -> take the historyId with `profile` and start a full ingestion.
 *   1. Diff: `history.list(startHistoryId)` — put added / relabeled ids into `pendingIds`; ids that disappeared are removed from the index.
 *      If the historyId is too old (404) -> fetch everything again from the new historyId.
 *   2. Fetch `pendingIds` in a batch and store them (drafts, spam and trash are dropped = tombstone).
 *   3. Full: `messages.list` newest first, one page (100 messages) at a time. `fullPageToken` advances only after the page is stored (so it resumes after a stop).
 * On 429 / a rate limit -> `retryAfterMs` doubles from 30 seconds (up to 15 minutes). On a Google 5xx -> 1 minute. On sign-out, main clears the state.
 */
import type { PluginApi, PluginTaskArg, PluginTaskResult, PluginTaskState } from '@shared/plugin.js'
import {
  Budget,
  fetchMessages,
  getJson,
  GMAIL_CREDENTIAL,
  HistoryExpired,
  historyUrl,
  isMessageId,
  listUrl,
  NotSignedIn,
  profileUrl,
  RateLimited,
  Transient,
  type HistoryList,
  type MessageList,
  type Profile
} from './gmail.js'
import { GMAIL_SOURCE, isSkipped, messageToDocument, messageUri, type GmailMessage } from './message.js'
import {
  evaluateMail,
  EXCLUDED_LABELS,
  parseTriggerSettings,
  recheckCarried,
  referenceText,
  threadUrl,
  TRIGGER_ID,
  type MailFacts,
  type MailGate,
  type TriggerSettings
} from './trigger.js'

/** Upper limit on the number of requests sent per call. */
export const REQUEST_BUDGET = 30
/** The wait left per request sent (about 48 per minute; leaves headroom for the tool under the Broker's 60 per minute). */
export const PACE_MS = 1250
export const LIST_PAGE = 100
/** Messages per batch request (a size that tends to fit in an 8 MB response; split if cut). */
export const BATCH_SIZE = 25
/** How many not-yet-fetched ids the state can hold (the state is limited to 16 KB). */
export const MAX_PENDING = 400
/** How many times in a row the same id may fail to be fetched (after that, give up; the next diff or refetch picks it up). */
export const MAX_FETCH_FAILURES = 3
/**
 * Fix V (code-review): the number of trigger notices that can be carried over, and the number of tries. When a notice is `unavailable` or throws, the mail is not refetched
 * (it is already in the index); only the notice is sent again next time. Notices past the try count or overflowing are dropped, with one log line (no body or subject).
 * The state is limited to 16 KB (`MAX_PLUGIN_TASK_STATE_BYTES`), so each entry keeps the subject and sender cut to `CARRY_TEXT` characters.
 * Before resending, it is judged again against the **current** settings, `disabledAt` and staleness (`recheckCarried`); mail that was deleted, moved to SPAM / TRASH, or lost INBOX / UNREAD
 * is first removed from the carry-over by the sync diff (`dropCarried`, security review).
 */
export const MAX_NOTIFY_CARRY = 10
export const MAX_NOTIFY_TRIES = 6
const CARRY_TEXT = 200
export const MIN_BACKOFF_MS = 30_000
export const MAX_BACKOFF_MS = 15 * 60_000
export const TRANSIENT_BACKOFF_MS = 60_000

export interface SyncState {
  readonly v: 1
  /** The signed-in account (display only; to switch accounts, main clears the state on sign-out). */
  readonly account: string
  /** The start position of the diff. Advances from the value at the time the full ingestion started. */
  readonly historyId: string | null
  /** The next page of the full ingestion. null = from the beginning. */
  readonly fullPageToken: string | null
  readonly fullDone: boolean
  /** The number stored (a rough measure of progress). */
  readonly fetched: number
  /** Ids not yet fetched (from the diff). */
  readonly pendingIds: readonly string[]
  /** Failure counts of ids that could not be fetched (only those in pendingIds). */
  readonly failures: Readonly<Record<string, number>>
  /** The previous wait time (the base that is doubled). */
  readonly backoffMs: number
  /** The ids in pendingIds that came as `messagesAdded` in the diff (= new mail; the targets of triggers. Neither the full ingestion nor label changes are included). */
  readonly newIds: readonly string[]
  /** The last time (ms) the trigger rule came back `disabled`. Mail that arrived before it is not announced even after the rule is enabled. */
  readonly disabledAt: number | null
  /** Fix V: new mail to announce again next time (it passed the rule; separate from fetch failures). */
  readonly notifyCarry: readonly CarriedNotice[]
}

/**
 * One carried-over notice. Only the material to rebuild the reference sentence and to judge again (`gate`: arrival time, whether it was Cc only, the authentication result) (no body is kept).
 * `tries` is the number of times the notice was attempted.
 */
export interface CarriedNotice {
  readonly facts: MailFacts
  readonly gate: MailGate
  readonly tries: number
}

/** A sender address longer than this is not carried over (it is used unsliced for the allow-list check; the RFC 5321 limit is 254). */
const MAX_CARRY_ADDRESS = 320

function parseCarry(raw: unknown): CarriedNotice[] {
  if (!Array.isArray(raw)) return []
  const out: CarriedNotice[] = []
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const facts = record['facts'] as Record<string, unknown> | undefined
    const gate = record['gate'] as Record<string, unknown> | undefined
    const tries = record['tries']
    if (typeof facts !== 'object' || facts === null) continue
    if (typeof gate !== 'object' || gate === null) continue
    const internalDate = gate['internalDate']
    if (typeof internalDate !== 'number' || !Number.isSafeInteger(internalDate)) continue
    if (typeof gate['ccOnly'] !== 'boolean' || typeof gate['authOk'] !== 'boolean') continue
    const str = (key: string): string | null => (typeof facts[key] === 'string' ? (facts[key] as string) : null)
    const subject = str('subject')
    const from = str('from')
    const fromAddress = str('fromAddress')
    const date = str('date')
    const threadId = str('threadId')
    const messageId = str('messageId')
    if (subject === null || from === null || fromAddress === null || date === null || threadId === null || messageId === null) continue
    if (!isMessageId(messageId) || !isMessageId(threadId) || fromAddress.length > MAX_CARRY_ADDRESS) continue
    if (typeof tries !== 'number' || !Number.isSafeInteger(tries) || tries < 1 || tries >= MAX_NOTIFY_TRIES) continue
    out.push({
      facts: compactFacts({ subject, from, fromAddress, date, threadId, messageId }),
      gate: { internalDate, ccOnly: gate['ccOnly'], authOk: gate['authOk'] },
      tries
    })
    if (out.length >= MAX_NOTIFY_CARRY) break
  }
  return out
}

function compactFacts(facts: MailFacts): MailFacts {
  const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text)
  return {
    subject: clip(facts.subject, CARRY_TEXT),
    from: clip(facts.from, CARRY_TEXT),
    // Used for the allow-list check, so it is not cut (one that is too long is not carried over — `MAX_CARRY_ADDRESS`).
    fromAddress: facts.fromAddress,
    date: clip(facts.date, 100),
    threadId: facts.threadId,
    messageId: facts.messageId
  }
}

/**
 * TODO 1225: read the narrowing settings from "Settings" in the extension's details (`configuration` in the manifest). Values are not logged.
 * Fix X (code-review): if they cannot be read (an exception or a broken shape), **null** — no trigger event is emitted that round (`notify` / `retryCarried`).
 * Falling back to the default (no allow-list) would start conversations from every sender even though the user restricted senders. Sync (ingestion) continues as is.
 */
async function readTriggerSettings(api: PluginApi): Promise<TriggerSettings | null> {
  let settings: TriggerSettings | null = null
  try {
    settings = parseTriggerSettings(await api.settings.get())
  } catch {
    settings = null
  }
  if (settings === null) logLine('gmail.trigger.settings.unreadable', {})
  return settings
}

/**
 * The judgment for carrying new mail over in a round where settings cannot be read (fix X). The three settings-dependent checks (Cc only, allow-list, authentication) are passed, and the material is left in `gate`
 * so the next round judges again with the **current settings** (`recheckCarried` checks all three). No event is emitted this round.
 */
const UNSETTLED_SETTINGS: TriggerSettings = { allowFrom: null, includeCc: true, requireAuth: false }

/** One log line that carries no values (plugin-host's stdout -> main reassembles it into a `plugin:<id>` line). */
function logLine(event: string, fields: Record<string, number | string>): void {
  console.log(JSON.stringify({ level: 'info', event, ...fields }))
}

export function parseState(raw: PluginTaskState | null): SyncState | null {
  if (raw === null || raw['v'] !== 1) return null
  const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
  const pending = Array.isArray(raw['pendingIds'])
    ? (raw['pendingIds'] as unknown[]).filter((id): id is string => typeof id === 'string' && isMessageId(id))
    : []
  const fetched = raw['fetched']
  const backoff = raw['backoffMs']
  const failures: Record<string, number> = {}
  const rawFailures = raw['failures']
  if (typeof rawFailures === 'object' && rawFailures !== null && !Array.isArray(rawFailures)) {
    for (const [id, count] of Object.entries(rawFailures as Record<string, unknown>)) {
      if (isMessageId(id) && pending.includes(id) && typeof count === 'number' && Number.isSafeInteger(count) && count > 0) failures[id] = count
    }
  }
  return {
    v: 1,
    failures,
    account: text(raw['account']) ?? '',
    historyId: text(raw['historyId']),
    fullPageToken: text(raw['fullPageToken']),
    fullDone: raw['fullDone'] === true,
    fetched: typeof fetched === 'number' && Number.isSafeInteger(fetched) && fetched >= 0 ? fetched : 0,
    pendingIds: pending.slice(0, MAX_PENDING),
    backoffMs: typeof backoff === 'number' && Number.isFinite(backoff) && backoff >= 0 ? backoff : 0,
    newIds: Array.isArray(raw['newIds'])
      ? (raw['newIds'] as unknown[]).filter((id): id is string => typeof id === 'string' && pending.includes(id))
      : [],
    disabledAt: typeof raw['disabledAt'] === 'number' && Number.isFinite(raw['disabledAt']) ? raw['disabledAt'] : null,
    notifyCarry: parseCarry(raw['notifyCarry'])
  }
}

function toTaskState(state: SyncState): PluginTaskState {
  return {
    ...state,
    pendingIds: [...state.pendingIds],
    failures: { ...state.failures },
    newIds: [...state.newIds],
    notifyCarry: state.notifyCarry.map((item) => ({ facts: { ...item.facts }, gate: { ...item.gate }, tries: item.tries }))
  }
}

/** A working copy rewritten between calls. */
interface Work {
  account: string
  historyId: string | null
  fullPageToken: string | null
  fullDone: boolean
  fetched: number
  pending: string[]
  failures: Record<string, number>
  backoffMs: number
  newIds: string[]
  disabledAt: number | null
  /**
   * The trigger narrowing settings (TODO 1217 / 1225). **Not kept in the state** — read at the start of a round from `api.settings.get()` ("Settings" in the extension's details).
   * A change by the user takes effect from the next round (resending carried-over notices is also judged against the current settings). Null is a round where they could not be read (no event is emitted — fix X).
   */
  triggerSettings: TriggerSettings | null
  notifyCarry: CarriedNotice[]
  /** The diff has more pages. */
  historyMore: boolean
}

function snapshot(work: Work): SyncState {
  const pendingIds = work.pending.slice(0, MAX_PENDING)
  const failures: Record<string, number> = {}
  for (const id of pendingIds) {
    const count = work.failures[id]
    if (count !== undefined) failures[id] = count
  }
  return {
    failures,
    v: 1,
    account: work.account,
    historyId: work.historyId,
    fullPageToken: work.fullPageToken,
    fullDone: work.fullDone,
    fetched: work.fetched,
    pendingIds,
    backoffMs: work.backoffMs,
    newIds: work.newIds.filter((id) => pendingIds.includes(id)),
    disabledAt: work.disabledAt,
    notifyCarry: work.notifyCarry.slice(0, MAX_NOTIFY_CARRY)
  }
}

function addPending(work: Work, id: string | undefined, isNew = false): void {
  if (id === undefined || !isMessageId(id)) return
  if (isNew && !work.newIds.includes(id)) work.newIds.push(id)
  if (work.pending.includes(id)) return
  work.pending.push(id)
}

async function removeDocument(api: PluginApi, id: string): Promise<void> {
  await api.index.remove(GMAIL_SOURCE, id)
}

/** The material for announcing triggers (the ids of new mail, the rule, and the clock). Not passed in a full ingestion. */
interface TriggerContext {
  readonly work: Work
  readonly fresh: ReadonlySet<string>
  readonly now: () => number
}

/**
 * Announce one message that passed the rule with `api.triggers.emit`. The return value says whether to announce it again next time.
 * `duplicate` / `accepted` / `daily-cap` / `invalid` are settled. `disabled` remembers the time and settles (so old mail is not emitted after the rule is enabled).
 * `unavailable` and a Broker exception (such as no consent) are carried over (fix V: the mail is not refetched — `notifyCarry`).
 */
async function emitNotice(api: PluginApi, work: Work, facts: MailFacts, now: number): Promise<boolean> {
  try {
    const result = await api.triggers.emit({
      trigger: TRIGGER_ID,
      key: facts.threadId,
      title: facts.subject === '' ? '(no subject)' : facts.subject,
      url: threadUrl(work.account, facts.threadId),
      prompt: referenceText(facts, messageUri(facts.threadId, facts.messageId))
    })
    if (result.accepted) return false
    if (result.reason === 'disabled') work.disabledAt = now
    return result.reason === 'unavailable'
  } catch {
    return true
  }
}

/** Push onto the carry-over. Overflow is dropped with one log line (no values). */
function carryNotice(work: Work, facts: MailFacts, gate: MailGate, tries: number): void {
  if (tries >= MAX_NOTIFY_TRIES) {
    logLine('gmail.trigger.carry.dropped', { reason: 'tries', tries })
    return
  }
  if (facts.fromAddress.length > MAX_CARRY_ADDRESS) {
    logLine('gmail.trigger.carry.dropped', { reason: 'shape' })
    return
  }
  if (work.notifyCarry.some((item) => item.facts.messageId === facts.messageId)) return
  if (work.notifyCarry.length >= MAX_NOTIFY_CARRY) {
    logLine('gmail.trigger.carry.dropped', { reason: 'full', carried: work.notifyCarry.length })
    return
  }
  work.notifyCarry.push({ facts: compactFacts(facts), gate, tries })
}

/** Remove from the carry-over mail whose sync diff shows it no longer qualifies for a notice (deleted, SPAM / TRASH, or INBOX / UNREAD removed). */
function dropCarried(work: Work, id: string, reason: string): void {
  const before = work.notifyCarry.length
  work.notifyCarry = work.notifyCarry.filter((item) => item.facts.messageId !== id)
  if (work.notifyCarry.length !== before) logLine('gmail.trigger.carry.dropped', { reason })
}

/** Whether one label change invalidates a carried-over notice (checks both the labels after the change and the added / removed labels). */
function labelsInvalidate(
  current: readonly string[] | undefined,
  changed: readonly string[] | undefined,
  removed: boolean
): boolean {
  if (current !== undefined) {
    if (!current.includes('INBOX') || !current.includes('UNREAD')) return true
    if (isSkipped(current) || current.some((label) => EXCLUDED_LABELS.includes(label))) return true
  }
  const labels = changed ?? []
  if (removed) return labels.includes('INBOX') || labels.includes('UNREAD')
  return isSkipped(labels) || labels.some((label) => EXCLUDED_LABELS.includes(label))
}

/** Check one new message against the rule, and announce it if it passes. If the notice does not get through, carry it over (it does not count as a fetch failure). */
async function notify(api: PluginApi, ctx: TriggerContext, message: GmailMessage): Promise<void> {
  const { work } = ctx
  const now = ctx.now()
  if (work.triggerSettings === null) {
    // Fix X: in a round where settings cannot be read, do not announce; carry over and judge again next round with the current settings.
    const unsettled = evaluateMail(message, work.account, UNSETTLED_SETTINGS, now, work.disabledAt ?? 0)
    if (unsettled.pass) carryNotice(work, unsettled.facts, unsettled.gate, 1)
    return
  }
  const verdict = evaluateMail(message, work.account, work.triggerSettings, now, work.disabledAt ?? 0)
  if (!verdict.pass) return
  if (await emitNotice(api, work, verdict.facts, now)) carryNotice(work, verdict.facts, verdict.gate, 1)
}

/**
 * Fix V: send again the notices carried over from the previous round. It does not query Gmail (no request budget is used). **Call it after the sync diff**
 * (so deleted and relabeled mail is removed first). Before sending, it judges again against the current settings, `disabledAt` and staleness; anything that fails is dropped with one log line.
 * If it does not get through, the try count is incremented and the entry stays; on reaching `MAX_NOTIFY_TRIES` it is dropped with one log line.
 */
async function retryCarried(api: PluginApi, work: Work, now: number): Promise<void> {
  const carried = work.notifyCarry
  const settings = work.triggerSettings
  // Fix X: do not resend in a round where settings cannot be read (the carry-over stays as is and is judged again next round with the current settings).
  if (carried.length === 0 || settings === null) return
  work.notifyCarry = []
  for (const item of carried) {
    const verdict = recheckCarried(item.facts.fromAddress, item.gate, settings, now, work.disabledAt ?? 0)
    if (!verdict.pass) {
      logLine('gmail.trigger.carry.dropped', { reason: verdict.reason })
      continue
    }
    if (await emitNotice(api, work, item.facts, now)) carryNotice(work, item.facts, item.gate, item.tries + 1)
  }
}

/** Store what was fetched (dropping what is not ingested). Returns the number stored, the ids that are settled, and the ids to try again. */
async function store(
  api: PluginApi,
  budget: Budget,
  ids: readonly string[],
  ctx: TriggerContext | null = null
): Promise<{ stored: number; handled: Set<string> }> {
  let stored = 0
  const handled = new Set<string>()
  const fetched = await fetchMessages(api, budget, ids)
  for (const item of fetched) {
    if ('missing' in item) {
      handled.add(item.id)
      await removeDocument(api, item.id)
      continue
    }
    const document = messageToDocument(item.message)
    if (document === null) await removeDocument(api, item.id)
    else {
      await api.index.put(document)
      stored += 1
      // Announce after putting it in the index (so the model can already read it when a conversation is started). Even if the notice does not get through, the id is settled
      // (not refetched — only the notice is carried over in `notifyCarry`. Fix V).
      if (ctx !== null && ctx.fresh.has(item.id)) await notify(api, ctx, item.message)
    }
    handled.add(item.id)
  }
  return { stored, handled }
}

/** The diff. Read `history` pages, collect the ids to fetch, and remove what disappeared. */
async function syncHistory(api: PluginApi, budget: Budget, work: Work): Promise<void> {
  let pageToken: string | null = null
  work.historyMore = false
  while (work.historyId !== null && budget.left > 1) {
    const page: HistoryList = await getJson<HistoryList>(api, budget, historyUrl(work.historyId, pageToken), () => new HistoryExpired())
    let lastRecord: string | null = null
    for (const record of page.history ?? []) {
      const saved = work.pending.slice()
      const savedNew = work.newIds.slice()
      for (const entry of record.messagesAdded ?? []) {
        const id = entry.message?.id
        if (isSkipped(entry.message?.labelIds)) {
          if (id !== undefined && isMessageId(id)) await removeDocument(api, id)
        } else addPending(work, id, true)
      }
      // Fix V: remove from the carried-over notices those that no longer qualify (SPAM / TRASH or category, INBOX / UNREAD removed).
      for (const [entries, removed] of [
        [record.labelsAdded ?? [], false],
        [record.labelsRemoved ?? [], true]
      ] as const) {
        for (const entry of entries) {
          const id = entry.message?.id
          if (id !== undefined && labelsInvalidate(entry.message?.labelIds, entry.labelIds, removed)) dropCarried(work, id, 'labels')
        }
      }
      for (const entry of [...(record.labelsAdded ?? []), ...(record.labelsRemoved ?? [])]) {
        const id = entry.message?.id
        if (isSkipped(entry.message?.labelIds)) {
          if (id !== undefined && isMessageId(id)) await removeDocument(api, id)
        } else addPending(work, id)
      }
      for (const entry of record.messagesDeleted ?? []) {
        const id = entry.message?.id
        if (id !== undefined && isMessageId(id)) {
          await removeDocument(api, id)
          work.pending = work.pending.filter((pending) => pending !== id)
          work.newIds = work.newIds.filter((fresh) => fresh !== id)
          dropCarried(work, id, 'deleted')
        }
      }
      if (saved.length > 0 && work.pending.length > MAX_PENDING) {
        // Adding this record would overflow (snapshot would silently truncate). Stop before the record and continue from there next round.
        work.pending = saved
        work.newIds = savedNew
        if (lastRecord !== null) work.historyId = lastRecord
        work.historyMore = true
        return
      }
      if (record.id !== undefined) lastRecord = record.id
      if (work.pending.length >= MAX_PENDING) break
    }
    if (work.pending.length >= MAX_PENDING) {
      // It cannot all be held. Re-read from the last processed record next round (reading the same record again gives the same result).
      if (lastRecord !== null) work.historyId = lastRecord
      work.historyMore = true
      return
    }
    if (page.nextPageToken === undefined) {
      if (page.historyId !== undefined) work.historyId = page.historyId
      return
    }
    pageToken = page.nextPageToken
    if (budget.left <= 1) {
      // The budget ran out in the middle of a page. Continue next round from the last record fully read.
      if (lastRecord !== null) work.historyId = lastRecord
      work.historyMore = true
      return
    }
  }
}

async function fetchPending(api: PluginApi, budget: Budget, work: Work, now: () => number): Promise<void> {
  // Ids that could not be fetched go to the back and are tried only once each this round. Give up when failures reach MAX_FETCH_FAILURES.
  const attempted = new Set<string>()
  while (work.pending.length > 0 && budget.left > 0 && !attempted.has(work.pending[0] ?? '')) {
    const ids = work.pending.slice(0, BATCH_SIZE)
    const { stored, handled } = await store(api, budget, ids, { work, fresh: new Set(work.newIds), now })
    work.fetched += stored
    const failed: string[] = []
    for (const id of ids) {
      attempted.add(id)
      if (handled.has(id)) {
        delete work.failures[id]
        work.newIds = work.newIds.filter((fresh) => fresh !== id)
        continue
      }
      const count = (work.failures[id] ?? 0) + 1
      if (count >= MAX_FETCH_FAILURES) {
        delete work.failures[id]
        work.newIds = work.newIds.filter((fresh) => fresh !== id)
      }
      else {
        work.failures[id] = count
        failed.push(id)
      }
    }
    work.pending = [...work.pending.slice(ids.length), ...failed]
  }
}

/** Store one page of the full ingestion. Advance the page only after it is stored. */
async function syncFullPage(api: PluginApi, budget: Budget, work: Work): Promise<void> {
  const list = await getJson<MessageList>(api, budget, listUrl(work.fullPageToken, LIST_PAGE))
  const ids = (list.messages ?? []).map((message) => message.id).filter((id): id is string => id !== undefined && isMessageId(id))
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    work.fetched += (await store(api, budget, ids.slice(i, i + BATCH_SIZE))).stored
  }
  if (list.nextPageToken === undefined) {
    work.fullDone = true
    work.fullPageToken = null
  } else work.fullPageToken = list.nextPageToken
}

/** The remaining budget needed to start one page (one list request + batches). */
const PAGE_COST = 1 + Math.ceil(LIST_PAGE / BATCH_SIZE) + 1

export async function runSync(
  arg: PluginTaskArg,
  api: PluginApi,
  budgetLimit: number = REQUEST_BUDGET,
  now: () => number = Date.now
): Promise<PluginTaskResult> {
  const credential = await api.credentials.status(GMAIL_CREDENTIAL)
  if (!credential.present) return { more: false }
  const budget = new Budget(budgetLimit)
  const previous = parseState(arg.state)
  const work: Work = {
    account: previous?.account ?? '',
    historyId: previous?.historyId ?? null,
    fullPageToken: previous?.fullPageToken ?? null,
    fullDone: previous?.fullDone ?? false,
    fetched: previous?.fetched ?? 0,
    pending: [...(previous?.pendingIds ?? [])],
    failures: { ...(previous?.failures ?? {}) },
    backoffMs: previous?.backoffMs ?? 0,
    newIds: [...(previous?.newIds ?? [])],
    disabledAt: previous?.disabledAt ?? null,
    triggerSettings: await readTriggerSettings(api),
    notifyCarry: [...(previous?.notifyCarry ?? [])],
    historyMore: false
  }
  try {
    if (previous === null) {
      // Take the historyId from before the full ingestion starts — the diff picks up what arrived during ingestion.
      const profile = await getJson<Profile>(api, budget, profileUrl())
      work.account = profile.emailAddress ?? ''
      work.historyId = profile.historyId ?? null
    } else {
      try {
        await syncHistory(api, budget, work)
      } catch (err) {
        if (!(err instanceof HistoryExpired)) throw err
        // The start position is too old. Fetch everything again from the new position (tombstones for mail that disappeared are missed for this interval only).
        const profile = await getJson<Profile>(api, budget, profileUrl())
        work.historyId = profile.historyId ?? null
        work.fullPageToken = null
        work.fullDone = false
        work.pending = []
        work.newIds = []
        work.failures = {}
      }
    }
    // Fix V: resend carried-over notices after the diff (deletions and label changes) has been applied (no Gmail requests are used).
    await retryCarried(api, work, now())
    await fetchPending(api, budget, work, now)
    while (!work.fullDone && budget.left >= PAGE_COST) await syncFullPage(api, budget, work)
  } catch (err) {
    if (err instanceof NotSignedIn) return { state: toTaskState(snapshot(work)), more: false }
    if (err instanceof RateLimited) {
      const backoffMs = err.local
        ? TRANSIENT_BACKOFF_MS
        : Math.min(Math.max(work.backoffMs * 2, MIN_BACKOFF_MS), MAX_BACKOFF_MS)
      work.backoffMs = err.local ? work.backoffMs : backoffMs
      return { state: toTaskState(snapshot(work)), more: true, retryAfterMs: backoffMs }
    }
    if (err instanceof Transient) {
      return { state: toTaskState(snapshot(work)), more: true, retryAfterMs: TRANSIENT_BACKOFF_MS }
    }
    throw err
  }
  work.backoffMs = 0
  const more = !work.fullDone || work.pending.length > 0 || work.historyMore
  return {
    state: toTaskState(snapshot(work)),
    more,
    ...(more ? { retryAfterMs: budget.used * PACE_MS } : {})
  }
}
