# Temoto — End User License Agreement (EULA)

Version 1.0 (draft) — 2026-11-08

> **日本語の要約 (参考。法的な効力を持つのは下の英語の本文)**
>
> - この規約は、作者が署名して配る **公式のバイナリ** (`Temoto.app` と、その更新) にだけ適用されます。
>   ソースコードは別に **AGPL-3.0** で公開しており、この規約はソースコードや同梱の OSS の権利を一切狭めません。
> - 個人・業務を問わず、無料で使えます。公式のバイナリそのものを再配布・販売することはできません (配るなら公式のリリースのページへのリンクで)。
>   ソースから自分でビルドしたものを AGPL-3.0 に従って配るのは自由ですが、**「Temoto」の名前とロゴは使えません** (別の名前とアイコンにしてください)。
> - Temoto はあなたが自分で入れた AI のコーディング・エージェントの CLI (例: Claude Code) を起動するだけです。その CLI のアカウント・利用規約・料金は
>   あなたと提供元との関係で、作者は利用の仲介も再販もしません。作者は Anthropic と提携していません。
> - 作者はテレメトリを集めません。データはあなたの Mac の中に (暗号化して) 置かれます。
> - AI はコマンドを実行しファイルを変更できます。既定では確認なしに進みます。結果の責任は利用者にあり、無保証です。
> - 準拠法は日本法、管轄は東京地方裁判所です。

---

This End User License Agreement ("Agreement") is between you ("you") and **Motokimi Kuzume**, the author and sole copyright
holder of Temoto ("Licensor"). By installing or using the Software you agree to this Agreement. If you do not agree, do not
install or use the Software.

## 1. Definitions

- **"Software"** means the official binary distributions of Temoto published by Licensor (the `Temoto.app` application bundle,
  signed with Licensor's Apple Developer ID and distributed from Licensor's official release page), together with any updates,
  extensions bundled with it, and accompanying documentation.
- **"Source Code"** means the source code of Temoto published by Licensor at `https://github.com/temoto-app/temoto`
  (or its successor location).
- **"Third-Party Components"** means software components included in the Software that are owned by third parties and licensed under
  their own terms, listed in `THIRD_PARTY_NOTICES.md`.
- **"Agent CLI"** means a command-line AI coding agent that you install and sign in to yourself (for example, Claude Code), which the
  Software launches as a separate process.

## 2. Relationship to the source code license

The Source Code is licensed under the GNU Affero General Public License, version 3 ("AGPL-3.0"), and certain parts (the extension API
under `plugins/_shared/`) under the MIT License. **This Agreement governs only the Software as distributed by Licensor.** Nothing in this
Agreement limits any right you have under AGPL-3.0, the MIT License, or the license of any Third-Party Component. If this Agreement
conflicts with the license of a Third-Party Component as to that component, the Third-Party Component's license prevails.

## 3. License grant

Subject to this Agreement, Licensor grants you a non-exclusive, non-transferable, royalty-free, worldwide license to install and use
the Software on devices that you own or control, for personal or commercial purposes.

## 4. Restrictions

You may not:

