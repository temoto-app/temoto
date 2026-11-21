/**
 * Item 317 (wave 17 bundle B): shows the remaining 5-hour / 7-day usage limits in the same form as the VS Code extension.
 *
 * - main aggregation (`UsageTracker`): the latest single entry for the whole app. The number and time are kept in `app_settings` (`usage.lastSnapshot`, owner main),
 *   and right after launch it is shown from there. A `rate_limit` without a window is ignored.
 * - storage (`ThreadStore.toPersistable`): only the `rejected` and pay-as-you-go rows are kept; usage percentages (`windows`) are dropped.
 * - timeline: the row 'usage: allowed_warning' is no longer shown. Only the limit (`rejected`) and the switch to pay-as-you-go. Already-saved
 *   `allowed_warning` rows draw nothing (they do not break).
 * - display pure functions (% / horizontal bar / Resets in / n min ago). Drawing is in `usage-badge.test.ts` (jsdom).
 *
 * Real SQLite (in memory). Neither the model nor Electron is used.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import type { AiosEvent, AiosEventBatch, RateLimitPayload } from '../src/shared/agent.js'
import { parseUsageSnapshot, usageNeedsAttention, type UsageSnapshot } from '../src/shared/usage.js'
import { parseEvent } from '../src/main/session/adapter/parse.js'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { USAGE_LAST_SNAPSHOT } from '../src/common/settings-keys.js'
import { ThreadStore } from '../src/main/session/store.js'
import { UsageTracker } from '../src/main/usage.js'
import { foldTimeline } from '../src/renderer/src/thread/timeline.js'
import { translate, type Translate } from '../src/renderer/src/i18n/index.js'
import {
  formatReceivedAgo,
  formatResetsIn,
  isWindowReset,
  usageBadgeParts,
  usageBadgeText,
  usageBarWidth,
  usagePercent,
  usagePercentLabel
} from '../src/renderer/src/usage-format.js'
import { en } from '../src/renderer/src/i18n/en.js'
import { ja } from '../src/renderer/src/i18n/ja.js'

const tEn: Translate = (key, params) => translate('en', key, params)
const tJa: Translate = (key, params) => translate('ja', key, params)

let counter = 0
const ctx = {
  sessionId: 'session-1',
  threadId: 'thread-1',
  now: () => 1_700_000_000_000,
  newId: () => `e${(counter += 1)}`
}

/** The rate_limit_event from the real 2.1.280 (builtins.jsonl). */
function realRateLimits(): AiosEvent[] {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'builtins.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.includes('"rate_limit_event"'))
    .flatMap((line) => [...parseEvent(line, ctx)])
}

function rateLimit(payload: RateLimitPayload): AiosEvent {
  counter += 1
  return {
    id: `r${counter}`,
    sessionId: 'session-1',
    threadId: 'thread-1',
    ts: 1_700_000_000_000 + counter,
    actor: 'main',
    kind: 'rate_limit',
    payload
  }
}

const batch = (events: AiosEvent[]): AiosEventBatch => ({ events, at: 0 })

