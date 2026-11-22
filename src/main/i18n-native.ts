/**
 * A table of a few words shown in **OS native UI** (menus and dialogs) (ARCHITECTURE.md 7.4.4, TODO 66).
 *
 * The renderer's dictionary (`src/renderer/src/i18n/`) does not reach native UI: menu items and the title / message of
 * `dialog.showOpenDialog` are strings main hands to electron as they are, without going through the renderer.
 * That is why main's wording is kept **only here**, as an exception.
 *
 * - The scope is **only a few words of menus and dialogs**. Other wording in main still goes back to the renderer as reason codes
 *   (`shared/reason.ts`, owner decision 2). Only strings that appear on "surfaces the renderer does not draw" are added here.
 * - The renderer's dictionary is not imported (main is the electron side, the renderer is the React side).
 * - **Does not import electron**: `test/i18n.test.ts` checks that the key sets match and that no text is empty,
 *   without electron.
 * - `ja` is the authority for the key set; `en` is forced to have the same keys by the type (`Record<NativeKey, string>`).
 * - The product name is not written in the text but as `{app}` (TODO 1254). `nativeText` fills it with `PRODUCT_NAME` (same convention as the renderer's dictionary).
 */
import type { Locale } from '@shared/locale.js'
import { PRODUCT_NAME } from '@shared/product.js'

