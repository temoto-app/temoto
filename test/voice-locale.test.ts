/**
 * Recognition language for voice input (TODO 626, ARCHITECTURE.md 4.5.10).
 * - `isVoiceLocalePreference` / the default
 * - `resolveVoiceSpeechLocale`: an explicit `ja` / `en` is used as is; `auto` is the first of macOS's preferred languages, and if the list is empty it falls back to `en-US`.
 *   Preferred languages other than ja / en are also passed as tags (narrowing is done by the helper).
 * - `VoiceLocalePreferenceStore`: saving uses only one key of `app_settings` (the same type as `EditorPreference`).
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import {
  DEFAULT_VOICE_LOCALE_PREFERENCE,
  VOICE_LOCALE_PREFERENCES,
  isVoiceLocalePreference,
  resolveVoiceSpeechLocale
} from '../src/shared/voice-locale.js'
import { runMigrations } from '../src/common/migrations.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { VOICE_LOCALE } from '../src/common/settings-keys.js'
import { VoiceLocalePreferenceStore } from '../src/main/voice/locale-preference.js'

describe('isVoiceLocalePreference / default (TODO 626)', () => {
  it('passes only auto / ja / en', () => {
    expect(isVoiceLocalePreference('auto')).toBe(true)
    expect(isVoiceLocalePreference('ja')).toBe(true)
    expect(isVoiceLocalePreference('en')).toBe(true)
    expect(isVoiceLocalePreference('fr')).toBe(false)
    expect(isVoiceLocalePreference(null)).toBe(false)
    expect(isVoiceLocalePreference(undefined)).toBe(false)
  })

  it('the default is auto, and the options are ordered auto / ja / en', () => {
    expect(DEFAULT_VOICE_LOCALE_PREFERENCE).toBe('auto')
    expect(VOICE_LOCALE_PREFERENCES).toEqual(['auto', 'ja', 'en'])
  })
})

describe('resolveVoiceSpeechLocale (TODO 626)', () => {
  it('an explicit ja / en becomes ja-JP / en-US as is (preferred languages are not looked at)', () => {
    expect(resolveVoiceSpeechLocale('ja', ['en-US'])).toBe('ja-JP')
    expect(resolveVoiceSpeechLocale('en', ['ja-JP'])).toBe('en-US')
  })

  it('auto takes the first preferred language; ja / en are normalized to include a region', () => {
    expect(resolveVoiceSpeechLocale('auto', ['ja'])).toBe('ja-JP')
    expect(resolveVoiceSpeechLocale('auto', ['ja-JP', 'en-US'])).toBe('ja-JP')
    expect(resolveVoiceSpeechLocale('auto', ['en-US', 'ja-JP'])).toBe('en-US')
  })

  it('for auto, a preferred language other than ja / en is passed to the helper as is (underscore becomes hyphen)', () => {
    expect(resolveVoiceSpeechLocale('auto', ['fr-FR'])).toBe('fr-FR')
    expect(resolveVoiceSpeechLocale('auto', ['zh_Hant_TW'])).toBe('zh-Hant-TW')
  })

  it('for auto, falls back to en-US when preferred languages are empty (also when containing only empty strings)', () => {
    expect(resolveVoiceSpeechLocale('auto', [])).toBe('en-US')
    expect(resolveVoiceSpeechLocale('auto', ['', '  '])).toBe('en-US')
  })

  it('for auto, when the first is an empty string, looks at the next preferred language', () => {
    expect(resolveVoiceSpeechLocale('auto', ['', 'ja-JP'])).toBe('ja-JP')
  })
})

function open(): Db {
  const database = new Database(':memory:')
  runMigrations(database)
  return database
}

describe('VoiceLocalePreferenceStore (TODO 626)', () => {
  it('the default is auto, and choosing again persists it', () => {
    const db = open()
    const settings = new AppSettingsStore(db)
    const store = new VoiceLocalePreferenceStore(settings)
    expect(store.get()).toBe('auto')
    expect(store.set('ja')).toBe('ja')
    expect(store.get()).toBe('ja')
    // Can be read again by another instance (equivalent to a restart).
    expect(new VoiceLocalePreferenceStore(settings).get()).toBe('ja')
    db.close()
  })

  it('falls back to the default for a broken saved value', () => {
    const db = open()
    const settings = new AppSettingsStore(db)
    settings.write(VOICE_LOCALE.key, 'not-a-locale')
    expect(new VoiceLocalePreferenceStore(settings).get()).toBe('auto')
    db.close()
  })
})
