/**
 * Startup import of conversation events (item 76, ARCHITECTURE.md 6.2.3).
 *
 * What it keeps:
 * - Sends only what is after the high-water mark. A full import happens only on the first run, when rowids are renumbered, and every 7 days
 * - The high-water mark advances **only by what the index process has finished handling** (sending alone does not advance it)
 * - Once shutdown has started, it does not send and does not write settings (12.9)
 */
import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_FULL_INTERVAL_MS,
  CONVERSATION_HIGH_WATER_KEY,
  CONVERSATION_LAST_FULL_KEY,
  planConversationBackfill,
  runConversationBackfill,
  type BackfillEvent
} from '../src/main/index/conversation-backfill.js'

const NOW = 10 * CONVERSATION_FULL_INTERVAL_MS

describe('planConversationBackfill', () => {
  it('高水位も前回の全件も無ければ全件 (この版に上がった最初の起動)', () => {
    expect(planConversationBackfill({ highWater: null, lastFull: null, maxRowid: 5, now: NOW }))
      .toEqual({ sinceRowid: 0, full: true, reason: 'first' })
    expect(planConversationBackfill({ highWater: 3, lastFull: null, maxRowid: 5, now: NOW }).reason)
      .toBe('first')
  })

  it('期限内なら高水位より後だけ', () => {
    expect(
      planConversationBackfill({ highWater: 3, lastFull: NOW - 1000, maxRowid: 5, now: NOW })
    ).toEqual({ sinceRowid: 3, full: false, reason: 'incremental' })
  })

  it('7 日経つか時計が戻れば全件', () => {
    const due = NOW - CONVERSATION_FULL_INTERVAL_MS
    expect(planConversationBackfill({ highWater: 3, lastFull: due, maxRowid: 5, now: NOW }).reason)
      .toBe('interval')
    expect(
      planConversationBackfill({ highWater: 3, lastFull: NOW + 1, maxRowid: 5, now: NOW }).reason
    ).toBe('interval')
  })

  it('高水位が最大 rowid を上回る (全会話ログ削除で rowid が振り直された) なら全件', () => {
    expect(
      planConversationBackfill({ highWater: 900, lastFull: NOW - 1, maxRowid: 12, now: NOW })
    ).toEqual({ sinceRowid: 0, full: true, reason: 'reset' })
  })
})

function fakeSettings(initial: Record<string, number> = {}) {
  const values = new Map<string, string>(
    Object.entries(initial).map(([key, value]) => [key, String(value)])
  )
  const writes: [string, string][] = []
  return {
    values,
    writes,
    readInteger: (key: string) => {
      const raw = values.get(key)
      return raw === undefined ? null : Number(raw)
    },
    write: (key: string, value: string) => {
      writes.push([key, value])
      values.set(key, value)
    }
  }
}

/** Rows with rowid 10, 20, 30, … (the shape where rows that are not index targets lie in between). */
function table(count: number): BackfillEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    rowid: (i + 1) * 10,
    id: `e${i + 1}`,
    threadId: 't1',
    ts: i,
    label: 'あなた'
  }))
}

function reader(rows: readonly BackfillEvent[]) {
  const asked: number[] = []
  return {
    asked,
    events: (sinceRowid: number, limit: number) => {
      asked.push(sinceRowid)
      return rows.filter((row) => row.rowid > sinceRowid).slice(0, limit)
    }
  }
}

