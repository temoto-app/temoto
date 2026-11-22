# {{app.name}} guide for the AI / {{app.name}} の案内 (AIが読む用)

This folder is written by {{app.name}} itself at every start-up. Do not edit these files; {{app.name}} restores them to the bundled content at every start-up. Other files you put here are left alone.
このフォルダは {{app.name}} が起動のたびに書き出します。ここのファイルは起動のたびに同梱の中身に戻ります (書き換えても残りません)。ほかに置いたファイルは触りません。

## What {{app.name}} is / {{app.name}} とは

{{app.name}} is a desktop app that runs an AI coding agent in conversations ("threads") next to a viewer pane (files, diffs, web pages, documents) and a file tree / search. The user talks to you in the Prompt box; you see only their text. Questions you may get: how to use it, which feature does what, where a setting is, what it cannot do. Answer from `index.html` (read only the section you need), never from memory. If it is not there, say you do not know instead of guessing. / {{app.name}} は AI のコーディングエージェントを会話 (スレッド) で動かすデスクトップアプリで、ファイル・差分・Web・文書を出すビューアと、ファイルツリー・検索が隣にある。利用者は Prompt 欄から話しかける。使い方・機能・設定の場所・できないことを聞かれたら、`index.html` の必要な節だけ読んで答える。記憶で答えない。書いてなければ推測せず分からないと答える。

- `index.html` : the full user help of {{app.name}} (EN / JA in one file). Sections: Getting Started, Prompt, File Attachments, Viewer, Permissions, Settings (`#settings`), AI Configuration, Troubleshooting, Keyboard Shortcuts. Read the section you need, not the whole file. / {{app.name}} の利用者向けヘルプ全体 (日英 1 ファイル)。必要な節だけ読む。
- `ai-guide.md` : this file.

## When the user asks about {{app.name}} settings / 設定について聞かれたら

1. Where is it set? ("〜はどこで設定する?") Look in the Settings section of `index.html` for the section name, tell the user, and show it with the `openSettings` tool. / 場所は `index.html` の「設定」の節で調べて答え、`openSettings` で設定画面のその項目を見せる。
2. What is it now? Call `getSettings`. It returns every key you may read or change, with the current value. The list of keys is **not** in these documents; always ask `getSettings`. / 今の値は `getSettings`。鍵の一覧はこの資料に無い。必ず `getSettings` で引く。
3. Change it ("〜を変えて") with `setSetting` (key name + value, exactly as `getSettings` shows it). Keys that affect safety (approvals, allowed hosts, update, the number of concurrent sessions, key bindings) are put in the approval inbox first, so tell the user to approve. After changing, say what changed (old value, new value). / 変更は `setSetting`。安全に関わる鍵 (承認・許可した接続先・更新・並走数・キー割り当て) は承認箱に積まれるので、利用者に承認を頼む。変えたら前後の値を伝える。
4. If a key is not in `getSettings`, {{app.name}} cannot change it from a conversation. Say so and open the Settings screen with `openSettings` so the user can do it by hand. / `getSettings` に無い鍵は会話からは変えられない。そう答え、`openSettings` で画面を開いて手で変えてもらう。

## Notes / 注意

- Settings of the agent CLI itself (its own config files, hooks, MCP servers) are not {{app.name}} settings; those are edited as ordinary files. / エージェント CLI 自身の設定 (設定ファイル・hooks・MCP サーバ) は {{app.name}} の設定ではなく、普通のファイルとして編集する。
- Opening the Settings screen hides the conversation until the user comes back. / 設定画面を開くと、利用者が戻るまで会話は隠れる。
- Do not guess a setting's name from this document. / 設定の名前をこの資料から推測しない。
