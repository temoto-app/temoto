/**
 * TODO 1333: carrying the Composer text over the idle restart for an update (ARCHITECTURE 8.5).
 * `CarriedDraftsService` (main), the renderer's collect / restore, and the narrowing of untrusted values. No model, no electron.
 */
import { describe, expect, it, vi } from 'vitest'
import { HOLD_AFTER_TAKE_MS, CarriedDraftsService, type CarriedDraftsTarget } from '../src/main/update/carried-drafts.js'
import { UPDATE_CARRIED_DRAFTS, type SettingKey } from '../src/common/settings-keys.js'
import {
  CARRIED_DRAFTS_MAX_BYTES,
  carriedDraftsEmpty,
  mergeCarriedDrafts,
  parseCarriedDrafts,
  type CarriedDraftsReply,
  type CarriedDraftsRequest
} from '../src/shared/update.js'
import { collectCarriedDrafts, installCarriedDrafts, mergeRestoredDrafts } from '../src/renderer/src/carried-drafts.js'

class MemorySettings {
  readonly values = new Map<string, string>()
  readTyped<T>(def: SettingKey<T>): T {
    return def.parse(this.values.get(def.key) ?? null)
  }
  writeTyped<T>(def: SettingKey<T>, value: T): void {
    this.values.set(def.key, def.serialize(value))
  }
}

const drafts = { composer: { t1: 'hello' } }

interface HarnessOptions {
  readonly windows?: readonly number[]
  readonly known?: Record<number, { composerThreads: string[] }>
  readonly replies?: Record<number, CarriedDraftsReply | 'silent'>
  readonly hasDrafts?: boolean
}

function harness(options: HarnessOptions = {}) {
  const settings = new MemorySettings()
  let now = 10_000_000
  const requests: Array<{ viewId: number; request: CarriedDraftsRequest }> = []
  const held: string[][] = []
  const released = vi.fn()
  const windows = options.windows ?? [1]
  let service!: CarriedDraftsService
  const targets: CarriedDraftsTarget[] = windows.map((id) => ({
    id,
    send: (request) => {
      requests.push({ viewId: id, request })
      const reply = options.replies?.[id]
      if (reply === 'silent') return
      // The window answers asynchronously, like an IPC round trip.
      queueMicrotask(() => service.submit(id, request.id, reply ?? { carriable: true, drafts }))
    }
  }))
  const make = (): CarriedDraftsService =>
    new CarriedDraftsService({
      settings,
      targets: () => targets,
      hasDrafts: () => options.hasDrafts ?? true,
      inspect: (viewId) => ({ composerThreads: new Set(options.known?.[viewId]?.composerThreads ?? ['t1']) }),
      holdThreads: (ids) => {
        held.push([...ids])
        return released
      },
      now: () => now,
      timeoutMs: 20,
      newId: () => 'req-1'
    })
  service = make()
  return {
    service,
    settings,
    requests,
    held,
    released,
    remake: () => {
      service = make()
      return service
    },
    advance(ms: number) {
      now += ms
    }
  }
}

describe('narrowing the values that cross the boundary', () => {
  it('accepts the expected shape and rejects anything else', () => {
    expect(parseCarriedDrafts(drafts)).toEqual(drafts)
    expect(parseCarriedDrafts(null)).toBeNull()
    expect(parseCarriedDrafts({ composer: [] })).toBeNull()
    expect(parseCarriedDrafts({ composer: { t1: 3 } })).toBeNull()
    expect(parseCarriedDrafts({ composer: { '': 'x' } })).toBeNull()
    expect(parseCarriedDrafts({ composer: { t1: '   ' } })).toBeNull()
  })

  it('ignores a `viewer` table left in a value stored by an earlier build', () => {
    expect(parseCarriedDrafts({ composer: { t1: 'hello' }, viewer: { 'file:///a.md': { text: 'x', baseMtimeMs: 1 } } })).toEqual(drafts)
    expect(parseCarriedDrafts({ composer: { t1: 'hello' }, viewer: 5 })).toEqual(drafts)
  })

  it('refuses what is over the size limits', () => {
    expect(parseCarriedDrafts({ composer: { t1: 'x'.repeat(CARRIED_DRAFTS_MAX_BYTES + 1) } })).toBeNull()
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`t${i}`, 'x']))
    expect(parseCarriedDrafts({ composer: many })).toBeNull()
  })

  it('merges windows with the earlier one winning, and knows when there is nothing', () => {
    const merged = mergeCarriedDrafts([drafts, { composer: { t1: 'other', t2: 'two' } }])
    expect(merged.composer).toEqual({ t1: 'hello', t2: 'two' })
    expect(carriedDraftsEmpty({ composer: {} })).toBe(true)
    expect(carriedDraftsEmpty(drafts)).toBe(false)
  })
})

