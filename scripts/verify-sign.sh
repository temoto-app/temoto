#!/bin/bash
# Checks the signature, Hardened Runtime and notarization of the distributed aios.app (TODO 951, macOS only). It is the successor of
# scripts/verify-selfsign.sh (that one checks whether the keychain confirmation keeps appearing with a self-signed aios dev shell, and it stays).
#
#   npm run verify:sign                       expands the newest zip in dist/ with ditto and looks at it (right after release)
#   npm run verify:sign -- <aios.app|zip>     looks at the .app or zip given (for example a zip downloaded in a browser on another Mac)
#
# What it looks at (none of these writes to the keychain or shows a dialog; spctl / stapler may go out to the network):
#   1. codesign --verify --deep --strict --verbose=2
#   2. codesign -dvv: Identifier=io.github.temoto-app.temoto (TODO 1263) / Authority / TeamIdentifier / flags=runtime / Notarization Ticket
#   3. entitlements (the main binary and Electron Helper.app)
#   4. spctl -a -vv -t exec: accepted / source=Notarized Developer ID (the Gatekeeper judgment)
#   5. xcrun stapler validate
# If everything passes it exits 0; if any one fails, 1. A self-signed (aios dev) build fails at 4 and 5 (which is correct).
# This script does not touch the backend CLI (it is a path that lint:terms checks, but it writes no forbidden word).
set -uo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "verify-sign: macOS 専用。" >&2
  exit 1
fi

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
# The distributed build's identifier (TODO 1263; `bundleId` in src/shared/product.json, test/product-name.test.ts compares them).
BUNDLE_ID=io.github.temoto-app.temoto

say() { echo "verify-sign: $*"; }
ok() { echo "  OK  $*"; }
ng() { echo "  NG  $*"; failed=1; }
failed=0

target="${1:-}"
if [ -z "$target" ]; then
  target=$(ls -t "$root"/dist/aios-*-arm64-mac.zip 2>/dev/null | head -1)
  [ -n "$target" ] || { say "dist/ に zip が無い。npm run release の後か、.app / zip のパスを渡す"; exit 1; }
fi
[ -e "$target" ] || { say "無い: $target"; exit 1; }

work=""
cleanup() { [ -n "$work" ] && rm -rf "$work"; }
trap cleanup EXIT
case "$target" in
  *.zip)
    work=$(mktemp -d /tmp/aios-verify-sign-XXXXXX)
    # Expands with ditto, as the users do (the quarantine mark is not carried over from the zip; for a zip downloaded in a browser, its judgment is seen at 4).
    ditto -x -k "$target" "$work" || { say "展開できない: $target"; exit 1; }
    app="$work/aios.app"
    ;;
  *) app="$target" ;;
esac
[ -d "$app/Contents" ] || { say ".app でない: $app"; exit 1; }
say "対象: $target"

# 1. Whether the signature is intact
if out=$(codesign --verify --deep --strict --verbose=2 "$app" 2>&1); then
  ok "codesign --verify --deep --strict"
else
  ng "codesign --verify --deep --strict: $out"
fi

# 2. The contents of the signature
detail=$(codesign -dvv "$app" 2>&1)
ident=$(printf '%s\n' "$detail" | sed -n 's/^Identifier=//p')
authority=$(printf '%s\n' "$detail" | sed -n 's/^Authority=//p' | head -1)
team=$(printf '%s\n' "$detail" | sed -n 's/^TeamIdentifier=//p')
[ "$ident" = "$BUNDLE_ID" ] && ok "Identifier=$ident" || ng "Identifier が $BUNDLE_ID でない ($ident)"
case "$authority" in
  "Developer ID Application:"*) ok "Authority=$authority / TeamIdentifier=$team" ;;
  *) ng "Developer ID でない (Authority=${authority:-なし (ad-hoc)} / TeamIdentifier=$team)" ;;
esac
for rel in "" "Contents/Frameworks/Electron Helper.app" "Contents/Frameworks/Electron Helper (Renderer).app"; do
  # Take the output first and then grep it (under pipefail, if grep -q closes first, codesign dies of SIGPIPE and it becomes a false NG).
  part=$(codesign -dvv "$app/$rel" 2>&1)
  if printf '%s\n' "$part" | grep -q '^CodeDirectory .*flags=0x[0-9a-f]*([^)]*runtime'; then
    ok "Hardened Runtime: ${rel:-aios.app}"
  else
    ng "Hardened Runtime が無い: ${rel:-aios.app}"
  fi
done
if printf '%s\n' "$detail" | grep -q '^Notarization Ticket=stapled'; then ok "Notarization Ticket=stapled"; else ng "公証の ticket が staple されていない"; fi

# 3. entitlements (only shown; the authority on the contents is build/entitlements*.plist)
for rel in "" "Contents/Frameworks/Electron Helper.app"; do
  keys=$(codesign -d --entitlements - --xml "$app/$rel" 2>/dev/null | grep -o 'com\.apple\.[a-z.-]*' | tr '\n' ' ')
  echo "  --  entitlements ${rel:-aios.app}: ${keys:-なし}"
done

# 4. Gatekeeper
assess=$(spctl -a -vv -t exec "$app" 2>&1)
if printf '%s\n' "$assess" | grep -q ': accepted$' && printf '%s\n' "$assess" | grep -q '^source=Notarized Developer ID$'; then
  ok "spctl: accepted / source=Notarized Developer ID"
else
  ng "spctl: $(printf '%s' "$assess" | tr '\n' ' ')"
fi

# 5. staple
if out=$(xcrun stapler validate "$app" 2>&1); then ok "stapler validate"; else ng "stapler validate: $(printf '%s' "$out" | tail -1)"; fi

if [ "$failed" = 0 ]; then
  say "全部通った (Developer ID で署名・Hardened Runtime・公証済み・staple 済み)"
  exit 0
fi
say "落ちた項目がある (自己署名 aios dev の版なら Developer ID / spctl / staple が落ちるのは正しい)"
exit 1
