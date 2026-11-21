#!/bin/bash
# Installs the backend CLI and finishes login (called from scripts/install.sh. macOS only).
#
# Only this one file lives in compat/ (the area constraint 6 allows), so that backend-specific words
# (the command name, the installer URL) stay out of scripts/. The CLI is installed into the user's home
# with the official installer only; it is not bundled or modified (constraint 1). Credentials are not
# touched: login state is checked only with `auth status` (constraint 2). The login method is left to
# the CLI (constraint 3; people who use an API key may skip this).
#
#   bash compat/install-backend.sh           installs if missing, and prompts for login if not logged in
#   bash compat/install-backend.sh --check   changes nothing and only prints the state (exit code 0 = all in place)
set -euo pipefail

CLI=claude
INSTALLER_URL=https://claude.ai/install.sh

check=0
[ "${1:-}" = "--check" ] && check=1

export PATH="$HOME/.local/bin:$PATH"

# Output language: English by default, Japanese only when the locale says so (the first non-empty of LC_ALL / LC_MESSAGES / LANG,
# with "ja" as a prefix). Messages are given as (English, Japanese); a message without a Japanese form falls back to the English one.
OUT_LANG=en
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in ja*) OUT_LANG=ja ;; esac
pick() { if [ "$OUT_LANG" = ja ]; then printf '%s' "${2:-$1}"; else printf '%s' "$1"; fi; }
say() { echo "install-backend: $(pick "$@")"; }

if ! command -v "$CLI" >/dev/null 2>&1; then
  if [ "$check" = 1 ]; then
    say "CLI: missing" "CLI: 無い"
    exit 1
  fi
  say "The CLI is missing, so installing it with the official installer ($INSTALLER_URL)" "CLI が無いので公式のインストーラで入れる ($INSTALLER_URL)"
  curl -fsSL "$INSTALLER_URL" | bash
  hash -r
  if ! command -v "$CLI" >/dev/null 2>&1; then
    say "The CLI that should have been installed is not on PATH (check ~/.local/bin)" "入れたはずの CLI が PATH に見つからない (~/.local/bin を確かめる)" >&2
    exit 1
  fi
fi
say "CLI: $(command -v "$CLI") ($("$CLI" --version 2>/dev/null | head -1))"

# Even when not logged in, stdout is JSON (spike 12). If the shape has changed, treat it as "unknown" and go on.
status=$("$CLI" auth status --json 2>/dev/null || true)
case "$status" in
  *'"loggedIn": true'* | *'"loggedIn":true'*)
    say "Login: done" "ログイン: 済み"
    exit 0
    ;;
esac

if [ "$check" = 1 ]; then
  say "Login: not yet" "ログイン: まだ"
  exit 1
fi
say "Not logged in. Logging in with the browser (if you use an API key, answer n to skip)" "ログインしていない。ブラウザでログインする (API キーで使うなら n で飛ばしてよい)"
if (exec </dev/tty) 2>/dev/null; then
  printf 'install-backend: %s [Y/n] ' "$(pick 'Log in now?' 'いまログインする?')" >/dev/tty
  read -r answer </dev/tty || answer=n
  case "$answer" in
    n | N | no | NO) say "Skipped. Run \`$CLI auth login\` later" "飛ばした。後で \`$CLI auth login\` を実行する" ;;
    *)
      # If stdin is already a terminal, do not re-point </dev/tty: re-pointing it (the reopened fd cannot be watched
      # with kqueue) makes Bun fail with `EINVAL: invalid argument, kqueue` on some machines (repro: run
      # `bash -c '"$CLI" auth login </dev/tty'` directly from the terminal). `</dev/tty` is a fallback needed
      # only when `curl … | bash` has filled stdin, so use it only when stdin is not a terminal.
      if [ -t 0 ]; then
        login_ok=1
        "$CLI" auth login || login_ok=0
      else
        login_ok=1
        "$CLI" auth login </dev/tty || login_ok=0
      fi
      if [ "$login_ok" != 1 ]; then
        say "Could not start the login dialog. Start \`$CLI\` in a terminal and run \`/login\`" "ログインの対話が始められなかった。端末で \`$CLI\` を起動して \`/login\` を実行する"
      fi
      ;;
  esac
else
  say "There is no terminal, so login was skipped. Run \`$CLI auth login\` later" "端末が無いのでログインは飛ばした。後で \`$CLI auth login\` を実行する"
fi
