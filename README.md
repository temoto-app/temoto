# Temoto

[English](#english) | [日本語](#日本語)

## English

Temoto is a macOS desktop app that runs the AI coding agent CLI you already have installed (Claude Code, or OpenCode with free / local
models) as a child process, and puts your conversations, approvals, a searchable index of your Mac and file viewers into one window.
It does not bundle or modify the CLI.

Temoto (from the Japanese 手元, "at hand") is not related to the TeMoto robotics framework or to other projects named Temoto.

What it is about is not any single piece but that the pieces **work together**:

- **An index and conversation search the AI can see.** A Japanese-aware full-text index of your whole Mac, plus your past conversations,
  is exposed to the agent through an MCP gateway, so the agent can search your files and earlier threads.
- **A layer of control: Broker, approvals, audit.** File and network access of extensions goes through a capability broker with path and
  network policies and an audit log. Approvals from the agent land in one inbox instead of interrupting the terminal.
- **A conversation is a bundle of a task.** Each thread keeps its messages, approvals, files it opened and viewers together.

Also in the window: file viewers (text, Markdown, images, diff, PDF, video and audio, Office, HTML, ...) built as sandboxed extensions.

You can use **Claude Code and OpenCode (free models, or local models through Ollama) in one window**. For OpenCode, install it with
`brew install opencode` (Temoto does not bundle it). For a local model, start [Ollama](https://ollama.com/download) and run
`ollama pull gpt-oss:20b` (about 13 GB). Whether the CLI is installed, whether Ollama responds and which models are available are shown in the
"Agent CLI" section of Settings. You choose the backend when you create a new thread.

- **Supported**: macOS on Apple Silicon (arm64) only. Linux and Windows are not supported.
- **Install with the DMG** (no `gh` needed): download `Temoto-<version>-arm64.dmg` from the [Releases page](https://github.com/temoto-app/temoto/releases/latest)
  in a browser, open it and drag `Temoto.app` to `Applications`. It is notarized, so Gatekeeper lets it through. A Temoto placed in `/Applications`
  is registered for automatic updates on its first launch (no prompt). If `/Applications` is not writable, or the app is launched directly from
  somewhere else (the download folder, or inside the mounted DMG), updates do not run and Settings shows the reason.
- **Install from Terminal**: `curl -fsSLO https://github.com/temoto-app/temoto/releases/latest/download/install-temoto.sh && bash install-temoto.sh`.
  It downloads the latest release, verifies its SHA-256 and signature, places `Temoto.app` in `~/Applications` and starts it; Temoto then updates itself.
  No GitHub account is needed (if the [GitHub CLI](https://cli.github.com) is installed and logged in, it is used instead). Options: `bash install-temoto.sh --help`.
  If you ran a version under the previous name (aios), run the same command again (the old version does not look at the new update location, so it
  cannot update itself to Temoto). Conversations, settings and the index carry over (on that Mac the data folder, the Keychain item "aios Safe Storage" and
  `~/aios/` keep the previous name). You can delete the leftover `aios.app` afterwards.
- **Permissions**: Temoto runs the agent in a Bypass-permissions-like mode by default: tool calls (shell, file writes, `gh`, `git push`, ...)
  are approved automatically. It only asks for the agent's questions, plans you turned on, and messages that reach people (mail, chat).
  Use it knowing that.
- **Problems**: if the window crashes, Temoto reloads it by itself (up to 3 times a minute). "Help > Report a Problem" (also in Settings > About)
  writes one text file (version, OS, recent log with secrets, e-mail addresses and your user name masked; no conversation text) to your Downloads
  folder and shows it in Finder. Nothing is sent: read it, then attach it to an issue at <https://github.com/temoto-app/temoto/issues>.
- **Disclaimer**: Temoto does not intermediate or resell Claude usage. Logging in to the CLI (subscription or API key) is yours and so is
  the responsibility for it. Temoto never reads the CLI's credentials and does not restrict how you authenticate. Cost figures are for
  token-consumption visibility only and are not charges.
- **License**: AGPL-3.0 (see [LICENSE](LICENSE)). The extension API under [plugins/_shared/](plugins/_shared/) (the viewer bridge and its
  types, which a third party touches when writing an extension) is MIT ([plugins/_shared/LICENSE](plugins/_shared/LICENSE)), so writing an
  extension does not pull your code under the AGPL. Bundled third-party libraries: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
  The official signed `Temoto.app` is distributed under the [EULA](EULA.md) (it does not narrow your AGPL rights to the source); "Temoto"
  and its icon are trademarks, so your own build needs another name. Contributions need the [CLA](CLA.md) — see [CONTRIBUTING.md](CONTRIBUTING.md).

## 日本語

Temoto (手元) は、Claude Code の CLI を子プロセスとして動かす macOS のデスクトップアプリ (Electron)。スレッドごとの会話、承認の受け箱、
Mac 全体のファイルの索引と日本語の検索、ファイルのビューアを 1 つの窓にまとめる。CLI は同梱も改変もせず、
利用者が入れてログインしたものをそのまま使う。

新規性は部品の一つ一つではなく、**部品が連動して動く環境**にある:

- **索引と会話の検索を AI に見せる口** — Mac 全体のファイルの索引と過去の会話を MCP のゲートウェイ越しにエージェントが引ける。
- **Broker と承認・監査の統制の層** — 拡張機能の特権の操作はパスとネットワークの検査・監査ログのある CapabilityBroker を通り、
  エージェントの承認は 1 つの受け箱に集まる。
- **会話 = タスクの束** — メッセージ・承認・開いたファイル・ビューアがスレッドにまとまる。

**Claude Code と OpenCode (無料のモデル / Ollama のローカルモデル) を 1 つの窓で**使える。OpenCode を使うなら
`brew install opencode` で入れる (Temoto は同梱しない)。ローカルのモデルは [Ollama](https://ollama.com/download) を起動して
`ollama pull gpt-oss:20b` (約 13 GB)。入っているか・Ollama が応答するか・どのモデルが使えるかは、設定の「エージェント CLI」の欄に出る。
新しいスレッドを作るとき、バックエンドを選べる。

### 入れ方

**DMG で入れる** (`gh` は要らない): [Release のページ](https://github.com/temoto-app/temoto/releases/latest) から `Temoto-<版>-arm64.dmg` をブラウザで落とし、
開いて `Temoto.app` を `Applications` へドラッグする。公証済みなので Gatekeeper の確認は通る。
`/Applications` に入れた Temoto は、初回の起動で自動更新の対象に登録される (聞かれない。更新に `gh` は要らない)。`/Applications` に書けない入れ方 (権限がない等) では更新は動かず、設定の更新の欄に理由が出る。`/Applications` 以外 (ダウンロードの場所やマウントした DMG の中) から直接起動したものは対象外。

**端末で入れる** (GitHub のアカウントも `gh` も要らない):

```sh
curl -fsSLO https://github.com/temoto-app/temoto/releases/latest/download/install-temoto.sh && bash install-temoto.sh
```

最新の Release から zip を取り、SHA-256 と署名を確かめ、`~/Applications/Temoto.app` に置いて起動する。その後は Temoto が自分で更新する
(設定 (⌘,) の「更新」で止められる)。[gh](https://cli.github.com) が入っていてログインしてあれば、取るのに gh を使う
(`gh release download -R temoto-app/temoto -p install-temoto.sh --clobber && bash install-temoto.sh` でも同じ)。オプションは `bash install-temoto.sh --help`。

前の名前 (aios) の版を入れていた人は、上のコマンドでもう一度入れる (前の版は新しい置き場を見ないので、自分では Temoto に更新されない)。
会話・設定・索引はそのまま引き継ぐ (その Mac では、データの置き場・キーチェーンの項目「aios Safe Storage」・`~/aios/` は前の名前のまま使い続ける)。
入れた後、残った `aios.app` は消してよい。

### 免責

Temoto は Claude の利用を仲介も再販もしない。CLI のログイン (サブスクリプション / API キー) は利用者自身のもので、その責任も利用者にある。
Temoto は CLI の認証情報を読まず、認証の方法を制限しない。画面に出る費用の数字は (出す場合も) トークン消費を見るためのもので、
実際の請求額ではない。

Temoto は既定で Bypass permissions 相当で動く: ツールの実行 (シェル・ファイルの書き込み・`gh`・`git push` など) は自動で許可する。
聞くのは AI の質問、利用者が ON にした Plan、人に届くメッセージの送信 (メール・チャット) だけ。そのつもりで使うこと。

### ライセンス

本体は **AGPL-3.0** ([LICENSE](LICENSE))。ただし拡張機能 (plugin) を書く第三者が触る API — [plugins/_shared/](plugins/_shared/) の
viewer の bridge と型 — だけは **MIT** ([plugins/_shared/LICENSE](plugins/_shared/LICENSE))。拡張を書いても AGPL は及ばない。
同梱している第三者のライブラリの許諾は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
作者が署名して配る `Temoto.app` は [EULA](EULA.md) で配る (ソースに対する AGPL の権利は狭めない)。「Temoto」の名前とアイコンは商標なので、
自分でビルドしたものを配るときは別の名前にする。貢献には [CLA](CLA.md) への同意が要る ([CONTRIBUTING.md](CONTRIBUTING.md))。
