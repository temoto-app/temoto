#!/bin/sh
# Builds the helper that gives image classification labels (TODO 998, `npm run build:vision`). The artifact is out/vision-helper/vision-helper, and it is not
# committed (out/ is in .gitignore). main tells the index process <appPath>/out/vision-helper/vision-helper.
#
# Outside macOS, or when the Command Line Tools are missing, it warns and does nothing (exit code 0 — it does not fail the whole build).
# An aios without the helper handles images as before, by file name only (it cannot search them by their contents).
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="$root/out/vision-helper"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build:vision: macOS ではないので画像の分類のヘルパーは組まない" >&2
  exit 0
fi
if ! xcode-select -p >/dev/null 2>&1 || ! command -v swiftc >/dev/null 2>&1; then
  echo "build:vision: Command Line Tools (swiftc) が無いので画像の分類のヘルパーは組まない (xcode-select --install)" >&2
  exit 0
fi

mkdir -p "$out"
swiftc -O -o "$out/vision-helper" "$here/vision-helper.swift"
codesign --force --sign "${AIOS_SIGN_IDENTITY:--}" --identifier local.aios.vision-helper "$out/vision-helper" >/dev/null 2>&1 || \
  echo "build:vision: codesign に失敗した (動かないかもしれない)" >&2
echo "build:vision: $out"