function openDb(): Db {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

beforeEach(() => {
  counter = 0
})

describe('UsageTracker — アプリ全体で最新の 1 件 (項目 317)', () => {
  let db: Db
  let settings: AppSettingsStore
  beforeEach(() => {
    db = openDb()
    settings = new AppSettingsStore(db)
  })
  afterEach(() => db.close())

  it('実物の rate_limit から拾い、最後の 1 件を全窓へ・app_settings へ。数値と時刻だけ', () => {
    const pushed: UsageSnapshot[] = []
    const tracker = new UsageTracker(settings, (s) => pushed.push(s), () => 1_790_440_000_000)
    expect(tracker.get()).toBeNull()
    tracker.observe(batch(realRateLimits()))
    const expected: UsageSnapshot = {
      fiveHour: { utilization: 0.26, resetsAt: 1790446800 },
      sevenDay: { utilization: 0.22, resetsAt: 1790798400 },
      status: 'allowed',
      usingOverage: false,
      receivedAt: 1_790_440_000_000
    }
    // Even with 3 entries in the bundle, push happens only once, with the latest
    expect(pushed).toEqual([expected])
    expect(tracker.get()).toEqual(expected)
    const raw = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('usage.lastSnapshot') as {
      value: string
    }
    expect(JSON.parse(raw.value)).toEqual(expected)
    // After a restart it is shown from the saved copy ('value from n min ago')
    expect(new UsageTracker(settings).get()).toEqual(expected)
  })

  it('Fable の週の窓 (TODO 1000) は Fable のターンの行で入り、他のターンで消えず受けた時刻を保つ', () => {
    const fableLine = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rate-limit-fable-2.1.310.jsonl'),
      'utf8'
    ).trim()
    const fableEvents = [...parseEvent(fableLine, ctx)]
    let clock = 1_000
    const tracker = new UsageTracker(settings, () => undefined, () => clock)
    tracker.observe(batch(fableEvents))
    expect(tracker.get()?.sevenDayFable).toEqual({ utilization: 0.07, resetsAt: 1793217600 })
    expect(tracker.get()?.sevenDayFableReceivedAt).toBe(1_000)
    // A Sonnet turn (no third key): keep the previous Fable value and the time it was received
    clock = 9_000
    tracker.observe(batch(realRateLimits()))
    const kept = tracker.get()
    expect(kept?.receivedAt).toBe(9_000)
    expect(kept?.sevenDayFable).toEqual({ utilization: 0.07, resetsAt: 1793217600 })
    expect(kept?.sevenDayFableReceivedAt).toBe(1_000)
    // Still kept after a restart
    expect(new UsageTracker(settings).get()).toEqual(kept)
  })

  it('同じ束で先の行だけが Fable の窓を持つとき、その新しい値を使う (TODO 1000)', () => {
    const settings = new AppSettingsStore(openDb())
    const tracker = new UsageTracker(settings, () => undefined, () => 7_000)
    const fresh = { utilization: 0.5, resetsAt: 1793217600 }
    tracker.observe(
      batch([
        rateLimit({ status: 'allowed', windowType: null, resetsAt: null, usingOverage: false, windows: { fiveHour: { utilization: 0.1, resetsAt: 1 }, sevenDayFable: fresh } }),
        rateLimit({ status: 'allowed', windowType: null, resetsAt: null, usingOverage: false, windows: { fiveHour: { utilization: 0.2, resetsAt: 1 } } })
      ])
    )
    expect(tracker.get()?.sevenDayFable).toEqual(fresh)
    expect(tracker.get()?.sevenDayFableReceivedAt).toBe(7_000)
    expect(tracker.get()?.fiveHour?.utilization).toBe(0.2)
  })

  it('Fable の窓が一度も来ていなければ欄を持たない (古い版)', () => {
    const tracker = new UsageTracker(settings, () => undefined, () => 5)
    tracker.observe(batch(realRateLimits()))
    expect(tracker.get()).not.toHaveProperty('sevenDayFable')
    expect(tracker.get()).not.toHaveProperty('sevenDayFableReceivedAt')
  })

  it('窓の無い rate_limit (古い版) と他の種別は無視する', () => {
    const pushed: UsageSnapshot[] = []
    const tracker = new UsageTracker(settings, (s) => pushed.push(s))
    tracker.observe(
      batch([rateLimit({ status: 'allowed_warning', windowType: 'five_hour', resetsAt: 1, usingOverage: false })])
    )
    expect(pushed).toEqual([])
    expect(tracker.get()).toBeNull()
    expect(settings.readTyped(USAGE_LAST_SNAPSHOT)).toBeNull()
  })

  it('鍵は owner main で往復し、壊れた値・窓の無い値は null', () => {
    expect(USAGE_LAST_SNAPSHOT.key).toBe('usage.lastSnapshot')
    expect(USAGE_LAST_SNAPSHOT.owner).toBe('main')
    const value: UsageSnapshot = {
      sevenDay: { utilization: 0.5, resetsAt: null },
      status: 'rejected',
      usingOverage: true,
      receivedAt: 5
    }
    expect(USAGE_LAST_SNAPSHOT.parse(USAGE_LAST_SNAPSHOT.serialize(value))).toEqual(value)
    expect(USAGE_LAST_SNAPSHOT.parse(null)).toBeNull()
    expect(USAGE_LAST_SNAPSHOT.parse('not json')).toBeNull()
    expect(USAGE_LAST_SNAPSHOT.parse(JSON.stringify({ status: 'allowed', receivedAt: 1 }))).toBeNull()
    expect(parseUsageSnapshot({ fiveHour: { utilization: -1 }, status: 'x', receivedAt: 1 })).toBeNull()
  })

  it('警告色: allowed_warning / rejected / 従量', () => {
    expect(usageNeedsAttention({ status: 'allowed', usingOverage: false })).toBe(false)
    expect(usageNeedsAttention({ status: 'allowed_warning', usingOverage: false })).toBe(true)
    expect(usageNeedsAttention({ status: 'rejected', usingOverage: false })).toBe(true)
    expect(usageNeedsAttention({ status: 'allowed', usingOverage: true })).toBe(true)
  })
})

