#!/bin/sh
# Builds the voice-input helper (item 226, `npm run build:speech`). The artifact is out/speech-helper/speech-helper, and it is not
# committed (out/ is in .gitignore). main looks for <appPath>/out/speech-helper/speech-helper.
#
# Outside macOS, or when the Command Line Tools are missing, it warns and does nothing (exit code 0 — it does not fail the whole build).
# An aios without the helper only shows "the helper is not there" when the mic is pressed.
#
# Info.plist is embedded in __TEXT,__info_plist. But TCC checks the Info.plist of the "responsible process" (aios.app), so what is embedded
# here has no effect (spike 28). It is embedded as a clue for when the binary is inspected on its own.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="$root/out/speech-helper"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build:speech: macOS ではないので音声入力のヘルパーは組まない" >&2
  exit 0
fi
if ! xcode-select -p >/dev/null 2>&1 || ! command -v swiftc >/dev/null 2>&1; then
  echo "build:speech: Command Line Tools (swiftc) が無いので音声入力のヘルパーは組まない (xcode-select --install)" >&2
  exit 0
fi

mkdir -p "$out"
swiftc -O -parse-as-library \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$here/Info.plist" \
  -o "$out/speech-helper" "$here/speech-helper.swift"
# Ad-hoc signing. Even when the identifier is fixed, under ad-hoc the cdhash is the identity (remaking it may make TCC ask for permission again; TODO 227).
codesign --force --sign "${AIOS_SIGN_IDENTITY:--}" --identifier local.aios.speech-helper "$out/speech-helper" >/dev/null 2>&1 || \
  echo "build:speech: codesign に失敗した (動かないかもしれない)" >&2
echo "build:speech: $out/speech-helper"