const ja = {
  /** Cmd+N in the app menu "File" and in the Dock menu. */
  'menu.newWindow': '新規ウィンドウ',
  'menu.file': 'ファイル',
  'menu.view': '表示',
  /** "Reload" in the "View" menu (TODO 468: the Cmd+R accelerator was removed, so the item is built by hand instead of using a role). */
  'menu.reload': '再読み込み',
  /** "Force Reload" in the "View" menu (Cmd+Shift+R). TODO 636 dropped the role `forceReload` for an item that cleans up drafts and then reloads. */
  'menu.forceReload': '強制再読み込み',
  /** The page for a window whose renderer kept dying (TODO 1319, `src/main/recovery-page.ts`). */
  'recovery.title': 'ウィンドウを表示できませんでした',
  'recovery.body': '表示の処理が続けて止まりました。会話は止まらずに動いています。もう一度読み込んでも、直前に開いていた会話は開き直しません。',
  'recovery.reload': 'もう一度読み込む',
  'recovery.reason': '理由コード',
  /** Cmd+B (T27). */
  'menu.sidebar': 'サイドバー',
  /** The mode items of the "View" menu, and settings (item 195, wave 14 bundle D). Same word as the renderer's icon name. */
  'menu.threads': 'スレッド',
  'menu.files': 'ファイル',
  'menu.search': '検索',
  /** Extensions view (Cmd+Shift+X, TODO 367). Same word as the renderer's icon name. */
  'menu.extensions': '拡張',
  'menu.settings': '設定…',
  /** "Save" in "File" (Cmd+S, item 313). Same word as the viewer's save button. */
  'menu.save': '保存',
  /** "New Thread" in "File" (Cmd+Shift+O, TODO 408). Same word as the renderer's `threads.new`. */
  'menu.newThread': '新しいスレッド…',
  /** "Show Hidden Files" in "View" (Cmd+Shift+., TODO 261). Has a checkmark. Same word as the title of the toggle in the tree heading. */
  'menu.hiddenFiles': '隠しファイルを表示',
  /** "Close" (Cmd+W, TODO 531). Closes the front Web tab if there is one, otherwise the window. */
  'menu.close': '閉じる',
  /** The "Help" menu and "{app} Help" (TODO 1174). Same word as the renderer's `help.title`. */
  'menu.help': 'ヘルプ',
  'menu.helpItem': '{app} ヘルプ',
  /**
   * "About {app}", "Hide {app}" and "Quit {app}" in the app menu (TODO 1254). The default wording of the roles is built from the internal name
   * (`app.name` = aios), so it is replaced with the public name.
   */
  'menu.about': '{app} について',
  'menu.hide': '{app} を隠す',
  'menu.quit': '{app} を終了',
  /** The menu bar icon's menu (TODO 1269). `{count}` is the number of pending approvals (the same source as the Dock badge). */
  'tray.show': '{app} を表示',
  'tray.newThread': '新しい会話',
  'tray.pending': '待ちの承認: {count} 件',
  'tray.pendingNone': '待ちの承認なし',
  /** TODO 1302: the summary row (`{running}` conversations running, `{unread}` finished and unread). */
  'tray.summary': '実行中 {running} / 未読 {unread}',
  /** TODO 1303: a conversation named in the menu (`{title}` is cut to one line), "N more" past the limit, and the word for a conversation with no name yet. */
  'tray.rowApproval': '承認待ち: {title}',
  'tray.rowRunning': '実行中: {title}',
  'tray.rowUnread': '未読: {title}',
  'tray.more': 'ほか {count} 件',
  'tray.untitled': '名前のない会話',
  /** TODO 1301: the folder rows' tail ("Choose Folder…" opens the OS dialog) and the submenu of recent conversations. */
  'tray.pickFolder': 'フォルダを選ぶ…',
  /** TODO 1304: a new conversation that starts recording right away (the same as the dictation hotkey). */
  'tray.dictate': '音声入力で新しい会話',
  /** TODO 1305: the heading over the next scheduled runs (a greyed row). */
  'tray.scheduleHeader': '次の予定',
  'tray.recent': '最近の会話',
  /** "Help > Release Notes" (TODO 1186). Corresponds to Release Notes in VS Code. */
  'menu.releaseNotes': 'リリースノート',
  /** "Help > Report a Problem" (TODO 1308). Same word as the renderer's `build.reportProblem`. */
  'menu.reportProblem': '問題を報告',
  /**
   * "Toggle Full Screen" in "View" (Ctrl+Cmd+F / F11, TODO 1221). Replaces the role `togglefullscreen`: if a Web page is in front only the Web contents go
   * full screen, otherwise the window does.
   */
  'menu.fullScreen': 'フルスクリーンを切り替える',
  /**
   * TODO 1221: the bubble shown for a few seconds over the page when Web contents go full screen (same wording as Chrome). It is a surface laid over the page,
   * and the renderer's DOM is under the view and cannot reach it, so main holds it. The word `Esc` is drawn as a key shape inside the bubble.
   */
  'web.fullscreenHint': '全画面表示を終了するには Esc キーを押してください',
  /** Dialog for "Choose another folder..." (T5). */
  'dialog.pickDirectory.title': 'このスレッドはどこで作業するか',
  'dialog.pickDirectory.message': '選んだフォルダは無承認で読まれます',
  'dialog.exportPdf.title': '会話を PDF で保存',
  /** TODO 952 stage 1: choose the OAuth client JSON in the "Account" section of an extension's details. */
  'dialog.oauthClient.title': 'OAuth クライアントの JSON を選ぶ',
  'dialog.exportPdf.fallbackName': '会話',
  'dialog.exportHtml.title': '会話を HTML で保存',
  'dialog.exportMd.title': '会話を Markdown で保存',
  /** TODO 1088: dialogs for exporting and importing threads and settings. */
  'dialog.dataExport.title': 'スレッドと設定を書き出す',
  'dialog.dataImport.title': 'スレッドと設定を読み込む',
  'dialog.dataTransfer.filter': '{app} のデータ',
  /** TODO 1306: choose the backup folder, and the one confirmation before restoring from the newest backup (then restart). */
  'dialog.backupDir.title': 'バックアップの置き場を選ぶ',
  'dialog.backupRestore.message': '直近のバックアップから戻しますか?',
  'dialog.backupRestore.detail':
    '{date} のバックアップの会話と設定を新しいデータベースに入れて、{app} を再起動します。今のデータベースは消さずに別の名前で残します。バックアップより後の会話は戻りません。',
  'dialog.backupRestore.confirm': '戻して再起動',
  /**
   * Note for an image that could not be embedded in an HTML export (TODO 866). A few words on a surface the renderer does not draw (inside a file main writes).
   * Main reads the images, so only main knows which were omitted.
   */
  'export.imageOmitted': '画像を省略しました',
  /**
   * TODO 103 (wave 11 bundle G): when an old version finds a DB whose `user_version` is newer than its own
   * (the downgrade safety net). It quits without opening: nothing is written and it does not degrade to memory-only.
   */
  'dialog.dbTooNew.title': 'このデータは新しい版の {app} が作った',
  'dialog.dbTooNew.message':
    'もっと新しい版の {app} を入れ直すまで、このデータは開けない。壊さないよう、いまは何も変更していない。',
  /**
   * Desktop notifications (item 72). The body is not shown: only these two words. The same wording as the renderer's
   * `thread.untitled` (display of a provisional title, TODO 66) is also kept here for the notification heading
   * (the renderer's dictionary does not reach native UI, so the duplication is intentional).
   */
  'notify.approval': '承認待ち',
  'notify.turnEnded': '回答しました',
  /**
   * Notifications for scheduled-run threads (TODO 323). On completion the body is the start of the response (an exception to item 72,
   * owner decision 2026-10-03). This wording is used only when the start is empty. The awaiting-approval one is worded so it reads as "stopped".
   */
  'notify.scheduledDone': '定期実行が終わりました',
  'notify.scheduledApproval': '定期実行が承認待ちで止まっています',
  /** TODO 1216: the first turn of a conversation started by a trigger has finished (only when the start of the response is empty). */
  'notify.triggerDone': 'トリガーの下書き・レビューができました',
  /** TODO 959: awaiting approval of an operation that sends something out (send, post). The recipient and body are not shown (item 72). */
  'notify.outboundApproval': '外へ送る操作の承認待ち',
  'notify.scheduledOutboundApproval': '定期実行が外へ送る操作の承認待ちで止まっています',
  /**
   * TODO 1265: a reminder (notification only). The heading is the user's title; the body is the user's text, or this word when it is empty.
   * `{time}` is the scheduled time when shown late. The snooze buttons are the notification's actions (`REMINDER_SNOOZE_MINUTES`).
   */
  'notify.reminder': 'リマインダー',
  'notify.reminderLate': '{time} の予定を過ぎていました',
  'notify.snoozeMinutes': '{minutes} 分後にもう一度',
  'notify.snoozeHours': '{hours} 時間後にもう一度',
  'thread.untitled': '新しいスレッド',
  /**
   * TODO 606 (wave 29 bundle B): unsaved viewer drafts when a window is closed or the app quits. If autosave is OFF, "Save changes?"
   * (the same 3 choices as VS Code); if some drafts could not be written and remain (the disk side had changed, etc.), "could not be saved".
   * `{name}` / `{count}` are filled in by `nativeFormat`.
   */
  'dialog.saveDrafts.one': '「{name}」への変更を保存しますか?',
  'dialog.saveDrafts.many': '次の {count} 件のファイルへの変更を保存しますか?',
  'dialog.saveDrafts.detail': '保存しないと、変更は失われます。',
  'dialog.saveDrafts.save': '保存',
  'dialog.saveDrafts.discard': '保存しない',
  'dialog.unsavedDrafts.one': '「{name}」を保存できませんでした',
  'dialog.unsavedDrafts.many': '{count} 件のファイルを保存できませんでした',
  'dialog.unsavedDrafts.detail':
    '編集を始めた後にディスク上で変更されていたか、書き込めませんでした。このまま閉じると、変更は失われます。',
  'dialog.unsavedDrafts.discard': '保存せずに閉じる',
  /** TODO 636: "could not be saved" before a window reload (the wording differs because it reloads rather than closes). */
  'dialog.unsavedDrafts.detailReload':
    '編集を始めた後にディスク上で変更されていたか、書き込めませんでした。このまま再読み込みすると、変更は失われます。',
  'dialog.unsavedDrafts.discardReload': '保存せずに再読み込み',
  /** TODO 967: confirmation on "Relaunch" after the screen recording permission, when a conversation is running. */
  'dialog.relaunch.message': '会話が実行中です。再起動しますか?',
  'dialog.relaunch.detail': '実行中の応答は中断されます。',
  'dialog.relaunch.confirm': '再起動',
  /** TODO 1004: confirmation on Cmd+Q when a conversation is running (once only; there is no "don't ask again"). */
  'dialog.quit.message': '会話が実行中です。終了しますか?',
  'dialog.quit.detail': '実行中の応答は中断されます。',
  'dialog.quit.confirm': '終了',
  'dialog.cancel': 'キャンセル',
  'dialog.more': 'ほか {count} 件'
} as const