describe('CarriedDraftsService (main)', () => {
  it('with no drafts anywhere it says yes without asking a window or writing anything', async () => {
    const h = harness({ hasDrafts: false })
    await expect(h.service.carryBeforeRestart()).resolves.toBe(true)
    expect(h.requests).toEqual([])
    expect(h.settings.values.has(UPDATE_CARRIED_DRAFTS.key)).toBe(false)
  })

  it('collects from every window, stores the merged text in the settings (the encrypted DB), and says yes', async () => {
    const h = harness({
      windows: [1, 2],
      known: { 1: { composerThreads: ['t1'] }, 2: { composerThreads: [] } },
      replies: { 2: { carriable: true, drafts: { composer: {} } } }
    })
    await expect(h.service.carryBeforeRestart()).resolves.toBe(true)
    expect(h.requests.map((entry) => entry.viewId)).toEqual([1, 2])
    expect(h.settings.readTyped(UPDATE_CARRIED_DRAFTS)?.drafts).toEqual(drafts)
  })

  it('says no when a window holds something that cannot be carried (attachments, too large)', async () => {
    const h = harness({ replies: { 1: { carriable: false } } })
    await expect(h.service.carryBeforeRestart()).resolves.toBe(false)
    expect(h.settings.values.has(UPDATE_CARRIED_DRAFTS.key)).toBe(false)
  })

  it('says no when a window does not answer in time', async () => {
    const h = harness({ windows: [1, 2], replies: { 2: 'silent' } })
    await expect(h.service.carryBeforeRestart()).resolves.toBe(false)
    expect(h.settings.values.has(UPDATE_CARRIED_DRAFTS.key)).toBe(false)
  })

  it('says no when the reply does not contain a thread main was told about (nothing is dropped silently)', async () => {
    const h = harness({ known: { 1: { composerThreads: ['t1', 'ghost'] } } })
    await expect(h.service.carryBeforeRestart()).resolves.toBe(false)
  })

  it('says no for a reply that is not the expected shape, and ignores replies for another request or another window', async () => {
    const bad = harness({ replies: { 1: { carriable: true, drafts: { composer: { t1: 7 } } } as unknown as CarriedDraftsReply } })
    await expect(bad.service.carryBeforeRestart()).resolves.toBe(false)
    const h = harness({ replies: { 1: 'silent' } })
    const pending = h.service.carryBeforeRestart()
    h.service.submit(1, 'another-request', { carriable: true, drafts })
    h.service.submit(99, 'req-1', { carriable: true, drafts })
    await expect(pending).resolves.toBe(false)
  })

  it('does not start a second collection while one is running', async () => {
    const h = harness({ replies: { 1: 'silent' } })
    const first = h.service.carryBeforeRestart()
    await expect(h.service.carryBeforeRestart()).resolves.toBe(false)
    h.service.submit(1, 'req-1', { carriable: true, drafts })
    await expect(first).resolves.toBe(true)
  })

  it('hands the stored text back once: the first window gets everything, the stored copy is deleted, no other window (or reload) gets it again', async () => {
    const first = harness()
    await first.service.carryBeforeRestart()
    const next = harness()
    next.settings.values.set(UPDATE_CARRIED_DRAFTS.key, first.settings.values.get(UPDATE_CARRIED_DRAFTS.key) ?? '')
    const service = next.remake()
    service.start()
    // The threads are protected from the purge until the window has reported its own drafts
    expect(next.held).toEqual([['t1']])
    expect(service.take()).toEqual(drafts)
    expect(next.settings.values.get(UPDATE_CARRIED_DRAFTS.key)).toBe('')
    // A second window, a reloaded window and a window opened later get nothing: the sent message does not come back as a draft
    expect(service.take()).toBeNull()
    next.advance(HOLD_AFTER_TAKE_MS * 10)
    expect(service.take()).toBeNull()
    service.stop()
    expect(next.released).toHaveBeenCalled()
  })

  it('does not carry when two windows hold different text for the same thread, and merges equal text', async () => {
    const differ = harness({
      windows: [1, 2],
      known: { 1: { composerThreads: ['t1'] }, 2: { composerThreads: ['t1'] } },
      replies: { 2: { carriable: true, drafts: { composer: { t1: 'something else' } } } }
    })
    await expect(differ.service.carryBeforeRestart()).resolves.toBe(false)
    expect(differ.settings.values.has(UPDATE_CARRIED_DRAFTS.key)).toBe(false)
    const same = harness({ windows: [1, 2], known: { 1: { composerThreads: ['t1'] }, 2: { composerThreads: ['t1'] } } })
    await expect(same.service.carryBeforeRestart()).resolves.toBe(true)
    expect(same.settings.readTyped(UPDATE_CARRIED_DRAFTS)?.drafts).toEqual(drafts)
  })

  it('never drops an unclaimed stored copy: not for age (a restart that failed and was launched days later) and not at the 10-minute mark', () => {
    const h = harness()
    h.settings.writeTyped(UPDATE_CARRIED_DRAFTS, { savedAt: 10_000_000 - 5 * 24 * 60 * 60_000, drafts })
    const service = h.remake()
    service.start()
    h.advance(HOLD_AFTER_TAKE_MS * 1000)
    expect(h.settings.readTyped(UPDATE_CARRIED_DRAFTS)?.drafts).toEqual(drafts)
    // The first window that asks, whenever it asks, gets it, and only then is the stored copy deleted
    expect(service.take()).toEqual(drafts)
    expect(h.settings.values.get(UPDATE_CARRIED_DRAFTS.key)).toBe('')
    service.stop()
  })

  it('keeps the stored copy when the app shuts down before any window took it', () => {
    const h = harness()
    h.settings.writeTyped(UPDATE_CARRIED_DRAFTS, { savedAt: 10_000_000, drafts })
    const service = h.remake()
    service.start()
    service.stop()
    expect(service.take()).toBeNull()
    expect(h.settings.readTyped(UPDATE_CARRIED_DRAFTS)?.drafts).toEqual(drafts)
  })

  it('removes only a value that cannot be read', () => {
    const broken = harness()
    broken.settings.writeTyped(UPDATE_CARRIED_DRAFTS, { savedAt: 10_000_000, drafts: { composer: 5 } })
    const brokenService = broken.remake()
    brokenService.start()
    expect(brokenService.take()).toBeNull()
    expect(broken.settings.values.get(UPDATE_CARRIED_DRAFTS.key)).toBe('')
  })

  it('serves a stored value that still has the old `viewer` table, ignoring that table', () => {
    const h = harness()
    h.settings.values.set(
      UPDATE_CARRIED_DRAFTS.key,
      JSON.stringify({ savedAt: 10_000_000, drafts: { composer: { t1: 'hello' }, viewer: { 'file:///a.md': { text: 'x', baseMtimeMs: 1 } } } })
    )
    const service = h.remake()
    service.start()
    expect(service.take()).toEqual(drafts)
  })

  it('discard removes a stored copy (the restart was called off), and after stop it writes nothing', async () => {
    const h = harness()
    await h.service.carryBeforeRestart()
    expect(h.settings.values.get(UPDATE_CARRIED_DRAFTS.key)).not.toBe('')
    h.service.discard()
    expect(h.settings.values.get(UPDATE_CARRIED_DRAFTS.key)).toBe('')
    h.service.stop()
    await expect(h.service.carryBeforeRestart()).resolves.toBe(false)
  })

  it('never stores anything outside the settings key (the draft text is only in the one value)', async () => {
    const h = harness()
    await h.service.carryBeforeRestart()
    expect([...h.settings.values.keys()]).toEqual([UPDATE_CARRIED_DRAFTS.key])
  })
})

