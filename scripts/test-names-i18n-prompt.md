# Instructions: translate Japanese test names to English

You are given a set of test files whose test names (the first argument of `describe(...)` / `it(...)` / `test(...)`
and their `.only` / `.skip` / `.each(...)` / `.skipIf(...)` forms) are in Japanese. Make every such name English
using the tooling in `scripts/`. You never edit a test file by hand: you only write translations into JSON, and `apply`
writes them back into the exact literals and proves, by re-parsing, that nothing except the name literals changed.

Work in the repository root, in the worktree you were given. Read `scripts/comments-glossary.json` first (the same
glossary as for the comment translation: same Japanese word, same English word everywhere).

## Procedure

1. **See what is left in your files.** `node scripts/test-names-i18n.mjs check <your files or dir>` (exit code 1 while Japanese names remain).
2. **Extract in small chunks.**
   `node scripts/test-names-i18n.mjs extract --out /tmp/<bundle>/chunks --chunk-items 150 <your files...>`
   writes `0001.json`, ... and `index.json` (do not edit `index.json`; `--per-file` writes one JSON per test file).
   An item looks like
   `{ id, file, kind, callee, quote, start, end, line, count, parents?, src, en: "" }`:
   - `src` is the name as the test runner sees it (already unescaped), never edit it: it is how the item is found again.
   - `parents` are the enclosing `describe` names (use them for context: the topic of the file).
   - `count` > 1: the same name occurs several times in the file; one translation covers all of them.
   - `kind` is `string`, `template` (backticks, no substitution) or `template-sub` (backticks with `${expr}` written back inside `src`).
3. **Fill `en` in each chunk**, a string = the English name. `""` or missing = not done yet. A test name cannot be deleted
   (`null` is rejected). Keep every other field unchanged. A small script that sets `en` from a list is fine; write valid JSON.
4. **Apply each chunk right after you finish it.** `node scripts/test-names-i18n.mjs apply /tmp/<bundle>/chunks/0001.json`
   (a directory applies every `*.json` in it; `--dry-run` checks without writing). Items are matched by (file, name), not by
   position, so chunks can be applied in any order and running `apply` again is a no-op (`alreadyDone`).
5. **Fix every error it prints** and apply again until `itemErrors` and `filesSkipped` are 0. Warnings
   (`Japanese remains`, `duplicate name after translation`) must be looked at: fix them, or say in the report why they stay.
6. **Finish**: `node scripts/test-names-i18n.mjs check <your files>` prints no remaining names (names that are only a quoted
   Japanese string are listed separately and are allowed), `npx vitest run <your files>` passes (never `npm run test:contract`),
   `npm run typecheck`, `npm run lint`.
7. Report: items, translated, left (should be 0), warnings, files that `apply` refused.

## How to write the English

- A short, natural **present tense** sentence that says what the test shows, the way a spec reads:
  `returns an empty list when nothing matches`, `rejects a relative path`, `does not call the model`, `keeps the draft after switching threads`.
  Start with a verb (`returns`, `rejects`, `does not`, `keeps`, `shows`, `opens`, `falls back to`, `is ... when`). No "should", no "test that".
- `describe` names are the subject (a noun phrase or the function / feature under test): `thread store`, `parseEvent`, `path policy`.
  Keep the structure `describe` + `it` reads as a sentence where it did in Japanese.
- Do not lose information and do not add any: if the Japanese lists three conditions, the English lists three.
- Keep **identifiers, paths, flags, code, symbols and numbers exactly** (`createdWithHistory`, `file://`, `--resume`, `0 / 1`, `%`).
- Keep **reference numbers**: `TODO 123` stays `TODO 123`; `項目 55` becomes `item 55`; `第 N 波` becomes `wave N`;
  `ARCHITECTURE 4.6.4` and `T19` / `P1` stay. `apply` rejects a name whose reference numbers disappeared
  (`"loose": true` on an item only with a good reason, and say so in the report).
- **Placeholders must come out the same, in the same order**: `%s` `%d` `%i` `%f` `%j` `%o` `%O` `%p` `%#` `%%`, `$name`
  (a `.each` table interpolation) and `${expr}` (a template substitution: copy `${...}` character for character). `apply` rejects a change.
  The text around them is free, and the order of the words may change as long as the placeholders keep their order.
- Use the glossary's English for recurring words (`wave`, `bundle`, `approval`, `thread`, `scan`, `index`, `user`, ...).
- **Japanese the test checks may stay Japanese.** When a name quotes a Japanese UI string or Japanese data that the test asserts
  (inside 「…」, 『…』 or quotes, e.g. `shows the label 「承認待ち」`), keep that quoted part verbatim and translate only the rest.
  Do not translate a quoted string just to make the name "all English": the name must say which string the test looks at. `check`
  counts a name whose only Japanese is inside such quotes as allowed. Anything else must be English (including full-width
  punctuation: use ASCII `,` `.` `:` `(` `)`).
- Do **not** write the backend / CLI product name in a name (constraint 6; `apply` rejects a name that adds one): write "the CLI".
  If the Japanese source already has such a word, keep it as it is.
- Quotes: write plain text. `apply` escapes `'` and `"` for you (it switches the literal's quote when that avoids an escape).
- No leading or trailing spaces, no line breaks.
- Names that become identical inside one `describe` (two `it`s with the same English) are reported as a duplicate warning:
  make them differ (the Japanese differed for a reason).

## Things you must not touch

- Anything that is not the first argument of a test call: test bodies, data, assertions, `expect(...).toMatch(/日本語/)`, comments,
  helper functions. Japanese there is intentional. `apply` verifies this: the file's token stream with name literals masked
  must be identical after the edit, otherwise the file is not written at all.
- Do not edit `scripts/test-names-i18n.mjs` or `scripts/lib/`.
- Names the tool cannot extract (a `.each` table of labels, a name built by concatenation) are listed by `check` as
  "not extractable". If they are in your files, translate them by hand, **only the label strings**, and list them in your report.
- The test runner's `-t "<日本語>"` patterns in `docs/notes/test-commands.md` and notes stop matching when a name is translated;
  do not edit the docs: list the patterns that no longer match in your report.

## What `apply` checks (so you know why it rejects)

Per item (the item is skipped, other items still apply, exit code 1): `en` is a string without control characters or
surrounding whitespace; the placeholders are the same list in the same order; no backend product name is added; reference
numbers (`TODO` / `item` / `ARCHITECTURE` / constraint) are still present.

Per file (the file is not written, exit code 1): after the rewrite and a re-parse, the token stream outside the name
literals is identical, the number of name literals is the same, and every literal reads back as exactly the expected text.
