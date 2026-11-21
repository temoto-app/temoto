#!/bin/sh
# Replaces the aios for use (dogfood) with the latest version by "quit → promote → launch".
#
#   scripts/reboot-stable.sh [--wait SEC]
#
#   1. If aios.app is running, asks it to quit normally (equivalent to ⌘Q) and waits until it stops (default 60 seconds).
#      It does not force-quit (it may be in the middle of writing the DB). If the time runs out, it stops without doing anything.
#   2. scripts/promote-stable.sh (fast-forwards main, builds, and sets where aios.app points).
#   3. Launches aios.app. Even if 2 fails, the previous version is brought back up (so that it is not left unusable).
#
# It must not be run from a terminal or session inside aios (this script would die along with the quit).
# Run it from a terminal outside aios, or from BetterTouchTool.
set -eu

wait_sec=60
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) wait_sec=${2:?--wait に秒数が要る}; shift 2 ;;
    *) echo "不明な引数: $1" >&2; exit 2 ;;
  esac
done

app="$HOME/Applications/aios.app"
# The binary is Contents/MacOS/aios (the shell from before TODO 375 used aios-bin). It matches either.
# It matches only the binary with no arguments (fixed to the end of the line). A prefix match would also hit the gateway that the CLI starts
# (`aios-bin …/gateway.js`) and another user's ~/Applications/aios.app, and it would keep waiting for something that cannot be ended, and time out (2026-10-09).
pattern="^$app/Contents/MacOS/aios(-bin)?\$"
uid=$(id -u)
here=$(cd "$(dirname "$0")" && pwd)

# If an ancestor is aios, then quitting it takes this script down with it too.
pid=$$
while [ "$pid" -gt 1 ]; do
  if ps -o command= -p "$pid" | grep -Eq "$pattern"; then
    echo "aios の中から走らせている。aios の外のターミナルで走らせる。" >&2
    exit 1
  fi
  pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
  [ -n "$pid" ] || break
done

if pgrep -u "$uid" -f "$pattern" >/dev/null 2>&1; then
  echo "aios を終了する…"
  osascript -e "tell application \"$app\" to quit" >/dev/null 2>&1 || pkill -TERM -u "$uid" -f "$pattern" || true
  i=0
  while pgrep -u "$uid" -f "$pattern" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt "$wait_sec" ]; then
      echo "${wait_sec} 秒待っても終了しない (確認ダイアログが出ていないか)。何も変えずに止める。" >&2
      exit 1
    fi
    sleep 1
  done
fi

status=0
sh "$here/promote-stable.sh" || status=$?
if [ "$status" != 0 ]; then
  echo "promote が失敗した (exit=$status)。元の版を起こし直す。" >&2
fi

echo "aios を起動する"
# open passes the caller's environment variables to the app. If the ELECTRON_RUN_AS_NODE of an Electron-based terminal is passed, the shell's
# binary (Electron) launches as plain Node and exits immediately (TODO 375, docs/notes/app-shell.md).
env -u ELECTRON_RUN_AS_NODE open -a "$app"
exit "$status"