export type NativeKey = keyof typeof ja

const en: Record<NativeKey, string> = {
  'menu.newWindow': 'New Window',
  'menu.file': 'File',
  'menu.view': 'View',
  'menu.reload': 'Reload',
  'menu.forceReload': 'Force Reload',
  'recovery.title': 'This window could not be shown',
  'recovery.body': 'The part that draws the window stopped several times in a row. Your conversations keep running. Loading again will not reopen the conversation that was open.',
  'recovery.reload': 'Load Again',
  'recovery.reason': 'Reason code',
  'menu.sidebar': 'Sidebar',
  'menu.threads': 'Threads',
  'menu.files': 'Files',
  'menu.search': 'Search',
  'menu.extensions': 'Extensions',
  'menu.settings': 'Settings…',
  'menu.save': 'Save',
  'menu.newThread': 'New Thread…',
  'menu.hiddenFiles': 'Show Hidden Files',
  'menu.close': 'Close',
  'menu.help': 'Help',
  'menu.helpItem': '{app} Help',
  'menu.about': 'About {app}',
  'menu.hide': 'Hide {app}',
  'menu.quit': 'Quit {app}',
  /** The menu bar icon's menu (TODO 1269). `{count}` is the number of pending approvals (the same source as the Dock badge). */
  'tray.show': 'Show {app}',
  'tray.newThread': 'New Thread',
  'tray.pending': 'Pending approvals: {count}',
  'tray.pendingNone': 'No pending approvals',
  'tray.summary': 'Running {running} / Unread {unread}',
  'tray.rowApproval': 'Awaiting approval: {title}',
  'tray.rowRunning': 'Running: {title}',
  'tray.rowUnread': 'Unread: {title}',
  'tray.more': '{count} more',
  'tray.untitled': 'Untitled',
  'tray.pickFolder': 'Choose Folder…',
  'tray.dictate': 'New Thread with Dictation',
  'tray.scheduleHeader': 'Upcoming',
  'tray.recent': 'Recent Conversations',
  'menu.releaseNotes': 'Release Notes',
  'menu.reportProblem': 'Report a Problem',
  'menu.fullScreen': 'Toggle Full Screen',
  'web.fullscreenHint': 'Press Esc to exit full screen',
  'dialog.pickDirectory.title': 'Where should this thread work?',
  'dialog.pickDirectory.message': 'The folder you choose can be read without approval',
  'dialog.exportPdf.title': 'Save conversation as PDF',
  'dialog.oauthClient.title': 'Choose the OAuth client JSON',
  'dialog.exportPdf.fallbackName': 'Conversation',
  'dialog.exportHtml.title': 'Save conversation as HTML',
  'dialog.exportMd.title': 'Save conversation as Markdown',
  'dialog.dataExport.title': 'Export threads and settings',
  'dialog.dataImport.title': 'Import threads and settings',
  'dialog.dataTransfer.filter': '{app} data',
  'dialog.backupDir.title': 'Choose the Backup Folder',
  'dialog.backupRestore.message': 'Restore from the most recent backup?',
  'dialog.backupRestore.detail':
    'The conversations and settings of the backup from {date} are put into a new database, and {app} restarts. The current database is kept under another name, not deleted. Conversations after the backup are not restored.',
  'dialog.backupRestore.confirm': 'Restore and Restart',
  'export.imageOmitted': 'Image omitted',
  'dialog.dbTooNew.title': 'This data was created by a newer version of {app}',
  'dialog.dbTooNew.message':
    "This data can't be opened until you install a newer version of {app}. Nothing has been changed, to avoid damaging it.",
  'notify.approval': 'Waiting for approval',
  'notify.turnEnded': 'Replied',
  'notify.scheduledDone': 'Scheduled run finished',
  'notify.scheduledApproval': 'Scheduled run is waiting for approval',
  'notify.triggerDone': 'A trigger has prepared a draft or review',
  'notify.outboundApproval': 'Waiting for approval to send something outside',
  'notify.scheduledOutboundApproval': 'Scheduled run is waiting for approval to send something outside',
  'notify.reminder': 'Reminder',
  'notify.reminderLate': 'Was due at {time}',
  'notify.snoozeMinutes': 'Remind me in {minutes} min',
  'notify.snoozeHours': 'Remind me in {hours} hr',
  'thread.untitled': 'New thread',
  'dialog.saveDrafts.one': 'Do you want to save the changes you made to {name}?',
  'dialog.saveDrafts.many': 'Do you want to save the changes to the following {count} files?',
  'dialog.saveDrafts.detail': "Your changes will be lost if you don't save them.",
  'dialog.saveDrafts.save': 'Save',
  'dialog.saveDrafts.discard': "Don't Save",
  'dialog.unsavedDrafts.one': 'Could not save {name}',
  'dialog.unsavedDrafts.many': 'Could not save {count} files',
  'dialog.unsavedDrafts.detail':
    'The file changed on disk after you started editing, or could not be written. If you close anyway, your changes will be lost.',
  'dialog.unsavedDrafts.discard': 'Close Without Saving',
  'dialog.unsavedDrafts.detailReload':
    'The file changed on disk after you started editing, or could not be written. If you reload anyway, your changes will be lost.',
  'dialog.unsavedDrafts.discardReload': 'Reload Without Saving',
  'dialog.relaunch.message': 'A conversation is running. Restart anyway?',
  'dialog.relaunch.detail': 'Responses in progress will be interrupted.',
  'dialog.relaunch.confirm': 'Restart',
  'dialog.quit.message': 'A conversation is running. Quit anyway?',
  'dialog.quit.detail': 'Responses in progress will be interrupted.',
  'dialog.quit.confirm': 'Quit',
  'dialog.cancel': 'Cancel',
  'dialog.more': 'and {count} more'
}

export const NATIVE_DICTIONARIES: Readonly<Record<Locale, Readonly<Record<NativeKey, string>>>> = {
  en,
  ja
}

/** Native UI wording. `{app}` is filled with the public product name (TODO 1254). */
export function nativeText(locale: Locale, key: NativeKey): string {
  return NATIVE_DICTIONARIES[locale][key].replace(/\{app\}/g, PRODUCT_NAME)
}

/** Wording with placeholders such as `{name}` (TODO 606). Unknown placeholders are left as they are. */
export function nativeFormat(
  locale: Locale,
  key: NativeKey,
  values: Readonly<Record<string, string | number>>
): string {
  return nativeText(locale, key).replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole
  )
}
