# Contributing to Temoto

- **CLA:** every contributor signs the [Contributor License Agreement](CLA.md) once. A bot comments on your first pull request; reply with
  the sentence it shows. You keep your copyright; the CLA lets the author distribute Temoto under AGPL-3.0 and under other terms
  (the [EULA](EULA.md) for the official binaries, or a commercial license).
- **License of the source:** AGPL-3.0 ([LICENSE](LICENSE)); the extension API in `plugins/_shared/` is MIT.
- **Name and icon:** "Temoto" and the icon are trademarks of the author. If you distribute your own build, give it a
  different name and icon ([EULA](EULA.md) Section 5).
- **Third-party code:** do not paste code from other projects without stating its source and license in the pull request. New bundled
  libraries go into [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **Before opening a pull request:** run `npm run check` (typecheck, lint, tests, build). Tests never call an AI model.

## 日本語

- 貢献する人は [CLA](CLA.md) に 1 回だけ同意します (最初の PR に Bot がコメントするので、示された一文を返信)。著作権は貢献者に残ります。
- ソースは AGPL-3.0、`plugins/_shared/` の拡張の API は MIT。公式のバイナリは [EULA](EULA.md) で配ります。
- 「Temoto」の名前とアイコンは作者の商標です。自分でビルドしたものを配るときは、別の名前とアイコンにしてください。
- 他のプロジェクトのコードを持ち込むときは、出所とライセンスを PR に書いてください。
- PR の前に `npm run check` を通してください。
