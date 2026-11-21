#!/bin/sh
# Builds the input-source helper (TODO 463, `npm run build:input-source`). The artifact is out/input-source-helper/input-source-helper, and it is not
# committed (out/ is already in .gitignore). main looks for <appPath>/out/input-source-helper/input-source-helper.
#
# Outside macOS, or when the Command Line Tools are missing, it warns and does nothing (exit code 0 — it does not fail the whole build).
# An aios without the helper only fails to switch the input source when the search field gets focus (search itself still works).
# The same approach as the voice-input helper (tools/speech-helper/build.sh, item 226). TIS needs no special permission (TCC), so
# Info.plist is not embedded.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="$root/out/input-source-helper"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build:input-source: macOS ではないので入力ソースのヘルパーは組まない" >&2
  exit 0
fi
if ! xcode-select -p >/dev/null 2>&1 || ! command -v swiftc >/dev/null 2>&1; then
  echo "build:input-source: Command Line Tools (swiftc) が無いので入力ソースのヘルパーは組まない (xcode-select --install)" >&2
  exit 0
fi

mkdir -p "$out"
swiftc -O -swift-version 5 -o "$out/input-source-helper" "$here/input-source-helper.swift"
codesign --force --sign "${AIOS_SIGN_IDENTITY:--}" --identifier local.aios.input-source-helper "$out/input-source-helper" >/dev/null 2>&1 || \
  echo "build:input-source: codesign に失敗した (動かないかもしれない)" >&2
echo "build:input-source: $out/input-source-helper"
