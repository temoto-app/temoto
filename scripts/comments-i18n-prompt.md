# Instructions: translate (or delete) Japanese source comments

You are given a set of source files whose comments are in Japanese. Your job is to make every comment in
your assigned paths English, **or delete it when it adds nothing**, using the tooling in `scripts/`. You never
edit the source files by hand: you only write translations into JSON, and `apply` writes them back at the exact
comment positions and proves that nothing except comments changed.

Work in the repository root, in the worktree you were given. Read `scripts/comments-glossary.json` first.

## Procedure

1. **See the size.** `node scripts/comments-i18n.mjs stats --depth 3 <your paths>`
2. **Extract in small chunks.**
   `node scripts/comments-i18n.mjs extract --out /tmp/<bundle>/chunks --chunk-chars 12000 <your paths>`
   This writes `0001.json`, `0002.json`, ... plus `index.json` (do not edit `index.json`). Use `--per-file` if
   you prefer one JSON per source file. Each item looks like:
   `{ id, file, kind, line, count, src, codeBefore?, next: [up to 3 following code lines], fixedPrefix?, en: "" }`
   - `src` is the comment exactly as in the file (delimiters and indentation included).
   - `count` > 1 means the same comment text occurs several times in the file; one translation covers all of them.
   - `kind` is `line` (a run of `//` or `#` lines), `trailing` (after code on the same line), `jsdoc` (`/** */`) or `block`.
   - `fixedPrefix` appears on directive comments (see below).
