#!/bin/sh
# Starts the aios under development with a copy of the real userData (so it does not collide with the dogfood aios).
#
#   scripts/dev-instance.sh [--refresh] [--no-build] [--no-agent]
#
#   The default copy destination is ~/aios-dev-data (change it with AIOS_DEV_DATA). If it is missing, it is made from the real one.
#   --refresh   throw the copy away and remake it from the real one (when you want to roll back a DB whose migrations have advanced)
#   --no-build  skip the build (when out/ already exists)
#   --no-agent  adds AIOS_DISABLE_AGENT=1 (does not call the model; item 186)
#
# It never writes to the real one (~/Library/Application Support/aios). The copy is an APFS clonefile, so even several GB takes
# an instant. A copy made while the real one is running includes its WAL, so it is recovered at startup.
# It runs in a different Electron.app (this worktree's node_modules), so the keychain confirmation dialog appears the first time only.
# Choose the Always Allow option.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
# TODO 1263: the real userData is under the machine's data name: the legacy aios if it is a real directory there (the development machine),
# otherwise Temoto. Temoto wins when its folder already holds the DB (aios.db; a real file in a real directory). The same decision as
# src/common/app-identity.ts, which also picks the keychain item the copy's DB key is sealed with.
current="$HOME/Library/Application Support/Temoto"
legacy="$HOME/Library/Application Support/aios"
real="$current"
if ! { [ -d "$current" ] && [ ! -L "$current" ] && [ -f "$current/aios.db" ] && [ ! -L "$current/aios.db" ]; } && [ -d "$legacy" ] && [ ! -L "$legacy" ]; then real="$legacy"; fi
data=${AIOS_DEV_DATA:-$HOME/aios-dev-data}
refresh=0 build=1 agent=1
for arg in "$@"; do
  case "$arg" in
    --refresh) refresh=1 ;;
    --no-build) build=0 ;;
    --no-agent) agent=0 ;;
    *) echo "不明な引数: $arg" >&2; exit 2 ;;
  esac
done

if pgrep -f "user-data-dir=$data" >/dev/null 2>&1; then
  [ "$refresh" = 1 ] && { echo "複製 ($data) を使う aios が動いている。先に終了する。" >&2; exit 1; }
  echo "複製 ($data) は既に使われている。窓が増えるだけになる。" >&2
fi

if [ "$refresh" = 1 ] && [ -e "$data" ]; then rm -rf "$data"; fi
if [ ! -e "$data" ]; then
  [ -d "$real" ] || { echo "実物の userData が無い: $real" >&2; exit 1; }
  echo "複製を作る: $real -> $data"
  cp -Rc "$real" "$data" 2>/dev/null || cp -R "$real" "$data"
  rm -f "$data/SingletonLock" "$data/SingletonCookie" "$data/SingletonSocket" "$data/DevToolsActivePort"
fi

cd "$root"
if [ "$build" = 1 ]; then npm run build; fi
[ -f out/main/index.js ] || { echo "ビルド成果物が無い。--no-build を外す。" >&2; exit 1; }

echo "起動: $root (userData=$data)"
if [ "$agent" = 0 ]; then
  exec env -u ELECTRON_RUN_AS_NODE AIOS_DISABLE_AGENT=1 ./node_modules/.bin/electron . --user-data-dir="$data"
fi
exec env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --user-data-dir="$data"