describe('the renderer side', () => {
  const sources = { drafts: { t1: 'hello', t2: '   ' }, attachments: {} }

  it('answers with the non-blank Composer text', () => {
    expect(collectCarriedDrafts(sources)).toEqual({ carriable: true, drafts })
  })

  it('answers carriable: false when any thread has an attachment, or the text is too large', () => {
    const attachment = { uri: 'file:///x.png', name: 'x.png' } as never
    expect(collectCarriedDrafts({ ...sources, attachments: { t1: [attachment] } })).toEqual({ carriable: false })
    expect(collectCarriedDrafts({ ...sources, attachments: { t1: [] } }).carriable).toBe(true)
    expect(collectCarriedDrafts({ ...sources, drafts: { t1: 'x'.repeat(CARRIED_DRAFTS_MAX_BYTES + 1) } })).toEqual({ carriable: false })
  })

  it('restores without overwriting what the window already holds', () => {
    const merged = mergeRestoredDrafts({ drafts: { t1: 'typed since', t3: '  ' } }, { composer: { t1: 'hello', t3: 'three' } })
    expect(merged.drafts).toEqual({ t1: 'typed since', t3: 'three' })
  })

  it('installs both directions: answers a collect request, and applies the carried text once at launch', async () => {
    const submitted: Array<{ id: string; reply: CarriedDraftsReply }> = []
    let listener: ((request: CarriedDraftsRequest) => void) | null = null
    const applied: unknown[] = []
    installCarriedDrafts(
      {
        onCollectDrafts: (fn) => {
          listener = fn
        },
        submitDrafts: async (id, reply) => {
          submitted.push({ id, reply })
        },
        takeCarriedDrafts: async () => ({ composer: { t9: 'back' } })
      },
      { sources: () => ({ drafts: {}, attachments: {} }), apply: (merged) => applied.push(merged) }
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(applied).toEqual([{ drafts: { t9: 'back' } }])
    ;(listener as ((request: CarriedDraftsRequest) => void) | null)?.({ id: 'abc' })
    expect(submitted).toEqual([{ id: 'abc', reply: { carriable: true, drafts: { composer: {} } } }])
  })

  it('does nothing when the entry points are missing (an old preload)', () => {
    const deps = { sources: () => ({ drafts: {}, attachments: {} }), apply: () => undefined }
    expect(() => installCarriedDrafts(undefined, deps)).not.toThrow()
    expect(() => installCarriedDrafts({}, deps)).not.toThrow()
  })
})
