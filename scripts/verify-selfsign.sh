#!/bin/bash
# A script for the "first check" of TODO 103 (macOS only). It checks whether, when `npm run app` is remade with a self-signed code-signing
# certificate, the keychain confirmation ("aios Safe Storage") keeps appearing. For the procedure, see todo/103.md (verification steps 1–7 under
# "status of the preparation …").
#
#   npm run verify:selfsign          == bash scripts/verify-selfsign.sh all
#   bash scripts/verify-selfsign.sh cert    only makes the certificate (if it is missing)
#   bash scripts/verify-selfsign.sh build   remakes with AIOS_SIGN_IDENTITY + shows codesign -dv
#                                           (the shell's target stays as it is. It is made with make-app.mjs of the repo the target points at)
#   bash scripts/verify-selfsign.sh sign    only re-signs, without remaking (scripts/sign-app.mjs, TODO 375)
#   bash scripts/verify-selfsign.sh check   compares with the immediately previous cdhash
#
# Before each stage, the screen shows "a password or a click is needed here". Clicks on native dialogs and typing the keychain password
# cannot be done from this script — the owner does them by hand.
#
# Prerequisite: this has nothing to do with the repo's backend CLI (it concerns signing only). The path is covered by lint:terms,
# but it contains no forbidden word.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "verify-selfsign: macOS 専用。" >&2
  exit 1
fi

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
work="/tmp/aios-selfsign"
mkdir -p "$work"

CERT_NAME="${AIOS_SIGN_IDENTITY:-aios dev}"
KEYCHAIN="${AIOS_SELFSIGN_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
APP_PATH="${AIOS_SELFSIGN_APP:-$HOME/Applications/aios.app}"

log() { echo "verify-selfsign: $*"; }
step() { echo; echo "== $* =="; }
need_human() { echo "  -> [人の操作が要る] $*"; }

# --- cert ---------------------------------------------------------------------
# Makes a self-signed code-signing certificate in the login keychain. If a signing identity with the same name already exists,
# it does nothing (it only reads `security find-identity`, and writes nothing).
cmd_cert() {
  step "証明書 (${CERT_NAME})"
  if security find-identity -v -p codesigning 2>/dev/null | grep -qF "\"${CERT_NAME}\""; then
    log "既に \"${CERT_NAME}\" という署名用 identity がある。作り直さない。"
    log "作り直したいときは先にキーチェーンアクセス.app で証明書と秘密鍵を削除する。"
    return 0
  fi

  if ! command -v openssl >/dev/null 2>&1; then
    log "openssl が無いので自動では作れない。手順 (b) を使う:"
    print_manual_cert_steps
    return 1
  fi

  local key="$work/cert.key.pem"
  local crt="$work/cert.pem"
  local p12="$work/cert.p12"
  local pass
  pass=$(openssl rand -base64 24)

  log "openssl req で自己署名証明書を作る (RSA 2048、10 年、コード署名用の拡張つき)。"
  if ! openssl req -x509 -newkey rsa:2048 -keyout "$key" -out "$crt" -days 3650 -nodes \
    -subj "/CN=${CERT_NAME}" \
    -addext "extendedKeyUsage=codeSigning" \
    -addext "keyUsage=digitalSignature" \
    >/dev/null 2>&1; then
    log "openssl req に失敗した。手順 (b) を使う:"
    print_manual_cert_steps
    return 1
  fi

  # The macOS keychain (Security.framework) may be unable to read PKCS#12 that uses OpenSSL 3.x's default encryption (AES-256-CBC). For
  # compatibility, it is written out with -legacy (RC2/3DES). With an older or differently built openssl where -legacy is not available
  # (no legacy provider), it falls back to a plain export.
  log "PKCS#12 に書き出す (security import 用)。"
  if ! openssl pkcs12 -export -legacy -out "$p12" -inkey "$key" -in "$crt" \
      -passout "pass:${pass}" >/dev/null 2>&1; then
    if ! openssl pkcs12 -export -out "$p12" -inkey "$key" -in "$crt" \
        -passout "pass:${pass}" >/dev/null 2>&1; then
      log "openssl pkcs12 に失敗した。手順 (b) を使う:"
      print_manual_cert_steps
      return 1
    fi
  fi

  need_human "ログインキーチェーンのパスワードを聞かれることがある (security import / add-trusted-cert)。"
  need_human "「常に許可」や管理者のダイアログが出たら許可する。"
  read -r -p "続けてよければ Enter (中断は Ctrl-C): " _ || true

  log "security import で秘密鍵と証明書をログインキーチェーンに入れる (codesign からアクセス可に)。"
  security import "$p12" -k "$KEYCHAIN" -P "$pass" -T /usr/bin/codesign -T /usr/bin/security

  log "security add-trusted-cert でコード署名用に信頼設定する (自己署名は既定で信頼されないため)。"
  security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$crt"

  rm -f "$key" "$p12"
  log "できた。確認: security find-identity -v -p codesigning"
}