describe('保存とタイムライン — 「使用量: …」の行は上限と従量への切り替わりだけ (項目 317)', () => {
  let db: Db
  let store: ThreadStore
  beforeEach(() => {
    db = openDb()
    store = new ThreadStore(db, '/Users/tester')
    store.createThread({
      id: 'thread-1',
      title: 't',
      cwd: '/Users/tester/work',
      allowedDirs: [],
      retention: 'forever',
      backend: 'agent-cli',
      modelId: null,
      thinking: null
    })
  })
  afterEach(() => db.close())

  const windows = { fiveHour: { utilization: 0.9, resetsAt: 10 } }

  it('allowed / allowed_warning は溜めない。rejected と従量の行は使用率を落として残す', () => {
    const thread = store.getThread('thread-1')!
    store.appendEvents(thread, 'session-1', [
      ...realRateLimits(),
      rateLimit({ status: 'allowed_warning', windowType: 'five_hour', resetsAt: 1, usingOverage: false, windows }),
      rateLimit({ status: 'rejected', windowType: 'five_hour', resetsAt: 2, usingOverage: false, windows }),
      rateLimit({ status: 'allowed', windowType: 'five_hour', resetsAt: 3, usingOverage: true, windows })
    ])
    const rows = db.prepare('SELECT kind, payload FROM thread_events ORDER BY seq').all() as {
      kind: string
      payload: string
    }[]
    expect(rows.map((r) => r.kind)).toEqual(['rate_limit', 'rate_limit'])
    const payloads = rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>)
    expect(payloads.map((p) => p['status'])).toEqual(['rejected', 'allowed'])
    expect(payloads.every((p) => !('windows' in p))).toBe(true)
  })

  it('タイムライン: 毎ターンの行は描かず、rejected と従量への切り替わり (false → true) だけ印を付ける', () => {
    const events = [
      ...realRateLimits(),
      rateLimit({ status: 'allowed_warning', windowType: 'five_hour', resetsAt: 1, usingOverage: false }),
      rateLimit({ status: 'allowed', windowType: 'five_hour', resetsAt: 1, usingOverage: true }),
      rateLimit({ status: 'allowed', windowType: 'five_hour', resetsAt: 1, usingOverage: true }),
      rateLimit({ status: 'rejected', windowType: 'five_hour', resetsAt: 1, usingOverage: true })
    ]
    const notices = foldTimeline(events).items.flatMap((item) =>
      item.kind === 'rate_limit' ? [item.notice] : []
    )
    // All items remain for the position (progress's afterId)
    expect(notices).toEqual([null, null, null, null, 'overage', null, 'rejected'])
  })

  it('既に保存された allowed_warning の行 (項目 317 より前) は印なしで畳まれる (壊れない)', () => {
    const old = rateLimit({ status: 'allowed_warning', windowType: 'five_hour', resetsAt: 1, usingOverage: false })
    const [item] = foldTimeline([old]).items
    expect(item?.kind === 'rate_limit' && item.notice).toBeNull()
  })
})

