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

say() { echo "install-backend: $*"; }

if ! command -v "$CLI" >/dev/null 2>&1; then
  if [ "$check" = 1 ]; then
    say "CLI: 無い"
    exit 1
  fi
  say "CLI が無いので公式のインストーラで入れる ($INSTALLER_URL)"
  curl -fsSL "$INSTALLER_URL" | bash
  hash -r
  if ! command -v "$CLI" >/dev/null 2>&1; then
    say "入れたはずの CLI が PATH に見つからない (~/.local/bin を確かめる)" >&2
    exit 1
  fi
fi
say "CLI: $(command -v "$CLI") ($("$CLI" --version 2>/dev/null | head -1))"

# Even when not logged in, stdout is JSON (spike 12). If the shape has changed, treat it as "unknown" and go on.
status=$("$CLI" auth status --json 2>/dev/null || true)
case "$status" in
  *'"loggedIn": true'* | *'"loggedIn":true'*)
    say "ログイン: 済み"
    exit 0
    ;;
esac

if [ "$check" = 1 ]; then
  say "ログイン: まだ"
  exit 1
fi
say "ログインしていない。ブラウザでログインする (API キーで使うなら n で飛ばしてよい)"
if (exec </dev/tty) 2>/dev/null; then
  printf 'install-backend: いまログインする? [Y/n] ' >/dev/tty
  read -r answer </dev/tty || answer=n
  case "$answer" in
    n | N | no | NO) say "飛ばした。後で \`$CLI auth login\` を実行する" ;;
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
        say "ログインの対話が始められなかった。端末で \`$CLI\` を起動して \`/login\` を実行する"
      fi
      ;;
  esac
else
  say "端末が無いのでログインは飛ばした。後で \`$CLI auth login\` を実行する"
fi