print_manual_cert_steps() {
  cat <<'EOF'
  手動の手順 (キーチェーンアクセス.app):
    1. キーチェーンアクセス.app を開く。
    2. メニュー: キーチェーンアクセス -> 証明書アシスタント -> 証明書を作成…
    3. 名前: "aios dev" (AIOS_SIGN_IDENTITY と揃える)。
       ID の種類: 自己署名のルート。証明書の種類: コード署名。
    4. 「デフォルトを上書き」で鍵長 2048 / 有効期限を長めに (既定のままでも可)。
    5. 作成後、ログインキーチェーンの「システム証明書」ではなく「ログイン」に入ったことを確認。
    6. 証明書をダブルクリック -> 「信頼」を展開 -> 「コード署名」を「常に信頼」に。
  終わったら: bash scripts/verify-selfsign.sh build
EOF
}

# --- build ---------------------------------------------------------------------
# Remakes the shell with AIOS_SIGN_IDENTITY=<certificate name>, and shows the key points of codesign -dv in a table.
#
# TODO 375: it used to call `npm run app`, but that changes the shell's target (Contents/Resources/app) to this repo (the dogfood shell points
# at aios-stable). Now it remakes the shell with the make-app.mjs in the repo that the current target points at (so the target does not change).
# Only when the target cannot be read, it uses this repo.
app_running() { pgrep -f "$APP_PATH/Contents/MacOS/" >/dev/null 2>&1; }

cmd_build() {
  step "殻の作り直し (AIOS_SIGN_IDENTITY=\"${CERT_NAME}\")"
  if app_running; then
    log "$APP_PATH が動いている。終了してからもう一度走らせる。" >&2
    exit 1
  fi
  local target
  target=$(readlink "$APP_PATH/Contents/Resources/app" 2>/dev/null || true)
  if [ -n "$target" ] && [ -f "$target/scripts/make-app.mjs" ] && [ -f "$target/out/main/index.js" ]; then
    need_human "殻の作り直し ($target の make-app.mjs、向き先はそのまま) が走る。パスワードやクリックは不要のはず。"
    ( cd "$target" && AIOS_SIGN_IDENTITY="$CERT_NAME" node scripts/make-app.mjs "$(dirname "$APP_PATH")" )
  else
    log "殻の向き先が読めない (${target:-無し})。この repo ($root) で npm run app を走らせる (向き先がこの repo になる)。"
    need_human "ビルドと殻の作り直し (npm run app) が走る。パスワードやクリックは不要のはず。"
    ( cd "$root" && AIOS_SIGN_IDENTITY="$CERT_NAME" npm run app )
  fi

  if [ ! -d "$APP_PATH" ]; then
    log "殻が見つからない: $APP_PATH" >&2
    exit 1
  fi
  show_signature
}

# --- sign ----------------------------------------------------------------------
# Re-signs only, without remaking (the target and the contents do not change). TODO 375.
cmd_sign() {
  step "署名だけし直す (AIOS_SIGN_IDENTITY=\"${CERT_NAME}\")"
  AIOS_SIGN_IDENTITY="$CERT_NAME" node "$root/scripts/sign-app.mjs" "$APP_PATH"
  show_signature
}

show_signature() {
  step "codesign -dv --verbose=2 の要点"
  local out
  out=$(codesign -dv --verbose=2 "$APP_PATH" 2>&1) || true
  echo "$out"
  echo
  printf '%-16s %s\n' "Authority=" "$(printf '%s\n' "$out" | grep -m1 '^Authority=' || echo '(無し)')"
  printf '%-16s %s\n' "TeamIdentifier=" "$(printf '%s\n' "$out" | grep -m1 '^TeamIdentifier=' || echo '(無し)')"
  printf '%-16s %s\n' "Signature=" "$(printf '%s\n' "$out" | grep -m1 '^Signature=' || echo '(無し)')"
  local cdhash
  cdhash=$(printf '%s\n' "$out" | grep -m1 '^CDHash=' | sed 's/^CDHash=//')
  printf '%-16s %s\n' "CDHash=" "${cdhash:-(無し)}"

  if printf '%s\n' "$out" | grep -q '^Signature=adhoc'; then
    log "ad-hoc のまま。AIOS_SIGN_IDENTITY が証明書名と一致しているか、証明書がキーチェーンに" >&2
    log "あるか (security find-identity -v -p codesigning) を確認する。" >&2
    exit 1
  fi

  echo "$cdhash" >> "$work/cdhash.log"
  log "cdhash を $work/cdhash.log に追記した (check で前回と比較)。"
}

