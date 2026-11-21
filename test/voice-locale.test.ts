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

describe('isVoiceLocalePreference / 既定 (TODO 626)', () => {
  it('auto / ja / en だけ通す', () => {
    expect(isVoiceLocalePreference('auto')).toBe(true)
    expect(isVoiceLocalePreference('ja')).toBe(true)
    expect(isVoiceLocalePreference('en')).toBe(true)
    expect(isVoiceLocalePreference('fr')).toBe(false)
    expect(isVoiceLocalePreference(null)).toBe(false)
    expect(isVoiceLocalePreference(undefined)).toBe(false)
  })

  it('既定は auto、選択肢の並びは auto / ja / en', () => {
    expect(DEFAULT_VOICE_LOCALE_PREFERENCE).toBe('auto')
    expect(VOICE_LOCALE_PREFERENCES).toEqual(['auto', 'ja', 'en'])
  })
})

describe('resolveVoiceSpeechLocale (TODO 626)', () => {
  it('明示した ja / en はそのまま ja-JP / en-US (優先言語は見ない)', () => {
    expect(resolveVoiceSpeechLocale('ja', ['en-US'])).toBe('ja-JP')
    expect(resolveVoiceSpeechLocale('en', ['ja-JP'])).toBe('en-US')
  })

  it('auto は優先言語の先頭。ja / en は地域付きに揃える', () => {
    expect(resolveVoiceSpeechLocale('auto', ['ja'])).toBe('ja-JP')
    expect(resolveVoiceSpeechLocale('auto', ['ja-JP', 'en-US'])).toBe('ja-JP')
    expect(resolveVoiceSpeechLocale('auto', ['en-US', 'ja-JP'])).toBe('en-US')
  })

  it('auto で ja / en 以外の優先言語はそのままヘルパーへ渡す (アンダースコアはハイフンに)', () => {
    expect(resolveVoiceSpeechLocale('auto', ['fr-FR'])).toBe('fr-FR')
    expect(resolveVoiceSpeechLocale('auto', ['zh_Hant_TW'])).toBe('zh-Hant-TW')
  })

  it('auto で優先言語が空 (空文字列だけ含む場合も) なら en-US に倒す', () => {
    expect(resolveVoiceSpeechLocale('auto', [])).toBe('en-US')
    expect(resolveVoiceSpeechLocale('auto', ['', '  '])).toBe('en-US')
  })

  it('auto で先頭が空文字列なら次の優先言語を見る', () => {
    expect(resolveVoiceSpeechLocale('auto', ['', 'ja-JP'])).toBe('ja-JP')
  })
})

function open(): Db {
  const database = new Database(':memory:')
  runMigrations(database)
  return database
}

describe('VoiceLocalePreferenceStore (TODO 626)', () => {
  it('既定は auto、選び直すと永続化する', () => {
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

  it('壊れた保存値は既定に倒す', () => {
    const db = open()
    const settings = new AppSettingsStore(db)
    settings.write(VOICE_LOCALE.key, 'not-a-locale')
    expect(new VoiceLocalePreferenceStore(settings).get()).toBe('auto')
    db.close()
  })
})
