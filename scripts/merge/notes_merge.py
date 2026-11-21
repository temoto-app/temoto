#!/usr/bin/env python3
"""docs/notes/wave<N>.md の add/add の衝突を解く (TODO 184 / 第 14 波の notes_merge 方式)。

ours (HEAD、index の stage 2) を丸ごと残し、theirs (stage 3) の最初の `## ` 見出し以降だけを末尾に足す。
keepboth.py だと先頭の `# 第 N 波 …` の見出しが 2 重になるため。一時ファイルに書いて os.replace で置き換える。

使い方: python3 scripts/merge/notes_merge.py docs/notes/wave20.md
"""
import os
import re
import subprocess
import sys
import tempfile


def stage(path: str, n: int) -> str:
    return subprocess.run(['git', 'show', f':{n}:{path}'], check=True, capture_output=True).stdout.decode('utf-8')


def main() -> int:
    for path in sys.argv[1:]:
        ours = stage(path, 2)
        theirs = stage(path, 3)
        m = re.search(r'^## ', theirs, re.M)
        if m is None:
            print(f'{path}: theirs に `## ` の見出しが無い', file=sys.stderr)
            return 1
        tail = theirs[m.start():]
        merged = ours.rstrip('\n') + '\n\n' + tail
        if not merged.endswith('\n'):
            merged += '\n'
        d = os.path.dirname(os.path.abspath(path))
        fd, tmp = tempfile.mkstemp(dir=d, prefix='.notes_merge-')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(merged)
        os.replace(tmp, path)
        print(f'{path}: ours + theirs の {tail.splitlines()[0]!r} 以降を足した')
    return 0


if __name__ == '__main__':
    sys.exit(main())
