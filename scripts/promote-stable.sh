#!/bin/sh
# Reflects main's current commit into the "for use" (dogfood) worktree (aios-stable), and points ~/Applications/aios.app at it.
# Edits and builds on the development side do not reach the side that uses it.
#
#   scripts/promote-stable.sh [--switch-now] [--remake-app]
#
#   The worktree for use is <next to main>/aios-stable (change it with AIOS_STABLE). The branch name is stable.
#   - If it is missing, make it. If it exists, fast-forward it to main (it stops if there are local changes or it has diverged).
#   - If out/.built-commit is the same as HEAD, skip the build (cheap to run any number of times).
#   - While aios.app is running, do not change where it points (late imports would get mixed in).
#     Quit it, then run this script again. --switch-now changes it anyway, knowingly.
#   - --remake-app: remakes aios.app from stable (scripts/make-app.mjs; the shape and the signature are renewed, TODO 375).
#     The destination stays stable. It is not remade while it is running. If it sees an old-form shell (aios-bin), it only gives guidance.
set -eu

switch_now=0
remake_app=0
for arg in "$@"; do
  case "$arg" in
    --switch-now) switch_now=1 ;;
    --remake-app) remake_app=1 ;;
    *) echo "不明な引数: $arg" >&2; exit 2 ;;
  esac
done

main=$(git -C "$(dirname "$0")" worktree list --porcelain | sed -n '1s/^worktree //p')
stable=${AIOS_STABLE:-$(dirname "$main")/aios-stable}
app="$HOME/Applications/aios.app"
link="$app/Contents/Resources/app"

# While aios.app is running and pointing at the one for use (stable), out/ cannot be touched.
# The binary is Contents/MacOS/aios (the shell from before TODO 375 used aios-bin). It searches in a way that matches either.
# Only the user's own binary, with no arguments (not the gateway, and not another user's aios; the same as reboot-stable.sh).
# -a: when run from a terminal inside aios, do not let the ancestor aios be excluded (macOS pgrep excludes it by default).
running=0
pgrep -a -u "$(id -u)" -f "^$app/Contents/MacOS/aios(-bin)?\$" >/dev/null 2>&1 && running=1
target=$(readlink "$link" 2>/dev/null || true)
if [ "$running" = 1 ] && [ "$target" = "$stable" ]; then
  echo "aios.app が $stable で動いている。ビルドが足元を書き換えるので、終了してから再実行する。" >&2
  exit 1
fi

if [ ! -d "$stable" ]; then
  if git -C "$main" show-ref --verify --quiet refs/heads/stable; then
    git -C "$main" worktree add "$stable" stable
  else
    git -C "$main" worktree add -b stable "$stable" main
  fi
fi
git -C "$stable" merge --ff-only main

cd "$stable"
# A symlinked node_modules trips over plugin-host's --allow-fs-read (realpath), so a real copy is installed.
# If package-lock.json has changed since the last npm ci, reinstall (so that stable is not left behind when dependencies are added).
lock_hash=$(shasum package-lock.json | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "$(cat node_modules/.aios-lock-hash 2>/dev/null || true)" != "$lock_hash" ]; then
  # npm ci removes node_modules before installing. If it fails (offline, registry, electron-rebuild) and leaves things half-done, the
  # aios on the side that uses it crashes at startup, so the old one is set aside before installing, and restored if the install fails (TODO 930).
  rm -rf node_modules.old
  [ ! -d node_modules ] || mv node_modules node_modules.old
  if npm ci; then
    echo "$lock_hash" > node_modules/.aios-lock-hash
    rm -rf node_modules.old
  else
    rm -rf node_modules
    if [ -d node_modules.old ]; then
      mv node_modules.old node_modules
      echo "npm ci が失敗した。前の node_modules に戻した (依存は古いまま)。" >&2
    else
      echo "npm ci が失敗した。" >&2
    fi
    exit 1
  fi
fi
head=$(git rev-parse HEAD)
if [ "$(cat out/.built-commit 2>/dev/null || true)" != "$head" ]; then
  npm run build
  echo "$head" > out/.built-commit
else
  echo "ビルド済み ($head)"
fi

if [ ! -d "$app" ]; then
  node scripts/make-app.mjs
  echo "aios.app を作った (初回起動でキーチェーンの確認ダイアログ。「常に許可」)"
elif [ "$remake_app" = 1 ]; then
  if [ "$running" = 1 ]; then
    echo "aios.app が動いているので作り直さない。終了してから --remake-app でもう一度走らせる。" >&2
    exit 1
  fi
  node scripts/make-app.mjs
  echo "aios.app を作り直した (向き先: $stable)"
elif [ "$target" = "$stable" ]; then
  echo "aios.app は既に $stable を指している"
elif [ "$running" = 1 ] && [ "$switch_now" = 0 ]; then
  echo "aios.app が動いているので向き先は替えていない ($target)。終了してからもう一度走らせる。"
  exit 0
else
  ln -sfn "$stable" "$link"
  echo "aios.app の向き先: $target -> $stable"
fi
echo "反映した commit: $(git log --oneline -1)"
if [ -e "$app/Contents/MacOS/aios-bin" ]; then
  echo "aios.app は旧い形 (aios-bin、TODO 375)。通知が出るように作り直すには、終了してから --remake-app を付けて走らせる。"
fi
[ "$running" = 1 ] && echo "動いている aios は再起動すると新しい版になる。"
exit 0
