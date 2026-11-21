/**
 * The words of the sidebar list in English and Japanese (TODO 1264). The language comes from `PluginTaskArg.locale` (aios's display language);
 * without it, English.
 */
import type { Locale } from '@shared/locale.js'

export interface CalendarText {
  readonly today: string
  readonly tomorrow: string
  readonly thisWeek: string
  readonly allDay: string
  readonly noEvents: string
  readonly noTitle: string
  readonly notConnected: string
  readonly howToConnect: string
  readonly reauth: string
  readonly howToReauth: string
  readonly apiRefused: string
  readonly howToApi: string
  readonly more: (count: number) => string
  readonly where: (text: string) => string
  readonly video: (text: string) => string
  readonly attendees: (count: number, names: string) => string
  readonly organizer: (text: string) => string
  readonly tentative: string
  readonly notes: (text: string) => string
  readonly calendar: (text: string) => string
}

const EN: CalendarText = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  thisWeek: 'This week',
  allDay: 'All day',
  noEvents: 'No events',
  noTitle: '(no title)',
  notConnected: 'Not connected to Google Calendar',
  howToConnect: 'Sign in under Extensions → Google Calendar → Account.',
  reauth: 'Google Calendar sign-in has expired',
  howToReauth: 'Sign in again under Extensions → Google Calendar → Account. The list below is from the last refresh.',
  apiRefused: 'Google Calendar refused access (403)',
  howToApi:
    'Check that the Google Calendar API is enabled in the Google Cloud project of your OAuth client. After enabling it, it can take a few minutes to work.',
  more: (count) => `… ${count} more`,
  where: (text) => `Where: ${text}`,
  video: (text) => `Video call: ${text}`,
  attendees: (count, names) => `Guests (${count}): ${names}`,
  organizer: (text) => `Organizer: ${text}`,
  tentative: 'Tentative',
  notes: (text) => `Notes: ${text}`,
  calendar: (text) => `Calendar: ${text}`
}

const JA: CalendarText = {
  today: '今日',
  tomorrow: '明日',
  thisWeek: '今週',
  allDay: '終日',
  noEvents: '予定はありません',
  noTitle: '(タイトルなし)',
  notConnected: 'Google カレンダーに接続していません',
  howToConnect: '拡張機能 → Google Calendar → アカウント からログインしてください。',
  reauth: 'Google カレンダーのログインが切れました',
  howToReauth: '拡張機能 → Google Calendar → アカウント からもう一度ログインしてください。下の一覧は前に読んだときのものです。',
  apiRefused: 'Google カレンダーが読み取りを断りました (403)',
  howToApi: 'OAuth クライアントの Google Cloud プロジェクトで Google Calendar API が有効か確かめてください。有効にしてから使えるまで数分かかることがあります。',
  more: (count) => `… ほか ${count} 件`,
  where: (text) => `場所: ${text}`,
  video: (text) => `ビデオ会議: ${text}`,
  attendees: (count, names) => `ゲスト (${count}): ${names}`,
  organizer: (text) => `主催者: ${text}`,
  tentative: '仮',
  notes: (text) => `説明: ${text}`,
  calendar: (text) => `カレンダー: ${text}`
}

export function textFor(locale: Locale | undefined): CalendarText {
  return locale === 'ja' ? JA : EN
}

/** The `Intl` locale tag for dates and times. */
export function intlLocale(locale: Locale | undefined): string {
  return locale === 'ja' ? 'ja-JP' : 'en-US'
}