3. **Fill `en` in each chunk file**, one chunk at a time:
   - a string = the English replacement (the whole comment, delimiters included, same kind of comment),
   - `null` = delete the comment,
   - `""` or missing = not done yet (it is simply left alone and counted as pending).
   Keep every other field unchanged, in particular `file` and `src` (they are how the item is found again).
   Write the file back as valid JSON (escape `\n`, `"` and `\`). A small script that sets `en` from a map is fine;
   never hand-edit the real sources.
4. **Apply each chunk right after you finish it.**
   `node scripts/comments-i18n.mjs apply /tmp/<bundle>/chunks/0001.json` (a directory also works: it applies every `*.json` in it).
   - Items are matched by (file, comment text), not by position, so chunks can be applied in any order, a partial
     chunk is fine, and running `apply` again is a no-op.
   - The output line is a JSON summary: `replaced`, `deleted`, `pending`, `alreadyDone`, `stale`, `itemErrors`, `filesSkipped`.
   - `--dry-run` checks everything without writing.
5. **Fix every error it prints** (see "When apply fails") and re-run until `itemErrors` and `filesSkipped` are 0.
6. **Finish with the repository checks** for your paths: `node scripts/lint-comments.mjs <your paths>` must print
   "no Japanese in comments" (after you are done), then `npm run typecheck`, `npm run lint:terms`, and the tests that
   touch the files you changed (`npx vitest run <test files>`; never run `npm run test:contract`). The merge side runs `npm run check`.
7. Report the numbers: items, translated, deleted, kept-Japanese (should be 0), pending (should be 0).

## What to translate and what to delete

Delete (`en: null`) a comment when a reader of the next line of code learns nothing from it:

- It restates the next line, the function/variable name, or the type in other words
  (`// ループで回す`, `/** スレッド一覧を取得する。 */` above `getThreads()`, `/** 名前 */` above `name: string`).
- A section banner or divider with no information (`// ---- 型 ----`) - unless the file is long and the banner is its only structure; then translate.
- A leftover marker (`// 追記`, `// ここから`) or commented-out code.
- A comment that is obviously false or about a thing that no longer exists (report it; do not guess).

Keep and translate when it carries any of:

- the **why**: a reason, a trade-off, a decision, an owner decision, a measured number;
- a **constraint or invariant**, an ordering requirement, a thread/process boundary, a security or privacy rule;
- a **trap / pitfall / race / ASI / platform quirk** and what breaks without the code;
- **units, formats, ranges** (ms, bytes, 1-based, UTF-16 offsets);
- a **reference** to `TODO N`, `item N`, `ARCHITECTURE x.y`, a review, a wave, a spike - keep every number exactly;
- a **historical reason** the code looks odd.
- `@param` / `@returns` text that says something the signature does not (units, allowed values, who owns it).

If you hesitate, **keep and translate**. Wrongly deleting a "why" is costly; wrongly keeping a redundant
comment is cheap. When a long JSDoc is half restatement and half "why", translate it but cut the restating
sentences (that is allowed: the translation may be shorter than the source). There is no target ratio: files dense with "why" comments end up with only a few percent deleted, and that is fine.
Do the translation and the deletion decision in the same pass, item by item.

## Style of the English

- Plain, concise, natural English sentences. No word-for-word calques of Japanese sentence shape; no marketing tone.
- Do not lose information, and do not add any: no new claims, no explanations of your own. If the source is
  ambiguous, translate the ambiguity faithfully (and mention it in your report).
- Use the glossary terms consistently (`wave`, `bundle`, `entry point`, `choke point`, `index`, `scan`, `canonical copy`,
  `approval`, `window`, `user`, `item N`, ...). `TODO N` stays `TODO N`.
- Keep identifiers, paths, flags, numbers, dates, code spans in backticks, `**bold**` emphasis and list markers.
  Keep Markdown-ish structure of the original (bullets stay bullets).
- Use ASCII punctuation: `,` `.` `:` `(` `)` `"`. Full-width forms and Japanese quotes make `apply` reject the text
  ("Japanese remains"). Arrows (`->`, `→`), `—`, `…`, `×` are fine.
- Keep the original shape: a `//` run stays a `//` run (you may change the number of lines); a `/** */` block stays a
  `/** */` block with ` * ` on every inner line; a trailing comment stays one line; `///` stays `///`.
- Line length: wrap near 100-120 columns like the source does; exact wrapping is not checked. You do not need to indent
  continuation lines - `apply` re-indents them to the comment's own indent.
- Copy every backtick code span of the source character for character, including a `…` inside it (do not turn it into `...`),
  and do not drop a span by rephrasing around it: `apply` rejects both. A span that contains Japanese cannot be copied;
  describe it instead (for example: the Japanese word for "document").
- Never put `*/` inside a block comment's text, never put a newline in a trailing (same-line) comment.
- Do **not** write the backend/CLI product name anywhere in an English comment (constraint 6, enforced by
  `npm run lint:terms` and by `apply` itself): where the source says the CLI or the agent command line tool, write
  "the CLI". Such names may appear only in the two adapter directories under `src/main/session/` and in `compat/`
  (see `compat/forbidden-terms.json`); if the Japanese source already contains such a word (so it is in one of those
  places), keep that word as it is. Plain prose with no product name is always fine.

## Things you must not touch

- **Anything that is not a comment**: string literals, template text, regular expressions, JSX text, test names
  (`it('...')`, `describe('...')`), UI strings, i18n dictionaries, reason codes, test data. Japanese there is
  intentional (the app has a Japanese UI). `apply` also verifies this: the file's comment-free token stream
  must be identical after the edit, otherwise the file is not written at all.
- **Directive comments** (`// eslint-disable...`, `// @ts-expect-error`, `// @ts-ignore`, `/* v8 ignore ... */`,
  `#!`, `//# sourceMappingURL`, `/// <reference`, `@vitest-environment`, `@jsx...`, `# shellcheck`, ...).
  They are not extracted unless they carry a Japanese explanation (typically after ` -- `). Then the item has
  `fixedPrefix`: your `en` must **start with exactly that text** and only the explanation after it is translated:
  `// @ts-expect-error -- 型の無い .mjs` -> `// @ts-expect-error -- untyped .mjs`. Directives cannot be deleted.
  A directive that has Japanese but **no ` -- ` separator** cannot be translated by `apply` (it refuses): leave its `en` as `""` and list it in your report; the merge side fixes those by hand.
- A JSX comment slot `{/* ... */}` cannot be deleted (it would leave `{}`); translate it.
- Do not edit `scripts/comments-i18n.mjs`, `scripts/lib/`, `scripts/lint-comments.mjs` or `scripts/comments-allow.json`.
  If a comment truly must stay Japanese (for example it quotes a Japanese UI string that cannot be described
  otherwise), set `"keepJa": true` on that item and write the English with the quoted string in it; list those
  in your report so the merge side can add them to `scripts/comments-allow.json`. Use this very rarely.

## What `apply` checks (so you know why it rejects)

Per item (the item is skipped, other items still apply, exit code 1):

- No Japanese characters or full-width punctuation remain in `en` (unless `keepJa`).
- No backend product name (constraint 6) unless the source already had it.
- Block comments: same opener (`/**` vs `/*` vs `/*!`), end with exactly one `*/`, no other `*/` inside, inner
  lines start with `*` when the source's did, an inline block comment stays on one line.
- Line comments: every line is a comment line of the same kind; trailing comments stay on one line.
- Directive comments keep their fixed prefix.
- Content guards (skip with `"loose": true` on an item only when you have a good reason, and say so in your report):
  JSDoc tags and `@param` names are the same list in the same order, `{@link x}` targets are the same,
  every backtick code span without Japanese in the source still appears in the translation, and numbers that
  follow `TODO` / `item` / `ARCHITECTURE` (and dotted numbers like `4.6.4`) are still present.

Per file (the file is not written, exit code 1): the token stream without comments (plus the position of line
breaks, for automatic semicolon insertion) differs from the original; for `.sh` the result must still pass `bash -n`;
for `.py` the AST must be identical.

## When apply fails

- `ERROR file:line: <reason>`: fix that item's `en` (the message names the rule) and apply the chunk again.
  The other items were already applied; re-applying is safe.
- `STALE`: the comment text is no longer in the file (someone else changed it, or you edited `src`). Re-run `extract`
  for that file and redo the item. Never edit `src` to make it match.
- `SKIP file: non-comment tokens changed (verification failed)`: this should be impossible with valid items; do not
  work around it. Re-extract that file, apply its items one by one (`--dry-run` first) to find the offending item,
  and report it.
- `SKIP file: CRLF files are not supported`: report it, skip the file.
- If the JSON itself fails to parse, you broke the quoting; regenerate the chunk with `extract` and redo it.
- Unsupported file types (for example `.swift`, `.html`, `.svg`) are not extracted; mention them in your report if
  `lint-comments` or `stats` shows Japanese there.

Never run `git commit` on a source tree whose last `apply` reported errors without saying so in your report.
