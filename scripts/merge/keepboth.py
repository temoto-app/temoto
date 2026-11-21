#!/usr/bin/env python3
"""合流の衝突を「両方残す」で解く (TODO 184)。

    python3 scripts/merge/keepboth.py [--theirs-first] [--comma] <file>...

- 既定は HEAD (いまのブランチ = main) の塊 → theirs (合流する束) の塊の順に並べる。
- --theirs-first: theirs の塊を先に置く (TODO.md: 束の「対応」段落を先に)。
- --comma: 先に置く塊の最後の非空行に `,` を補う (辞書・配列の末尾が両方から伸びたとき)。
  .css / .md には指定しても補わない (項目 238: CSS の `},` は次の規則を捨てる)。
  拡張子が .ts / .tsx のファイルは指定が無くても補う。ただし先の塊が import / export / 宣言 / `;` で終わる文などの
  「文」らしいときは補わない (TODO 935: import の追加どうしの衝突が `import { b } from './b.js',` になって構文を壊した)。
  `--comma` を明示したときは、文らしくても従来どおり補う。
  `;` なしの呼び出し行 (`doA()`) は塊だけでは要素と区別できないので、衝突の外の文脈も見る (TODO 944):
  いちばん内側の開いた括弧が `=>` / `)` / `else` / `class …` の直後の `{` (関数・文の本体) なら補わない。
  辞書・配列・引数の中や、括弧が開いていない (判定できない) ときは従来どおり。
- .md で先に置く塊が空行で終わっていなければ、塊の間に空行を 1 つ挟む。
- diff3 形式 (`|||||||` の祖先の塊) は捨てる。

書き込みは同じディレクトリの一時ファイルに書いてから os.replace で置き換える。
`open(path, 'w')` で直に書くと、書いている途中の (空にされた・短い) ファイルを
別のプロセスが読みうる — 2026-09-27 に手引きが 262,144 バイトで切れた原因。
"""
import argparse
import os
import re
import sys
import tempfile


STATEMENT_START = re.compile(
    r'^\s*(?:import|export|const|let|var|function|async\s+function|class|abstract\s+class|interface|type|enum|declare|'
    r'namespace|if|else|for|while|do|switch|try|catch|finally|return|throw|await|break|continue)\b(?!\s*[:,?])|^\s*@'
)
COMMENT_LINE = re.compile(r'^\s*(?://|/\*|\*)')


def looks_like_statement(chunk):
    """先に置く塊が、`,` を要る「要素」でなく「文・import・コメント」らしいか (TODO 935)。"""
    nonblank = [line for line in chunk if line.strip()]
    if not nonblank:
        return False
    # Even if the first line is a `// TODO NNN:` comment, the item is still an item (it is normal to put it above a newer item in the dictionary).
    # The check excludes comment lines, and treats the block as a "statement" only when everything is a comment.
    core = [line for line in nonblank if not COMMENT_LINE.match(line)]
    if not core:
        return True
    return bool(STATEMENT_START.match(core[0])) or core[-1].rstrip().endswith(';')


BLOCK_OPENER = re.compile(
    r'(?:=>|\)|\)\s*:\s*[\w<>\[\]|&.,\s]+?|\b(?:else|try|finally|do|static)|(?:^|[;{}]|\b(?:export|default|abstract|declare))\s*(?:class|interface|namespace|module)\b(?!\s*[:,?=])[^{]*)\s*$'
)


