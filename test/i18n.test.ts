/**
 * The display language (ARCHITECTURE.md 7.4.4, TODO 66). The model is not called.
 *
 * - Dictionaries: the set of keys matches between EN and JA (the same idea as the theme's "the set of variables matches between light and dark"). Both the renderer's dictionary and the small dictionaries of the viewers (plugins).
 * - `t()` does not throw on an unknown key, and returns the key itself.
 * - All reason codes from main have text in both languages. Even when they pass through the IPC wrapper embedded in an exception message, they can be picked up again.
 * - The round trip of `resolveLocale` (a pure function) and `LocaleController` (the real encrypted DB).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import type { Database as Db } from 'better-sqlite3-multiple-ciphers'
import { runMigrations } from '../src/common/migrations.js'
import { PRODUCT_NAME } from '../src/shared/product.js'
import { AppSettingsStore } from '../src/common/settings.js'
import { LocaleController, SETTING_LOCALE } from '../src/main/locale.js'
import {
  DEFAULT_LOCALE_PREFERENCE,
  LOCALES,
  LOCALE_LABEL,
  LOCALE_PREFERENCES,
  isLocale,
  isLocalePreference,
  localeFromTag,
  resolveLocale,
  type LocaleState
} from '../src/shared/locale.js'
import {
  REASON_CODES,
  formatReason,
  isReasonCode,
  parseReason,
  reasonError
} from '../src/shared/reason.js'
import { THEME_PREFERENCES } from '../src/shared/theme.js'
import { THINKING_LEVELS } from '../src/shared/agent.js'
import { DICTIONARIES, describeReason, t, translate } from '../src/renderer/src/i18n/index.js'
import { VIEWER_DICTIONARIES, setViewerLocale, vt } from '../plugins/_shared/i18n.js'
import { NATIVE_DICTIONARIES, nativeText } from '../src/main/i18n-native.js'
import { threadTitleLabel } from '../src/renderer/src/thread/title.js'
import { UNTITLED_THREAD_TITLE } from '../src/shared/thread.js'
import { makeTestDir } from './helpers/tmp.js'

const sortedKeys = (table: Readonly<Record<string, string>>): string[] => Object.keys(table).sort()

describe('辞書 (renderer)', () => {
  it('EN と JA で鍵の集合が一致する', () => {
    expect(sortedKeys(DICTIONARIES.en)).toEqual(sortedKeys(DICTIONARIES.ja))
  })

  it('対応言語の全部に辞書があり、鍵の集合が揃っている', () => {
    const base = sortedKeys(DICTIONARIES.ja)
    for (const locale of LOCALES) expect(sortedKeys(DICTIONARIES[locale])).toEqual(base)
  })

  it('空の文言が無い', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(DICTIONARIES[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('')
      }
    }
  })

  it('差し込みの名前 ({name}) が両言語で同じ', () => {
    // TODO 1254: `{app}` (the product name) is a fixed insertion that translate fills in itself; whether each language puts it into a sentence is up to the language.
    const names = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').filter((name) => name !== 'app').sort()
    for (const key of Object.keys(DICTIONARIES.ja) as (keyof typeof DICTIONARIES.ja)[]) {
      expect(names(DICTIONARIES.en[key]), key).toEqual(names(DICTIONARIES.ja[key]))
    }
  })

  it('TODO 1254: {app} は製品名で埋まり、文言に製品名を直書きしない', () => {
    expect(translate('en', 'help.title')).toBe(`${PRODUCT_NAME} Help`)
    expect(translate('ja', 'help.title')).toBe(`${PRODUCT_NAME} ヘルプ`)
    // A `{app}` inside a caller's value is not filled in (the value is inserted as it is).
    expect(translate('en', 'common.modelNotListed', { id: '{app}' })).toBe('{app} (not listed)')
    for (const locale of ['en', 'ja'] as const) {
      for (const [key, text] of Object.entries(DICTIONARIES[locale])) {
        expect(text, `${locale} ${key}`).not.toMatch(new RegExp(`\\b${PRODUCT_NAME}\\b`))
      }
    }
  })

  it('shared の値 (テーマ・thinking) の表示名が全部ある', () => {
    const ja = DICTIONARIES.ja as Readonly<Record<string, string>>
    for (const value of THEME_PREFERENCES) expect(ja[`theme.${value}`]).toBeDefined()
    for (const level of THINKING_LEVELS) expect(ja[`thinking.${level}`]).toBeDefined()
  })

  it('JA の辞書は置き換え前の文言を保つ (代表例)', () => {
    expect(translate('ja', 'settings.title')).toBe('設定')
    expect(translate('ja', 'threads.pending', { count: 3 })).toBe('承認待ち 3 件')
    expect(translate('en', 'threads.pending', { count: 3 })).toBe('3 awaiting approval')
  })
})

describe('t / translate', () => {
  it('未知の鍵は鍵そのものを返す (throw しない)', () => {
    expect(translate('en', 'no.such.key')).toBe('no.such.key')
    expect(translate('ja', 'no.such.key', { n: 1 })).toBe('no.such.key')
    expect(() => t('no.such.key' as never)).not.toThrow()
    expect(t('no.such.key' as never)).toBe('no.such.key')
  })

  it('差し込みは名前で当て、無い名前は {name} のまま残す', () => {
    expect(translate('en', 'settings.concurrency.maxHint', { cap: 8, gb: 3.2 })).toBe(
      'Up to 8 (about 3.2 GB)'
    )
    expect(translate('en', 'settings.concurrency.maxHint', { cap: 8 })).toBe('Up to 8 (about {gb} GB)')
  })
})

describe('理由コード (main 発の文言)', () => {
  it('全コードに両言語の文言がある', () => {
    for (const locale of LOCALES) {
      const table = DICTIONARIES[locale] as Readonly<Record<string, string>>
      for (const code of REASON_CODES) expect(table[`reason.${code}`], `${locale}:${code}`).toBeDefined()
    }
  })

  it('例外の message に埋め、IPC の包みを通しても拾い直せる', () => {
    const err = reasonError('concurrency-limit', { max: 3, cap: 8 })
    expect(err.message).toBe('aios-reason:concurrency-limit {"max":3,"cap":8}')
    // A reject from ipcMain.handle reaches the renderer in this form.
    const wrapped = `Error invoking remote method 'aios:thread/send': Error: ${err.message}`
    expect(parseReason(wrapped)).toEqual({ code: 'concurrency-limit', params: { max: 3, cap: 8 } })
    expect(describeReason((key, params) => translate('en', key, params), wrapped)).toBe(
      'At most 3 sessions can run at once (up to 8 in Settings). Stop a running thread'
    )
  })

  it('素のコード (値として運ぶ形) もそのまま拾う', () => {
    expect(parseReason('cwd-not-found')).toEqual({ code: 'cwd-not-found', params: {} })
    expect(formatReason('cwd-not-found')).toBe('aios-reason:cwd-not-found')
    expect(translate('ja', `reason.${'cwd-not-found'}`)).toBe('見つかりません')
  })

  it('コードでない文はそのまま出す (関門の例外の生の文など)', () => {
    const tr = (key: string): string => translate('en', key)
    expect(parseReason('/Users/x/.ssh is excluded')).toBeNull()
    expect(describeReason(tr, '/Users/x/.ssh is excluded')).toBe('/Users/x/.ssh is excluded')
    expect(describeReason(tr, null)).toBe('')
    expect(parseReason('aios-reason:no-such-code')).toBeNull()
    expect(isReasonCode('battery')).toBe(false)
  })

  it('TODO 519: 理由コード化する前に保存された固定文は、完全一致のときだけコードに読み替える', () => {
    const en = (key: string): string => translate('en', key)
    expect(describeReason(en, '完了イベントを受け取らずに終了しました')).toBe(
      'The CLI exited without sending a completion event'
    )
    expect(describeReason(en, formatReason('agent-exited-without-result'))).toBe(
      'The CLI exited without sending a completion event'
    )
    // A partial match (where the same sentence is mixed in, such as at the end of stderr) is not translated back.
    expect(parseReason('x 完了イベントを受け取らずに終了しました')).toBeNull()
    expect(parseReason('constructor')).toBeNull()
  })

  it('壊れた差し込み値はコードだけ使う', () => {
    expect(parseReason('aios-reason:concurrency-limit {broken')).toEqual({
      code: 'concurrency-limit',
      params: {}
    })
  })
})

describe('辞書 (viewer / plugins)', () => {
  it('EN と JA で鍵の集合が一致する', () => {
    expect(sortedKeys(VIEWER_DICTIONARIES.en)).toEqual(sortedKeys(VIEWER_DICTIONARIES.ja))
    for (const locale of LOCALES) {
      expect(sortedKeys(VIEWER_DICTIONARIES[locale])).toEqual(sortedKeys(VIEWER_DICTIONARIES.ja))
    }
  })

  it('host から届いた言語で引き分ける', () => {
    setViewerLocale('ja')
    expect(vt('copyCode')).toBe('コードをコピー')
    setViewerLocale('en')
    expect(vt('copyCode')).toBe('Copy code')
    expect(vt('outline', { count: 4 })).toBe('Headings (4)')
    expect(vt('no-such' as never)).toBe('no-such')
  })
})

describe('辞書 (main のネイティブ UI: メニューとダイアログ)', () => {
  it('EN と JA で鍵の集合が一致し、対応言語の全部に表がある', () => {
    const base = sortedKeys(NATIVE_DICTIONARIES.ja)
    for (const locale of LOCALES) expect(sortedKeys(NATIVE_DICTIONARIES[locale])).toEqual(base)
  })

  it('空の文言が無い', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(NATIVE_DICTIONARIES[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('')
      }
    }
  })

  it('言語で引き分け、JA は置き換え前の文言を保つ', () => {
    expect(nativeText('ja', 'menu.newWindow')).toBe('新規ウィンドウ')
    expect(nativeText('en', 'menu.newWindow')).toBe('New Window')
    expect(nativeText('ja', 'dialog.pickDirectory.title')).toBe('このスレッドはどこで作業するか')
  })
})

describe('スレッドの仮題の表示 (TODO 66)', () => {
  it('空文字列 (言語に依らない印) だけを辞書の文言にする', () => {
    const tr = (locale: 'en' | 'ja') => (key: string) => translate(locale, key)
    expect(UNTITLED_THREAD_TITLE).toBe('')
    expect(threadTitleLabel(tr('ja'), '')).toBe('新しいスレッド')
    expect(threadTitleLabel(tr('en'), '')).toBe('New thread')
    expect(threadTitleLabel(tr('en'), '名前')).toBe('名前')
    // Not compared as strings: a "new thread" set by hand stays as it is (the earlier rows are aligned by main as a column).
    expect(threadTitleLabel(tr('en'), '新しいスレッド')).toBe('新しいスレッド')
  })
})

describe('resolveLocale (純関数)', () => {
  it('OS の言語タグを主言語で落とす。表に無ければ en', () => {
    expect(localeFromTag('ja-JP')).toBe('ja')
    expect(localeFromTag('ja')).toBe('ja')
    expect(localeFromTag('JA_jp')).toBe('ja')
    expect(localeFromTag('en-US')).toBe('en')
    expect(localeFromTag('en_GB')).toBe('en')
    expect(localeFromTag('zh-Hant-TW')).toBe('en')
    expect(localeFromTag('')).toBe('en')
    expect(localeFromTag(null)).toBe('en')
  })

  it('明示された言語は OS より強い。system のときだけ OS を見る', () => {
    expect(resolveLocale('en', 'ja-JP')).toBe('en')
    expect(resolveLocale('ja', 'en-US')).toBe('ja')
    expect(resolveLocale('system', 'ja-JP')).toBe('ja')
    expect(resolveLocale('system', 'fr-FR')).toBe('en')
  })

  it('既定は system で、選択肢は system + 対応言語', () => {
    expect(DEFAULT_LOCALE_PREFERENCE).toBe('system')
    expect([...LOCALE_PREFERENCES].sort()).toEqual(['en', 'ja', 'system'])
    for (const locale of LOCALES) expect(LOCALE_LABEL[locale]).not.toBe('')
  })

  it('renderer から来た値を弾ける', () => {
    for (const value of LOCALE_PREFERENCES) expect(isLocalePreference(value)).toBe(true)
    for (const bad of ['', 'EN', 'ja-JP', 'fr', null, undefined, 0, {}, ['en']]) {
      expect(isLocalePreference(bad)).toBe(false)
    }
    expect(isLocale('system')).toBe(false)
  })
})

describe('LocaleController (実物の暗号化 DB)', () => {
  const KEY = 'locale-test-key'
  let dbDir = ''
  let db: Db
  let settings: AppSettingsStore

  beforeAll(() => {
    // macOS's tmpdir() is under /var/folders and hits the exclusion of 4.4.2, so create it under home.
    dbDir = makeTestDir('locale-test')
    db = new Database(join(dbDir, 'aios.db'))
    db.pragma(`key='${KEY}'`)
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    settings = new AppSettingsStore(db)
  })

  afterAll(() => {
    if (db.open) db.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  function make(os: string): { locale: LocaleController; pushed: LocaleState[] } {
    const pushed: LocaleState[] = []
    const locale = new LocaleController({
      settings,
      systemLocale: () => os,
      onChanged: (state) => pushed.push(state)
    })
    return { locale, pushed }
  }

  it('保存が無ければ system で、OS の言語に従う', () => {
    settings.remove(SETTING_LOCALE)
    expect(make('ja-JP').locale.state()).toEqual({ preference: 'system', resolved: 'ja' })
    expect(make('de-DE').locale.state()).toEqual({ preference: 'system', resolved: 'en' })
  })

  it('選んだ値は app_settings の ui.locale に残り、次の起動で読み直される', () => {
    settings.remove(SETTING_LOCALE)
    const { locale, pushed } = make('ja-JP')
    expect(locale.setPreference('en')).toEqual({ preference: 'en', resolved: 'en' })
    expect(settings.read(SETTING_LOCALE)).toBe('en')
    expect(pushed).toEqual([{ preference: 'en', resolved: 'en' }])

    const reopened = make('ja-JP').locale
    expect(reopened.state()).toEqual({ preference: 'en', resolved: 'en' })
    expect(reopened.locale).toBe('en')
  })

  it('実効言語が同じでも、選んだ値が変われば全窓へ押す (設定画面の選択を揃える)', () => {
    settings.remove(SETTING_LOCALE)
    const { locale, pushed } = make('ja-JP')
    locale.setPreference('ja')
    expect(pushed).toEqual([{ preference: 'ja', resolved: 'ja' }])
    // Setting the same value again does not push.
    locale.setPreference('ja')
    expect(pushed).toHaveLength(1)
  })

  it('壊れた保存値は既定 (system) に倒す', () => {
    settings.write(SETTING_LOCALE, 'klingon')
    expect(make('en-US').locale.state()).toEqual({ preference: 'system', resolved: 'en' })
  })
})

describe('Plan mode の文言 (項目 256、第 15 波 束 F): CLI から写した英文で、日本語表示でも同じ', () => {
  const PLAN_BODY_KEYS = [
    'composer.planOn',
    'approval.plan',
    'approval.planHeading',
    'approval.planProceed',
    'approval.planManual',
    'approval.planRevise',
    'approval.planFeedbackPlaceholder',
    'approval.planProceedQuestion',
    'timeline.plan.label',
    // TODO 506: `timeline.plan.lines` was fixed for the observation that `{count} line(s)` stayed in English even in ja. It is split into `.one` / `.other`, and ja gets a real Japanese translation (the count followed by the Japanese word for line), so it is removed from this list (it is no longer the same text as EN).
    // Item 275: the lines for entering and leaving (the CLI's own wording, with only the product name dropped).
    'timeline.plan.entered',
    'timeline.plan.enteredNote',
    'timeline.plan.approved',
    'timeline.plan.exited',
    'timeline.plan.stayed',
    'timeline.plan.saved'
  ] as const

  it('本体の文言は EN と JA で同じ英文 (ヒントの説明だけが言語ごと)', () => {
    for (const key of PLAN_BODY_KEYS) {
      expect(translate('ja', key), key).toBe(translate('en', key))
    }
    for (const key of [
      // TODO 465: the bubble of the ON tag and the description line of ⋯.
      'composer.planOnHint',
      'threadSettings.plan.description',
      'approval.planProceedHint',
      'approval.planManualHint'
    ] as const) {
      expect(translate('ja', key), key).not.toBe(translate('en', key))
    }
  })

  it('CLI 2.1.280 の文言そのもの (製品名の語だけ落とす)', () => {
    const en = (key: Parameters<typeof translate>[1]): string => translate('en', key)
    // The toggle display under the input field: the first half of `⏸ plan mode on (shift+tab to cycle)` (TODO 465: the key moves to the bubble).
    expect(en('composer.planOn')).toBe('⏸︎ plan mode on')
    // The three choices for approving a plan.
    expect(en('approval.plan')).toBe('Ready to code?')
    expect(en('approval.planProceed')).toBe('Yes, auto-accept edits')
    expect(en('approval.planManual')).toBe('Yes, manually approve edits')
    expect(en('approval.planRevise')).toBe('No, keep planning')
    expect(en('approval.planProceedQuestion')).toContain('Would you like to proceed?')
    // Item 275: the lines after approval, and for entering and leaving.
    expect(en('timeline.plan.approved')).toBe('User approved the plan')
    expect(en('timeline.plan.entered')).toBe('Entered plan mode')
    expect(en('timeline.plan.exited')).toBe('Exited plan mode')
    expect(en('timeline.plan.stayed')).toBe('Stayed in plan mode')
    expect(en('timeline.plan.saved')).toBe('Plan saved to: {path} · /plan to edit')
    expect(translate('ja', 'timeline.plan.pending')).not.toBe(translate('en', 'timeline.plan.pending'))
  })

  it('製品名 (制約 5 / 6) を入れていない', () => {
    for (const locale of LOCALES) {
      for (const key of PLAN_BODY_KEYS) {
        expect(translate(locale, key), `${locale}:${key}`).not.toMatch(/claude|anthropic/i)
      }
    }
  })
})

describe('TODO 506: EN の単数形 (322 の `subtasksTooltip` と同じ作法で `.one` / `.other` に分けた鍵)', () => {
  it('time.daysAgo は EN で単数形と複数形が違う、JA は同じ', () => {
    expect(translate('en', 'time.daysAgo.one', { n: 1 })).toBe('1 day ago')
    expect(translate('en', 'time.daysAgo.other', { n: 2 })).toBe('2 days ago')
    expect(translate('ja', 'time.daysAgo.one', { n: 1 })).toBe('1 日前')
    expect(translate('ja', 'time.daysAgo.other', { n: 2 })).toBe('2 日前')
  })

  it('timeline.plan.lines は EN で単数形と複数形が違い、JA は実際の日本語訳', () => {
    expect(translate('en', 'timeline.plan.lines.one', { count: 1 })).toBe('1 line')
    expect(translate('en', 'timeline.plan.lines.other', { count: 2 })).toBe('2 lines')
    expect(translate('ja', 'timeline.plan.lines.one', { count: 1 })).toBe('1 行')
    expect(translate('ja', 'timeline.plan.lines.other', { count: 2 })).toBe('2 行')
  })
})

describe('TODO 519: 標準の plugin のマニフェストは表示言語に依らない英語で書く', () => {
  // The manifest has no per-language table (the extension details' "name" and the command's title are shown as they are). With EN display, Japanese labels of the text and the heading extractor remained.
  it('name / displayName / description / command の題名に日本語が無い', () => {
    const root = join(process.cwd(), 'plugins')
    const japanese = /[぀-ヿ㐀-鿿]/
    const dirs = readdirSync(root).filter((name) => existsSync(join(root, name, 'manifest.json')))
    expect(dirs.length).toBeGreaterThan(0)
    for (const dir of dirs) {
      const manifest = JSON.parse(readFileSync(join(root, dir, 'manifest.json'), 'utf8')) as {
        name?: string
        displayName?: string
        description?: string
        command?: { commands?: { title?: string }[] }
        // TODO 523: activityBar.title is also shown regardless of the display language.
        activityBar?: { title?: string }
      }
      const shown = [
        manifest.name,
        manifest.displayName,
        manifest.description,
        manifest.activityBar?.title,
        ...(manifest.command?.commands ?? []).map((command) => command.title)
      ]
      for (const text of shown) if (text !== undefined) expect(japanese.test(text), `${dir}: ${text}`).toBe(false)
    }
  })
})