describe('runConversationBackfill', () => {
  it('高水位より後だけを、ページごとに送って高水位を進める', async () => {
    const rows = table(5)
    const settings = fakeSettings({
      [CONVERSATION_HIGH_WATER_KEY]: 20,
      [CONVERSATION_LAST_FULL_KEY]: NOW - 1000
    })
    const source = reader(rows)
    const sent: string[][] = []
    const result = await runConversationBackfill({
      events: source.events,
      maxRowid: () => 50,
      send: async (events) => {
        sent.push(events.map((e) => e.id))
        return events.length
      },
      settings,
      isClosing: () => false,
      now: () => NOW,
      pageSize: 2
    })
    expect(result).toMatchObject({ sent: 3, complete: true, plan: { reason: 'incremental' } })
    expect(sent).toEqual([['e3', 'e4'], ['e5']])
    expect(source.asked).toEqual([20, 40, 50])
    expect(settings.values.get(CONVERSATION_HIGH_WATER_KEY)).toBe('50')
    // An incremental run does not rewrite "the previous full import".
    expect(settings.values.get(CONVERSATION_LAST_FULL_KEY)).toBe(String(NOW - 1000))
  })

  it('全件の回は完走したときだけ前回の全件を書く', async () => {
    const settings = fakeSettings()
    const result = await runConversationBackfill({
      events: reader(table(3)).events,
      maxRowid: () => 30,
      send: async (events) => events.length,
      settings,
      isClosing: () => false,
      now: () => NOW
    })
    expect(result).toMatchObject({ sent: 3, complete: true, plan: { full: true } })
    expect(settings.values.get(CONVERSATION_HIGH_WATER_KEY)).toBe('30')
    expect(settings.values.get(CONVERSATION_LAST_FULL_KEY)).toBe(String(NOW))
  })

  it('1 件も無い全件の回でも高水位を書く (無いままだと毎回全件になる)', async () => {
    const settings = fakeSettings()
    await runConversationBackfill({
      events: () => [],
      maxRowid: () => 0,
      send: async () => 0,
      settings,
      isClosing: () => false,
      now: () => NOW
    })
    expect(settings.values.get(CONVERSATION_HIGH_WATER_KEY)).toBe('0')
    expect(settings.values.get(CONVERSATION_LAST_FULL_KEY)).toBe(String(NOW))
  })

  it('振り直し (reset) の回は高水位を低い値に書き戻す', async () => {
    const settings = fakeSettings({
      [CONVERSATION_HIGH_WATER_KEY]: 900,
      [CONVERSATION_LAST_FULL_KEY]: NOW - 1
    })
    const result = await runConversationBackfill({
      events: reader(table(2)).events,
      maxRowid: () => 20,
      send: async (events) => events.length,
      settings,
      isClosing: () => false,
      now: () => NOW
    })
    expect(result.plan.reason).toBe('reset')
    expect(settings.values.get(CONVERSATION_HIGH_WATER_KEY)).toBe('20')
  })

  it('索引プロセスが途中で止まったら、処理し終えた所までしか進めない', async () => {
    const settings = fakeSettings()
    const result = await runConversationBackfill({
      events: reader(table(5)).events,
      maxRowid: () => 50,
      // Shutdown started in the middle of the third item (`handled` = 2).
      send: async () => 2,
      settings,
      isClosing: () => false,
      now: () => NOW,
      pageSize: 5
    })
    expect(result).toMatchObject({ sent: 2, complete: false })
    expect(settings.values.get(CONVERSATION_HIGH_WATER_KEY)).toBe('20')
    expect(settings.values.has(CONVERSATION_LAST_FULL_KEY)).toBe(false)
  })

  it('送信が失敗したら高水位は前のページのまま (投げたまま返る)', async () => {
    const settings = fakeSettings()
    let calls = 0
    await expect(
      runConversationBackfill({
        events: reader(table(4)).events,
        maxRowid: () => 40,
        send: async (events) => {
          calls += 1
          if (calls === 2) throw new Error('index process crashed')
          return events.length
        },
        settings,
        isClosing: () => false,
        now: () => NOW,
        pageSize: 2
      })
    ).rejects.toThrow('crashed')
    expect(settings.values.get(CONVERSATION_HIGH_WATER_KEY)).toBe('20')
  })

  it('終了処理が始まったら送らず、書かない (12.9)', async () => {
    const settings = fakeSettings()
    let closing = false
    let sends = 0
    const result = await runConversationBackfill({
      events: reader(table(4)).events,
      maxRowid: () => 40,
      send: async (events) => {
        sends += 1
        closing = true // Shutdown started while waiting for the first page's response
        return events.length
      },
      settings,
      isClosing: () => closing,
      now: () => NOW,
      pageSize: 2
    })
    expect(result.complete).toBe(false)
    expect(sends).toBe(1)
    expect(settings.writes).toEqual([])
  })
})