def enclosing_is_block(before):
    """衝突の直前までの文面で、いちばん内側の開いた括弧が「関数・文の本体の `{`」か (TODO 944)。

    `{` が `=>` / `)` / `else` / `class …` の直後なら本体 (文が並ぶ。`,` は要らない)。
    辞書・配列・引数 (`= {` `[` `(` `({` など) や、括弧が開いていない (判定できない) ときは False。"""
    stack = []  # (the bracket, and the string before the bracket on its line)
    in_block_comment = False
    quote = None  # Only a template literal (`) spans lines. ' and " are closed at the end of the line.
    for line in before:
        i = 0
        while i < len(line):
            c = line[i]
            two = line[i:i + 2]
            if in_block_comment:
                if two == '*/':
                    in_block_comment = False
                    i += 1
            elif quote:
                if c == '\\':
                    i += 1
                elif c == quote:
                    quote = None
            elif two == '//':
                break
            elif two == '/*':
                in_block_comment = True
                i += 1
            elif c in '\'"`':
                quote = c
            elif c in '{[(':
                stack.append((c, line[:i]))
            elif c in '}])' and stack:
                stack.pop()
            i += 1
        if quote != '`':
            quote = None
    if not stack or stack[-1][0] != '{':
        return False
    return bool(BLOCK_OPENER.search(stack[-1][1]))


def resolve(text, theirs_first, comma):
    lines = text.split('\n')
    out = []
    i = 0
    n = 0
    while i < len(lines):
        if not lines[i].startswith('<<<<<<< '):
            out.append(lines[i])
            i += 1
            continue
        head, base, theirs = [], [], []
        i += 1
        target = head
        while i < len(lines) and not lines[i].startswith('>>>>>>> '):
            line = lines[i]
            if line.startswith('||||||| '):
                target = base
            elif line == '=======' or line.startswith('======= '):
                target = theirs
            else:
                target.append(line)
            i += 1
        if i >= len(lines):
            raise ValueError('衝突の印が閉じていない (>>>>>>> が無い)')
        i += 1
        first, second = (theirs, head) if theirs_first else (head, theirs)
        first = list(first)
        # comma is True (always) / 'auto' (the default for .ts: do not add one to a block that looks like a statement) / False.
        # With 'auto', a call line without `;` (`doA()`) cannot be told apart from an element, so if the enclosing block is the body `{`, it does not add one (TODO 944).
        if comma is True or (
            comma == 'auto' and not looks_like_statement(first) and not enclosing_is_block(out)
        ):
            for k in range(len(first) - 1, -1, -1):
                if first[k].strip():
                    if not first[k].rstrip().endswith(','):
                        first[k] = first[k].rstrip() + ','
                    break
        out.extend(first)
        out.append(None)  # A mark of the boundary between blocks (used to judge the blank lines in md).
        out.extend(second)
        n += 1
    return out, n


def main():
    ap = argparse.ArgumentParser(description='合流の衝突を両方残す形で解く')
    ap.add_argument('--theirs-first', action='store_true')
    ap.add_argument('--comma', action='store_true')
    ap.add_argument('files', nargs='+')
    args = ap.parse_args()
    for path in args.files:
        with open(path, encoding='utf-8') as f:
            text = f.read()
        # Item 238: `,` is added only to code that holds dictionaries and arrays. Adding it to CSS makes the `},` throw away the next rule
        # whole (the band became transparent). It is not needed for Markdown either.
        if args.comma and not path.endswith(('.css', '.md')):
            comma = True
        elif path.endswith(('.ts', '.tsx')):
            comma = 'auto'
        else:
            comma = False
        try:
            parts, n = resolve(text, args.theirs_first, comma)
        except ValueError as err:
            print(f'{path}: {err}', file=sys.stderr)
            sys.exit(1)
        lines = []
        for k, line in enumerate(parts):
            if line is None:
                prev = lines[-1] if lines else ''
                nxt = parts[k + 1] if k + 1 < len(parts) else ''
                if path.endswith('.md') and prev.strip() and nxt is not None and nxt.strip():
                    lines.append('')
                continue
            lines.append(line)
        result = '\n'.join(lines)
        directory = os.path.dirname(os.path.abspath(path))
        fd, tmp = tempfile.mkstemp(dir=directory, prefix='.keepboth-', suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.write(result)
            os.chmod(tmp, os.stat(path).st_mode & 0o7777)
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise
        print(f'{path}: {n} 件を解いた ({len(result.encode())} バイト)')


if __name__ == '__main__':
    main()