describe('表示の純関数 (項目 317)', () => {
  it('% は四捨五入、横棒は 100 で切る', () => {
    const now = 1_000_000_000_000
    expect(usagePercent({ utilization: 0.126, resetsAt: null })).toBe(13)
    expect(usagePercent({ utilization: 1.04, resetsAt: null })).toBe(104)
    expect(usageBarWidth({ utilization: 1.04, resetsAt: null }, now)).toBe(100)
    expect(usagePercent({ utilization: Number.NaN, resetsAt: null })).toBe(0)
  })

  it('Resets in: 分 / 時間 / 日。過ぎていれば null、時刻不明も null', () => {
    const now = 1_000_000_000_000
    const s = now / 1000
    expect(formatResetsIn(s + 30, now, tEn)).toBe('Resets in 1m')
    expect(formatResetsIn(s + 3600 + 120, now, tEn)).toBe('Resets in 1h')
    expect(formatResetsIn(s + 6 * 86400 + 3600, now, tEn)).toBe('Resets in 6d')
    expect(formatResetsIn(s + 6 * 86400 + 3600, now, tJa)).toBe('あと 6 日 でリセット')
    expect(formatResetsIn(null, now, tEn)).toBeNull()
  })

  it('resetsAt を過ぎた窓は「リセット済み」(TODO 333-1 の小さな観察): 古い % を出さず、横棒 0、Resets が「Reset」', () => {
    const now = 1_000_000_000_000
    const s = now / 1000
    // A window that passed 1 second ago and one that passed 20 hours ago are both treated as passed (old percentages are not kept showing)
    expect(isWindowReset(s - 1, now)).toBe(true)
    expect(isWindowReset(s - 20 * 3600, now)).toBe(true)
    expect(isWindowReset(s + 1, now)).toBe(false)
    expect(isWindowReset(null, now)).toBe(false)

    const stale = { utilization: 0.3, resetsAt: s - 20 * 3600 }
    expect(usagePercentLabel(stale, now, tEn)).toBe(en['usage.percentUnknown'])
    expect(usagePercentLabel(stale, now, tJa)).toBe(ja['usage.percentUnknown'])
    expect(usageBarWidth(stale, now)).toBe(0)
    expect(formatResetsIn(stale.resetsAt, now, tEn)).toBe(en['usage.reset'])
    expect(formatResetsIn(stale.resetsAt, now, tJa)).toBe(ja['usage.reset'])

    // If the window has not reset, the percentage and horizontal bar show as before
    const fresh = { utilization: 0.3, resetsAt: s + 3600 }
    expect(usagePercentLabel(fresh, now, tEn)).toBe('30% used')
    expect(usageBarWidth(fresh, now)).toBe(30)
  })

  it('n 分前の値', () => {
    const now = 1_000_000_000_000
    expect(formatReceivedAgo(now - 10_000, now, tEn)).toBe(en['usage.received.justNow'])
    expect(formatReceivedAgo(now - 5 * 60_000, now, tJa)).toBe('5 分前の値')
    expect(formatReceivedAgo(now - 3 * 3_600_000, now, tEn)).toBe('As of 3 h ago')
    expect(formatReceivedAgo(now - 2 * 86_400_000, now, tJa)).toBe('2 日前の値')
  })

  it('BottomBar の札は `5h 11% · 7d 1%`。窓が無ければ null', () => {
    const now = 1_000_000_000_000
    expect(
      usageBadgeText(
        { fiveHour: { utilization: 0.11, resetsAt: null }, sevenDay: { utilization: 0.01, resetsAt: null } },
        now,
        tEn
      )
    ).toBe('5h 11% · 7d 1%')
    expect(usageBadgeText({ sevenDay: { utilization: 0.4, resetsAt: null } }, now, tJa)).toBe('7d 40%')
    expect(usageBadgeText({}, now, tEn)).toBeNull()
  })

  it('札も resetsAt を過ぎた窓は古い % を出さず `5h —` (TODO 333-1 の小さな観察)', () => {
    const now = 1_000_000_000_000
    const s = now / 1000
    expect(
      usageBadgeText(
        { fiveHour: { utilization: 0.3, resetsAt: s - 20 * 3600 }, sevenDay: { utilization: 0.05, resetsAt: s + 3600 } },
        now,
        tEn
      )
    ).toBe('5h — · 7d 5%')
  })

  it('TODO 377: 札の窓ごとの部品 (usageBadgeParts) — 棒の幅は usagePercent に比例、リセット済みは null (非表示)', () => {
    const now = 1_000_000_000_000
    const s = now / 1000
    const parts = usageBadgeParts(
      { fiveHour: { utilization: 0.15, resetsAt: s + 3600 }, sevenDay: { utilization: 0.17, resetsAt: s + 86400 } },
      now,
      tEn
    )
    expect(parts).toEqual([
      { key: 'fiveHour', label: '5h 15%', barWidth: 15 },
      { key: 'sevenDay', label: '7d 17%', barWidth: 17 }
    ])
    // usageBadgeText equals the labels of usageBadgeParts joined with ' · '
    expect(
      usageBadgeText(
        { fiveHour: { utilization: 0.15, resetsAt: s + 3600 }, sevenDay: { utilization: 0.17, resetsAt: s + 86400 } },
        now,
        tEn
      )
    ).toBe(parts.map((p) => p.label).join(' · '))
    // A window that has reset shows no bar (null, not 0)
    const withReset = usageBadgeParts(
      { fiveHour: { utilization: 0.3, resetsAt: s - 1 }, sevenDay: { utilization: 0.05, resetsAt: s + 3600 } },
      now,
      tEn
    )
    expect(withReset[0]).toEqual({ key: 'fiveHour', label: '5h —', barWidth: null })
    expect(withReset[1]).toEqual({ key: 'sevenDay', label: '7d 5%', barWidth: 5 })
    // No windows gives an empty array
    expect(usageBadgeParts({}, now, tEn)).toEqual([])
  })

  it('辞書: usage. の鍵が EN / JA の両方にあり、製品名を含まない', () => {
    const keys = Object.keys(ja).filter((k) => k.startsWith('usage.'))
    expect(keys.length).toBeGreaterThan(10)
    for (const key of keys) expect(key in en).toBe(true)
    for (const text of [...keys.map((k) => (en as Record<string, string>)[k]), ...keys.map((k) => (ja as Record<string, string>)[k])]) {
      expect(text).not.toMatch(/claude|anthropic/i)
    }
  })
})