1. distribute, sell, rent, lease, sublicense, or otherwise make the Software (Licensor's signed binaries) available to third parties,
   or host it for download, except by linking to Licensor's official release page;
2. distribute a modified copy of the Software under Licensor's signature, or alter or remove its code signature in a way that
   suggests a modified copy is an official distribution;
3. remove or obscure any copyright, license, or trademark notice in the Software;
4. use the Software in violation of applicable law or of the terms of any third-party service you use with it.

If you wish to build, modify, or distribute Temoto yourself, use the Source Code under AGPL-3.0, subject to Section 5.

## 5. Trademarks

"Temoto" and the Temoto logo and icon are trademarks of Licensor (registered or unregistered). Neither this Agreement nor
AGPL-3.0 grants you any right to use them. A product built from the Source Code and distributed by anyone other than Licensor must use a
different name and a different icon, and must not suggest that it is endorsed by Licensor. You may make accurate factual statements such
as "based on the Temoto source code".

## 6. Third-party services

1. The Software does not include an AI model or an Agent CLI. It launches the Agent CLI that you installed, unmodified, under your own
   sign-in. Your use of the Agent CLI and of the AI service behind it is governed solely by your agreement with its provider, and you are
   responsible for complying with those terms and for any fees.
2. Licensor does not intermediate, resell, or bill for any AI usage. Any usage or cost figures the Software computes are estimates for
   visibility of token consumption and do not reflect actual charges.
3. Licensor is not affiliated with, endorsed by, or sponsored by Anthropic or any other AI provider. Product names are used only to
   identify compatible software.
4. Other services you choose to connect (for example, email accounts, web pages, or GitHub) are governed by their own terms.

## 7. Data and privacy

1. The Software runs on your device. Conversation history, the file index, and settings are stored locally in an encrypted database.
2. Licensor does not collect telemetry, usage analytics, or crash reports through the Software.
3. The Software connects to the network only to: check for and download updates of the Software and of the Agent CLI from their official
   release sources; run the Agent CLI, which communicates with its provider under its own terms; and reach services or web pages you
   choose to use.

## 8. Updates

The Software may automatically download and install updates when idle. You can turn automatic updates off in the Software's settings.
An update may come with a revised version of this Agreement, which applies to that update.

## 9. Ownership

The Software is licensed, not sold. Licensor retains all right, title, and interest in the Software and in the trademarks referred to in
Section 5, except for the Third-Party Components and the rights granted to you under the open source licenses referred to in Section 2.

## 10. Your responsibility for agent actions

The Software lets an AI agent read and write files, run commands, and access the network on your device. By default it proceeds without
asking for confirmation, unless you enable confirmations or Plan mode. AI output can be wrong, incomplete, or harmful. You are
responsible for reviewing results, for what the agent does on your behalf, and for keeping backups of your data.

## 11. Disclaimer of warranty

THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, AND NON-INFRINGEMENT. LICENSOR DOES NOT WARRANT THAT THE SOFTWARE WILL BE
UNINTERRUPTED OR ERROR-FREE, OR THAT IT WILL REMAIN COMPATIBLE WITH ANY AGENT CLI OR THIRD-PARTY SERVICE.

## 12. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, LICENSOR SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR
PUNITIVE DAMAGES, OR FOR LOSS OF DATA, PROFITS, OR BUSINESS, ARISING OUT OF OR RELATED TO THE SOFTWARE, AND LICENSOR'S TOTAL LIABILITY
SHALL NOT EXCEED THE AMOUNT YOU PAID FOR THE SOFTWARE (WHICH IS ZERO IF YOU OBTAINED IT FREE OF CHARGE). Nothing in this Agreement
excludes or limits liability that cannot be excluded or limited under applicable law, including liability for wilful misconduct or
gross negligence, or rights you have as a consumer that cannot be waived.

## 13. Termination

This Agreement remains in effect until terminated. It terminates automatically if you breach it. On termination you must stop using
and delete the Software. Sections 2, 5, 6, 9, 11, 12, and 15 survive termination. Termination does not affect your rights under the
licenses referred to in Section 2.

## 14. Export

You must comply with all export control and sanctions laws that apply to your use of the Software.

## 15. Governing law and jurisdiction

This Agreement is governed by the laws of Japan, without regard to conflict-of-laws rules. The Tokyo District Court has exclusive
jurisdiction of first instance over any dispute arising out of or related to this Agreement, except where mandatory consumer protection
law gives you the right to bring proceedings elsewhere.

## 16. General

If any provision is held unenforceable, the remaining provisions remain in effect. This Agreement is the entire agreement between you and
Licensor regarding the Software. If a translation of this Agreement conflicts with the English text, the English text prevails.

Contact: open an issue at `https://github.com/temoto-app/temoto/issues`.
