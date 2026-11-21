/**
 * @vitest-environment jsdom
 *
 * TODO 811 (wave 44 bundle A): the setting for the Redmine base URL.
 * - main's `RedmineBasePreference`: saves only values that can use https; an empty value returns to unset; notifies when it changes.
 * - Re-checking the saved value (`WEB_REDMINE_BASE_URL.parse`): a broken or http saved value is treated as unset.
 * - The renderer's copy (`redmineStore`): the round trip of load, subscribe and save.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { WEB_REDMINE_BASE_URL } from '../src/common/settings-keys.js'
import { RedmineBasePreference } from '../src/main/redmine.js'
import { initRedmine, resetRedmineForTest, useRedmine } from '../src/renderer/src/redmineStore.js'

let db: Db

beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db)
})
afterEach(() => db.close())

describe('RedmineBasePreference', () => {
  it('既定は未設定。https の使える値だけ保存し、空で戻し、変われば通知する', () => {
    const settings = new AppSettingsStore(db)
    const seen: string[] = []
    const pref = new RedmineBasePreference(settings, (v) => seen.push(v))
    expect(pref.get()).toBe('')
    expect(pref.set('http://r.example.com')).toBe('')
    expect(pref.set('https://u:p@r.example.com')).toBe('')
    expect(pref.set(3)).toBe('')
    expect(pref.set(' https://r.example.com/ ')).toBe('https://r.example.com')
    expect(pref.set('https://r.example.com')).toBe('https://r.example.com')
    expect(pref.set('nope')).toBe('https://r.example.com')
    expect(seen).toEqual(['https://r.example.com'])
    expect(settings.readTyped(WEB_REDMINE_BASE_URL)).toBe('https://r.example.com')
    expect(new RedmineBasePreference(settings).get()).toBe('https://r.example.com')
    expect(pref.set('  ')).toBe('')
    expect(seen).toEqual(['https://r.example.com', ''])
  })

  it('保存値が http など使えない形なら未設定の扱い', () => {
    expect(WEB_REDMINE_BASE_URL.parse('http://r.example.com')).toBe('')
    expect(WEB_REDMINE_BASE_URL.parse(null)).toBe('')
    expect(WEB_REDMINE_BASE_URL.parse('https://r.example.com/')).toBe('https://r.example.com')
  })
})

describe('redmineStore', () => {
  it('読み込み・知らせ・保存の往復', async () => {
    resetRedmineForTest()
    let listener: ((v: string) => void) | null = null
    const saved: string[] = []
    ;(window as unknown as { aios: unknown }).aios = {
      redmine: {
        get: async () => 'https://a.example.com',
        set: async (v: string) => {
          saved.push(v)
          return v
        },
        onChanged: (fn: (v: string) => void) => {
          listener = fn
          return () => undefined
        }
      }
    }
    initRedmine()
    initRedmine()
    await Promise.resolve()
    await Promise.resolve()
    expect(useRedmine.getState().baseUrl).toBe('https://a.example.com')
    listener!('https://b.example.com')
    expect(useRedmine.getState().baseUrl).toBe('https://b.example.com')
    expect(await useRedmine.getState().update('https://c.example.com')).toBe('https://c.example.com')
    expect(saved).toEqual(['https://c.example.com'])
    delete (window as unknown as { aios?: unknown }).aios
    resetRedmineForTest()
  })
})