# --- check ---------------------------------------------------------------------
# Looks at the difference of the cdhash from the previous build, and whether the keychain item exists.
cmd_check() {
  step "cdhash の履歴"
  if [ -s "$work/cdhash.log" ]; then
    tail -5 "$work/cdhash.log" | nl -ba
    local n
    n=$(wc -l < "$work/cdhash.log" | tr -d ' ')
    if [ "$n" -ge 2 ]; then
      local a b
      a=$(tail -2 "$work/cdhash.log" | head -1)
      b=$(tail -1 "$work/cdhash.log")
      if [ "$a" = "$b" ]; then
        log "直前の 2 回の cdhash が同じ。作り直しが起きていない可能性がある (build をやり直す)。"
      else
        log "直前の 2 回の cdhash が違う -> 作り直しごとに cdhash は変わっている (ad-hoc と同じ)。"
        log "これでも 2 回目の起動でキーチェーン確認が出なければ、証明書 (designated requirement) が"
        log "cdhash とは別に同一性を保証している証拠になる。"
      fi
    fi
  else
    log "cdhash.log が無い。先に build を 2 回実行する。"
  fi

  step "\"aios Safe Storage\" のキーチェーン項目"
  if security find-generic-password -s "aios Safe Storage" >/dev/null 2>&1; then
    log "項目がある (DB の鍵を復号できている = 少なくとも 1 回は「常に許可」された)。"
    need_human "ACL に証明書が載っているかは security dump-keychain -a (確認ダイアログが出ることがある) で見る。自動化していない。"
  else
    log "項目が無い。まだ一度も起動して許可していないか、DB が暗号化されていない。"
  fi
}

# --- all -----------------------------------------------------------------------
cmd_all() {
  step "TODO 103 の検証 (all)"
  cat <<EOF
これから行うこと (todo/103.md「準備 … 検証手順」の 1〜7 に対応):
  1. cert  - 自己署名証明書 "${CERT_NAME}" を作る (無ければ)。キーチェーンのパスワードを聞かれうる。
  2. build - AIOS_SIGN_IDENTITY="${CERT_NAME}" で殻を作り直す (向き先は今のまま)。
  3. ここで一度 ${APP_PATH} を起動し、「aios Safe Storage」の確認が出たら「常に許可」を押す。
     (このスクリプトはネイティブダイアログを操作できない。手でクリックすること。)
  4. build をもう一度実行する (cdhash は変わるはずだが署名 ID = 証明書名は変わらない)。
  5. ${APP_PATH} をもう一度起動し、確認が出ないか目で見る。
  6. check - cdhash の履歴と Safe Storage の項目の有無を出す。
  7. 結果を $work/result.md に書く (手引き自体は書き換えない - 案文だけ出す)。
EOF

  cmd_cert
  cmd_build

  echo
  need_human "いま ${APP_PATH} を起動し、「aios Safe Storage」のキーチェーン確認が出たら「常に許可」を押す。"
  need_human "起動を確認したら終了 (Cmd-Q) してからここに戻る。"
  read -r -p "『常に許可』を押して終了したら Enter: " _ || true

  cmd_build

  echo
  need_human "もう一度 ${APP_PATH} を起動する。"
  read -r -p "確認ダイアログが出た? [y/N] " shown
  shown=${shown:-N}

  cmd_check

  {
    echo "# TODO 103 検証結果 ($(date '+%Y-%m-%d %H:%M'))"
    echo
    echo "- 証明書名 (AIOS_SIGN_IDENTITY): ${CERT_NAME}"
    echo "- 2 回目の作り直し後の起動でキーチェーン確認が出たか: ${shown}"
    echo
    echo "## codesign -dv --verbose=2 ${APP_PATH}"
    echo '```'
    codesign -dv --verbose=2 "$APP_PATH" 2>&1 || true
    echo '```'
    echo
    echo "## cdhash の履歴"
    echo '```'
    cat "$work/cdhash.log" 2>/dev/null || echo "(無し)"
    echo '```'
    echo
    if [ "$shown" = "y" ] || [ "$shown" = "Y" ]; then
      echo "## 結論 (案)"
      echo "第 1 段 (自己署名 + curl 配布) は不成立。自己署名でもキーチェーンの確認が出た。"
      echo "手引きの \`~/Applications/aios.app\` の節への追記案:"
      echo '> **自己署名の証明書 (AIOS_SIGN_IDENTITY) で署名しても、作り直すたびにキーチェーンの確認が出た** (2026-09-28 実測)。'
      echo '> ad-hoc と同じ扱いを受けている。原因は未確認 (証明書の信頼設定・identifier の指定漏れ等)。TODO 103 は継続調査。'
    else
      echo "## 結論 (案)"
      echo "第 1 段 (自己署名 + curl 配布) が成り立つ見込み。2 回目の作り直し後は確認が出なかった。"
      echo "手引きの \`~/Applications/aios.app\` の節への追記案:"
      echo '> **自己署名の証明書 (`AIOS_SIGN_IDENTITY`) で署名すれば、作り直してもキーチェーンの確認は出ない** (2026-09-28 実測)。'
      echo '> designated requirement が証明書に結び付くため。TODO 103 の第 1 段はこれで成立。'
    fi
  } > "$work/result.md"

  step "書いた: $work/result.md"
  cat "$work/result.md"
}

case "${1:-all}" in
  cert) cmd_cert ;;
  build) cmd_build ;;
  sign) cmd_sign ;;
  check) cmd_check ;;
  all) cmd_all ;;
  *)
    echo "使い方: $0 [cert|build|sign|check|all]" >&2
    exit 1
    ;;
esac
