/**
 * TODO 1260: saved Gmail trigger instructions that exactly equal a retired default go back to "follow the default";
 * anything the user edited is untouched. No model is called.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { DEFAULT_TRIGGER_RULE } from '../src/shared/trigger.js'
import { TriggerStore } from '../src/main/trigger/store.js'
import { STALE_DEFAULT_INSTRUCTIONS } from '../src/main/trigger/stale-defaults.js'
import manifest from '../plugins/aios.gmail/manifest.json'

let db: Db
let store: TriggerStore
const P = 'aios.gmail'
const T = 'new-mail'
const stale = STALE_DEFAULT_INSTRUCTIONS[0]!.texts
const current = manifest.triggers.find((t) => t.id === T)!.defaultPrompt

const instructionsOf = (trigger: string): string | null =>
  (db.prepare('SELECT instructions FROM trigger_rules WHERE plugin_id = ? AND trigger_id = ?').get(P, trigger) as { instructions: string | null })
    .instructions

beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
  store = new TriggerStore(db)
})

describe('stale default instructions (1260)', () => {
  it('keeps the three retired defaults and never the current one', () => {
    expect(stale).toHaveLength(3)
    expect(new Set(stale).size).toBe(3)
    expect(stale).not.toContain(current)
  })

  it('resets each retired default, once, idempotently', () => {
    stale.forEach((text, i) => store.setRule(P, `${T}${i}`, { ...DEFAULT_TRIGGER_RULE, instructions: text }))
    for (let i = 0; i < stale.length; i += 1) {
      expect(store.resetStaleInstructions(P, `${T}${i}`, stale)).toBe(1)
      expect(instructionsOf(`${T}${i}`)).toBeNull()
      expect(store.resetStaleInstructions(P, `${T}${i}`, stale)).toBe(0)
    }
  })

  it('leaves edited, current-default and other-plugin instructions alone', () => {
    store.setRule(P, 'edited', { ...DEFAULT_TRIGGER_RULE, instructions: stale[0]! + ' 追記' })
    store.setRule(P, 'current', { ...DEFAULT_TRIGGER_RULE, instructions: current })
    store.setRule('aios.other', 'other', { ...DEFAULT_TRIGGER_RULE, instructions: stale[1]! })
    for (const id of ['edited', 'current']) expect(store.resetStaleInstructions(P, id, stale)).toBe(0)
    expect(instructionsOf('edited')).toBe(stale[0]! + ' 追記')
    expect(instructionsOf('current')).toBe(current)
    expect(store.resetStaleInstructions(P, 'other', stale)).toBe(0)
  })
})
