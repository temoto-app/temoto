#!/bin/sh
# Builds the helper that extracts the body text of PDFs (TODO 1009, `npm run build:pdf`). The artifact is out/pdf-helper/pdf-helper, and it is not
# committed (out/ is in .gitignore). main tells the index process <appPath>/out/pdf-helper/pdf-helper.
#
# Outside macOS, or when the Command Line Tools are missing, it warns and does nothing (exit code 0 — it does not fail the whole build).
# An aios without the helper handles PDFs as before, without body text (file name only).
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="$root/out/pdf-helper"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build:pdf: macOS ではないので PDF のヘルパーは組まない" >&2
  exit 0
fi
if ! xcode-select -p >/dev/null 2>&1 || ! command -v swiftc >/dev/null 2>&1; then
  echo "build:pdf: Command Line Tools (swiftc) が無いので PDF のヘルパーは組まない (xcode-select --install)" >&2
  exit 0
fi

mkdir -p "$out"
swiftc -O -o "$out/pdf-helper" "$here/pdf-helper.swift"
codesign --force --sign "${AIOS_SIGN_IDENTITY:--}" --identifier local.aios.pdf-helper "$out/pdf-helper" >/dev/null 2>&1 || \
  echo "build:pdf: codesign に失敗した (動かないかもしれない)" >&2
echo "build:pdf: $out"
