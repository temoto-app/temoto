#!/bin/bash
# Setup and update of aios from its source (macOS only, once per user). To install a prebuilt one, see "How to install" in README.md.
# Homebrew is not used: every tool is installed inside that user's home (~/.local), so it does not collide with other users on one Mac,
# and sudo is not needed either (only the one-time Command Line Tools install needs it).
#
# If you only want to install the prebuilt one, use "How to install" in README.md rather than this file (the official entry point is
# install-temoto.sh in the GitHub Releases. It is fetched from the public repo's Release with gh, so there is no chicken-and-egg problem).
# This file is the route that builds from source ("Install from source" in README.md). The prerequisite is unchanged: be logged in to gh with a
# GitHub account that can see the repo. Even on a new PC without git or gh, this file itself can be fetched with curl alone (if it is placed
# in a public location):
#   bash -c "$(curl -fsSL <URL of the place where this file is put>)"
#   (`curl … | bash` fills stdin, so the interactive GitHub login is not possible; use the form `bash -c "$(…)"`.
#    The clone at step 5 goes through gh, with private authorization included. This file itself need not be placed in a private location.)
#
# Updating a PC where it is already installed:
#   ~/git/aios/scripts/install.sh
#
# Options:
#   --check       change nothing; only print what is in place and what is missing
#   --yes         quit a running aios without asking
#   --no-launch   do not launch aios at the end
#
# Environment variables:
#   AIOS_REPO         the clone source (default temoto-app/temoto)
#   AIOS_DIR          the clone destination (default: the repo this script is in, if it is inside one; otherwise ~/git/aios)
#   AIOS_NODE_MAJOR   the Node major line to install when Node is missing or old (default 22, the same as the development machine)
#   AIOS_SIGN_IDENTITY  the signing name of the .app (passed as is to scripts/make-app.mjs; TODO 103)
#
# Stages (any stage already done is skipped. The stages that need interaction are listed first, so the long build can be left alone):
#   1. Command Line Tools (git / swiftc): if missing, the OS dialog. One confirmation, like sudo
#   2. ~/.local/bin on PATH: one line added to ~/.zshrc (aios looks for the CLI in the login shell's PATH)
#   3. Node (>= NODE_MIN): the official tarball from nodejs.org, verified with SHASUMS256
#   4. gh + GitHub login: the official zip from GitHub Releases, verified with checksums
#   5. clone / pull of the repo (--ff-only)
#   6. the agent CLI + login: compat/install-backend.sh
#   7. quit the running aios, then npm ci (only when the lock file changed), then npm run build
#   8. ~/Applications/aios.app (rebuilt only when it is missing, when the Electron version changed, or when it points at a different clone)
#   9. launch
set -euo pipefail

NODE_MIN=22.12.0
NODE_MAJOR="${AIOS_NODE_MAJOR:-22}"
REPO="${AIOS_REPO:-temoto-app/temoto}"
APP="$HOME/Applications/aios.app"
BUNDLE_ID=local.aios
LOCAL_BIN="$HOME/.local/bin"
LOCAL_SHARE="$HOME/.local/share/aios"

# Output language: English by default, Japanese only when the locale says so. The first non-empty of LC_ALL / LC_MESSAGES / LANG
# decides (the usual precedence), and "ja" as a prefix (ja_JP.UTF-8, ja) selects Japanese. Every message is given as
# (English, Japanese); a message without a Japanese form falls back to the English one.
OUT_LANG=en
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in ja*) OUT_LANG=ja ;; esac
pick() { if [ "$OUT_LANG" = ja ]; then printf '%s' "${2:-$1}"; else printf '%s' "$1"; fi; }
say() { echo "install: $(pick "$@")"; }
die() {
  echo "install: $(pick "$@")" >&2
  echo "install: $(pick 'After fixing it, run scripts/install.sh again (stages already done are skipped). To see only what is missing, use --check.' '直したら、もう一度 scripts/install.sh (済んだ段は飛ばされる)。何が足りないかだけ見るなら --check。')" >&2
  exit 1
}
usage_err() {
  echo "install: $(pick "$@")" >&2
  exit 2
}

check=0
assume_yes=0
launch=1
for arg in "$@"; do
  case "$arg" in
    --check) check=1 ;;
    --yes | -y) assume_yes=1 ;;
    --no-launch) launch=0 ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      usage_err "unknown option: $arg" "知らないオプション: $arg"
      ;;
  esac
done

# --- Display --------------------------------------------------------------------
step() { printf '\n== %s ==\n' "$(pick "$@")"; }
missing=()
# With --check, count what is missing and go on. Otherwise, actually install it.
lack() {
  local m
  m="$(pick "$@")"
  say "Missing: $m" "足りない: $m"
  missing+=("$m")
}

ask_yes() {
  # $1 = the question. With --yes, it says yes without asking. If there is no terminal, it says no.
  [ "$assume_yes" = 1 ] && return 0
  [ -r /dev/tty ] || return 1
  local answer
  printf 'install: %s [Y/n] ' "$(pick "$1" "$2")" >/dev/tty
  read -r answer </dev/tty || return 1
  case "$answer" in n | N | no | NO) return 1 ;; *) return 0 ;; esac
}

# "a.b.c" >= "x.y.z"
version_ge() {
  local IFS=.
  # shellcheck disable=SC2206
  local a=($1) b=($2)
  local i
  for i in 0 1 2; do
    local x="${a[i]:-0}" y="${b[i]:-0}"
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}

tmp=$(mktemp -d "${TMPDIR:-/tmp}/aios-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# --- 0. Prerequisites -----------------------------------------------------------------
[ "$(uname -s)" = Darwin ] || die "macOS only." "macOS 専用。"
[ "$(id -u)" != 0 ] || die "Run without sudo (it installs into the invoking user's home)." "sudo を付けずに実行する (入れる先は実行したユーザのホーム)。"

# Install with the machine's native architecture, even from a terminal under Rosetta.
if [ "$(sysctl -in hw.optional.arm64 2>/dev/null)" = 1 ]; then
  node_arch=arm64
  gh_arch=arm64
else
  node_arch=x64
  gh_arch=amd64
fi

is_aios_repo() { [ -f "$1/package.json" ] && grep -q '"name": "aios"' "$1/package.json"; }

# The repo to update is first the one that the aios.app installed now points at (on a development machine, that is the aios-stable worktree,
# which is separate from ~/git/aios where this script lives). Next, the repo this script is in (when run as `bash -c "$(curl …)"`,
# BASH_SOURCE is absent). If neither exists, ~/git/aios.
app_repo=$(readlink "$APP/Contents/Resources/app" 2>/dev/null || true)
[ -n "$app_repo" ] && is_aios_repo "$app_repo" || app_repo=""
self_repo=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  candidate=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  is_aios_repo "$candidate" && self_repo=$candidate
fi
AIOS_DIR="${AIOS_DIR:-${app_repo:-${self_repo:-$HOME/git/aios}}}"

export PATH="$LOCAL_BIN:$PATH"
mkdir -p "$LOCAL_BIN" "$LOCAL_SHARE" 2>/dev/null || true

say "repo: $AIOS_DIR / arch: $node_arch$([ "$check" = 1 ] && echo ' / --check (changes nothing)')" "repo: $AIOS_DIR / arch: $node_arch$([ "$check" = 1 ] && echo ' / --check (何も変えない)')"

# --- 1. Command Line Tools ---------------------------------------------------
step "1. Command Line Tools"
clt_ok() { xcode-select -p >/dev/null 2>&1 && xcrun --find git >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1; }
if clt_ok; then
  say "ok: $(xcode-select -p)"
elif [ "$check" = 1 ]; then
  lack "Command Line Tools"
else
  say "Command Line Tools are missing. An OS dialog will appear; press \"Install\" (a few to a dozen or so minutes)" "Command Line Tools が無い。OS のダイアログが出るので「インストール」を押す (数分〜十数分)"
  xcode-select --install >/dev/null 2>&1 || true
  waited=0
  until clt_ok; do
    sleep 10
    waited=$((waited + 10))
    ((waited % 60 == 0)) && say "Waiting... (${waited}s)" "待っている… (${waited}s)"
    ((waited < 3600)) || die "Still not installed after 1 hour. If you closed the dialog, run this script again." "1 時間待っても入らなかった。ダイアログを閉じたなら、もう一度このスクリプトを実行する。"
  done
  say "ok: $(xcode-select -p)"
fi

# --- 2. ~/.local/bin on PATH ----------------------------------------------
# When aios is launched from the GUI, it asks the login shell (zsh -i -l) for PATH in order to find the CLI (src/main/path-env.ts).
# gh / node / the CLI are placed in ~/.local/bin, so if that is not on the shell's PATH, aios cannot see them.
step "2. ~/.local/bin on PATH" "2. ~/.local/bin を PATH に"
rc="$HOME/.zshrc"
if grep -qs '\.local/bin' "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.zshenv"; then
  say "ok: already in the zsh config" "ok: zsh の設定に既にある"
elif [ "$check" = 1 ]; then
  lack "~/.local/bin is not on zsh's PATH" "~/.local/bin が zsh の PATH に無い"
else
  {
    echo ''
    echo '# added by aios scripts/install.sh (where gh / node / the agent CLI live)'
    echo 'export PATH="$HOME/.local/bin:$PATH"'
  } >>"$rc"
  say "Added: $rc" "足した: $rc"
fi

# --- 3. Node -----------------------------------------------------------------
# The Node used at run time is the one built into Electron, so only the build (vite / tsc / electron-rebuild) needs Node here.
step "3. Node (>= $NODE_MIN)"
node_version=""
if command -v node >/dev/null 2>&1; then
  node_version=$(node -p 'process.versions.node' 2>/dev/null || true)
fi
if [ -n "$node_version" ] && version_ge "$node_version" "$NODE_MIN"; then
  say "ok: $(command -v node) v$node_version"
elif [ "$check" = 1 ]; then
  lack "Node (installed now: ${node_version:-none})" "Node (いま: ${node_version:-無し})"
else
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  say "Installing the latest Node v${NODE_MAJOR} (installed now: ${node_version:-none})" "Node v${NODE_MAJOR} の最新を入れる (いま: ${node_version:-無し})"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  tarball=$(awk -v arch="darwin-$node_arch.tar.gz" '$2 ~ arch"$" { print $2 }' "$tmp/SHASUMS256.txt" | head -1)
  [ -n "$tarball" ] || die "The nodejs.org SHASUMS256.txt has no tarball for darwin-$node_arch" "nodejs.org の SHASUMS256.txt に darwin-$node_arch の tarball が無い"
  curl -fSL --progress-bar "$base/$tarball" -o "$tmp/$tarball"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | shasum -a 256 -c -) >/dev/null ||
    die "SHA-256 of the Node tarball does not match" "Node の tarball の SHA-256 が合わない"
  name="${tarball%.tar.gz}"
  mkdir -p "$LOCAL_SHARE/node"
  rm -rf "${LOCAL_SHARE:?}/node/$name"
  tar -xzf "$tmp/$tarball" -C "$LOCAL_SHARE/node"
  ln -sfn "$LOCAL_SHARE/node/$name" "$LOCAL_SHARE/node/current"
  for bin in node npm npx; do
    ln -sfn "$LOCAL_SHARE/node/current/bin/$bin" "$LOCAL_BIN/$bin"
  done
  hash -r
  say "ok: $(command -v node) v$(node -p 'process.versions.node')"
fi

# --- 4. gh + GitHub login ----------------------------------------------
step "4. gh and GitHub login" "4. gh と GitHub のログイン"
if command -v gh >/dev/null 2>&1; then
  say "ok: $(command -v gh) ($(gh --version | head -1))"
elif [ "$check" = 1 ]; then
  lack "gh"
else
  # Get the version from the redirected URL of releases/latest (it does not use the API, so it is not subject to the rate limit).
  tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/cli/cli/releases/latest)
  tag=${tag##*/}
  ver=${tag#v}
  [ -n "$ver" ] && [ "$ver" != latest ] || die "Could not look up the latest gh version" "gh の最新版を引けなかった"
  zip="gh_${ver}_macOS_${gh_arch}.zip"
  dl="https://github.com/cli/cli/releases/download/$tag"
  say "Installing gh $ver" "gh $ver を入れる"
  curl -fsSL "$dl/gh_${ver}_checksums.txt" -o "$tmp/gh-checksums.txt"
  curl -fSL --progress-bar "$dl/$zip" -o "$tmp/$zip"
  (cd "$tmp" && grep " $zip\$" gh-checksums.txt | shasum -a 256 -c -) >/dev/null ||
    die "SHA-256 of the gh zip does not match" "gh の zip の SHA-256 が合わない"
  mkdir -p "$LOCAL_SHARE/gh"
  rm -rf "${LOCAL_SHARE:?}/gh/${zip%.zip}"
  unzip -q "$tmp/$zip" -d "$LOCAL_SHARE/gh"
  ln -sfn "$LOCAL_SHARE/gh/${zip%.zip}/bin/gh" "$LOCAL_BIN/gh"
  hash -r
  say "ok: $(command -v gh) ($(gh --version | head -1))"
fi

gh_logged_in() { command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; }
if gh_logged_in; then
  say "ok: logged in to GitHub" "ok: GitHub にログイン済み"
elif [ "$check" = 1 ]; then
  lack "GitHub login (gh auth login)" "GitHub のログイン (gh auth login)"
else
  (exec </dev/tty) 2>/dev/null || die "GitHub login needs a terminal. Run it from Terminal (not curl … | bash but bash -c \"\$(curl …)\")" "GitHub のログインには端末が要る。ターミナルから実行する (curl … | bash ではなく bash -c \"\$(curl …)\")"
  say "Logging in to GitHub (a browser opens. Paste the code shown)" "GitHub にログインする (ブラウザが開く。表示されたコードを貼る)"
  gh auth login --hostname github.com --git-protocol https --web </dev/tty
  gh_logged_in || die "GitHub login is not finished" "GitHub のログインが済んでいない"
fi

# --- 5. repo -----------------------------------------------------------------
step "5. repo ($REPO → $AIOS_DIR)"
fresh_clone=0
# The development machine's layout: the one that uses it is the aios-stable worktree on branch stable (see "Separating development and dogfood"
# in docs/notes/parallel-work-and-verification.md). Bringing in main and building are the job of promote / reboot, so nothing is touched here.
dogfood=0
if [ -e "$AIOS_DIR/.git" ] && [ "$(git -C "$AIOS_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null)" = stable ]; then
  dogfood=1
fi
if [ "$dogfood" = 1 ]; then
  say "ok: development machine layout ($AIOS_DIR is a worktree of branch stable). Update with npm run reboot in the main repo" "ok: 開発機の構成 ($AIOS_DIR はブランチ stable の worktree)。更新は main の repo で npm run reboot"
elif [ -e "$AIOS_DIR/.git" ]; then
  branch=$(git -C "$AIOS_DIR" symbolic-ref --quiet --short HEAD || echo '(detached)')
  if [ "$check" = 1 ]; then
    git -C "$AIOS_DIR" fetch --quiet 2>/dev/null || say "Could not fetch (network / authentication)" "fetch できなかった (ネットワーク / 認証)"
    behind=$(git -C "$AIOS_DIR" rev-list --count 'HEAD..@{upstream}' 2>/dev/null || echo '?')
    say "ok: ${branch}, ${behind} commit(s) behind upstream" "ok: ${branch}、upstream より ${behind} 個遅れている"
  elif [ -n "$(git -C "$AIOS_DIR" status --porcelain --untracked-files=no)" ]; then
    # A PC where development happens. Do not pull, so as not to pull in local changes (the build still runs).
    say "Not pulling because there are uncommitted changes ($branch)" "未 commit の変更があるので pull しない ($branch)"
  elif ! git -C "$AIOS_DIR" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
    say "Not pulling because $branch has no upstream" "$branch に upstream が無いので pull しない"
  else
    before=$(git -C "$AIOS_DIR" rev-parse HEAD)
    pull_err="$tmp/git-pull.err"
    if ! git -C "$AIOS_DIR" pull --ff-only --quiet 2>"$pull_err"; then
      pull_msg=$(cat "$pull_err" 2>/dev/null || true)
      # On stderr, tell apart a failure of authentication or repo visibility (a mixed-up key, etc.) from a failure where the local copy has actually diverged.
      # Telling the former as "diverged?" would lead to the wrong conclusion (TODO 493 B).
      case "$pull_msg" in
        *'Repository not found'* | *'Permission denied'* | *'Could not read from remote'* | *'authentication failed'* | *'could not read Username'* | *'fatal: Authentication failed'*)
          origin_url=$(git -C "$AIOS_DIR" remote get-url origin 2>/dev/null || echo '?')
          case "$origin_url" in
            git@* | ssh://*)
              die "git pull failed on authentication (origin uses SSH: $origin_url). This happens when this Mac has several GitHub keys and the clone was made with another one. Point at the key with 'git -C \"$AIOS_DIR\" config core.sshCommand \"ssh -i <key to use>\"', or switch to https + gh credentials (if 'gh auth setup-git' is done, 'git -C \"$AIOS_DIR\" remote set-url origin https://github.com/${REPO}.git'). $pull_msg" "git pull が認証で失敗した (origin は SSH: $origin_url)。この Mac に GitHub の鍵が複数あり、別の鍵で clone した場合に起きる。'git -C \"$AIOS_DIR\" config core.sshCommand \"ssh -i <使う鍵>\"' で鍵を指すか、https + gh の資格情報に切り替える ('gh auth setup-git' 済みなら 'git -C \"$AIOS_DIR\" remote set-url origin https://github.com/${REPO}.git')。$pull_msg"
              ;;
            *)
              die "git pull failed on authentication / permission (origin: $origin_url). Check the login with 'gh auth status'. $pull_msg" "git pull が認証/権限で失敗した (origin: $origin_url)。'gh auth status' でログインを確かめる。$pull_msg"
              ;;
          esac
          ;;
        *)
          die "git pull --ff-only failed (do your local commits diverge? Check with 'git -C \"$AIOS_DIR\" status'). $pull_msg" "git pull --ff-only に失敗した (手元の commit が分岐している? 'git -C \"$AIOS_DIR\" status' で確かめる)。$pull_msg"
          ;;
      esac
    fi
    after=$(git -C "$AIOS_DIR" rev-parse HEAD)
    if [ "$before" = "$after" ]; then
      say "ok: up to date ($branch $(git -C "$AIOS_DIR" log -1 --format=%h))" "ok: 最新 ($branch $(git -C "$AIOS_DIR" log -1 --format=%h))"
    else
      say "Updated: $(git -C "$AIOS_DIR" rev-list --count "$before..$after") commit(s) ($(git -C "$AIOS_DIR" log -1 --format='%h %s' | cut -c1-70))" "更新: $(git -C "$AIOS_DIR" rev-list --count "$before..$after") 個の commit ($(git -C "$AIOS_DIR" log -1 --format='%h %s' | cut -c1-70))"
    fi
  fi
elif [ "$check" = 1 ]; then
  lack "repo (not cloned)" "repo (未 clone)"
elif [ -e "$AIOS_DIR" ] && [ -n "$(ls -A "$AIOS_DIR" 2>/dev/null)" ]; then
  die "$AIOS_DIR exists, is not empty and is something else. Choose another place with AIOS_DIR" "$AIOS_DIR が空でない別物。AIOS_DIR で別の場所を指定する"
else
  mkdir -p "$(dirname "$AIOS_DIR")"
  # Let gh handle the git credentials, so that a pull after an https clone also works.
  gh auth setup-git --hostname github.com
  gh repo clone "$REPO" "$AIOS_DIR" -- --quiet
  fresh_clone=1
  say "ok: cloned" "ok: clone した"
fi

# --- 6. The agent CLI ---------------------------------------------------
step "6. agent CLI" "6. エージェント CLI"
# If the version of the repo being cloned is old and does not have it, use the one next to this script (self_repo).
backend="$AIOS_DIR/compat/install-backend.sh"
[ -f "$backend" ] || backend="${self_repo:-/nonexistent}/compat/install-backend.sh"
if [ -f "$backend" ]; then
  if [ "$check" = 1 ]; then
    bash "$backend" --check || lack "agent CLI (not installed / not logged in)" "エージェント CLI (入っていない / 未ログイン)"
  else
    bash "$backend"
  fi
elif [ "$check" = 1 ]; then
  say "compat/install-backend.sh is missing (the repo is not cloned yet or is an old version), so it cannot be checked" "compat/install-backend.sh が無い (repo が未 clone か古い版) ので確かめられない"
else
  die "compat/install-backend.sh is missing ($AIOS_DIR)" "compat/install-backend.sh が無い ($AIOS_DIR)"
fi

# --- End of --check ---------------------------------------------------------
app_electron() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' \
    "$APP/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist" 2>/dev/null || true
}
repo_electron() {
  node -p "require('$AIOS_DIR/node_modules/electron/package.json').version" 2>/dev/null || true
}
# The body is Contents/MacOS/aios (the shell from before TODO 375 used aios-bin). It matches either.
aios_running() { pgrep -u "$(id -u)" -f "^$APP/Contents/MacOS/aios(-bin)?\$" >/dev/null 2>&1; }

if [ "$check" = 1 ]; then
  step "7-8. Build and .app" "7-8. ビルドと .app"
  if [ -d "$APP" ]; then
    say "ok: $APP (Electron $(app_electron), repo's Electron $(repo_electron))" "ok: $APP (Electron $(app_electron)、repo の Electron $(repo_electron))"
    [ "$(readlink "$APP/Contents/Resources/app" 2>/dev/null)" = "$AIOS_DIR" ] ||
      lack ".app points at another place ($(readlink "$APP/Contents/Resources/app" 2>/dev/null))" ".app が別の場所を指している ($(readlink "$APP/Contents/Resources/app" 2>/dev/null))"
  else
    lack "$APP"
  fi
  aios_running && say "aios is running" "aios は起動中" || say "aios is not running" "aios は起動していない"
  echo
  if [ "${#missing[@]}" = 0 ]; then
    say "Everything is in place. To update, run without options" "揃っている。更新するならオプション無しで実行する"
    exit 0
  fi
  say "${#missing[@]} thing(s) missing. Run without options to install them:" "足りないもの ${#missing[@]} 件。オプション無しで実行すれば入れる:"
  for item in "${missing[@]}"; do echo "  - $item"; done
  exit 1
fi

if [ "$dogfood" = 1 ]; then
  echo
  say "The tools are in place. To update aios (pull main, build, restart), run npm run reboot in the main repo" "道具は揃った。aios の更新 (main の取り込み・ビルド・再起動) は main の repo で npm run reboot"
  exit 0
fi

# --- 7. Quit -> dependencies -> build -------------------------------------------
step "7. Build" "7. ビルド"
cd "$AIOS_DIR"

# The build recreates out/, and npm ci recreates node_modules (the native modules that aios reads at run time), so quit the running aios first.
was_running=0
if aios_running; then
  was_running=1
  ask_yes "aios is running. Quit it and update?" "aios が起動中。終了してから更新する?" || die "Quit aios and run again" "aios を終了してからもう一度実行する"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  waited=0
  while aios_running; do
    sleep 1
    waited=$((waited + 1))
    ((waited < 60)) || die "aios did not quit after waiting 60 seconds. Quit it by hand and run again" "60 秒待っても aios が終了しない。手で終了してからもう一度実行する"
  done
  say "Quit aios" "aios を終了した"
fi

lock_hash=$(shasum -a 256 package-lock.json | cut -d' ' -f1)
marker=node_modules/.aios-lock.sha256
if [ ! -d node_modules ] || [ "$(cat "$marker" 2>/dev/null)" != "$lock_hash" ]; then
  say "npm ci (package-lock.json changed / node_modules is missing)" "npm ci (package-lock.json が変わった / node_modules が無い)"
  npm ci --no-audit --no-fund
  echo "$lock_hash" >"$marker"
else
  say "Dependencies unchanged (skipping npm ci)" "依存は変わっていない (npm ci を飛ばす)"
fi

# The same mark as promote-stable.sh (out/.built-commit). When there are uncommitted local changes, do not trust the mark.
head=$(git rev-parse HEAD)
if [ "$(cat out/.built-commit 2>/dev/null || true)" = "$head" ] &&
  [ -z "$(git status --porcelain --untracked-files=no)" ]; then
  say "Already built ($(git log -1 --format=%h))" "ビルド済み ($(git log -1 --format=%h))"
else
  say "npm run build"
  rm -f out/.built-commit
  npm run build || die "The build failed. out/ is incomplete, so aios will not start until it is fixed" "ビルドに失敗した。out/ が欠けているので、直すまで aios は起動しない"
  echo "$head" >out/.built-commit
fi

# --- 8. aios.app -------------------------------------------------------------
step "8. ~/Applications/aios.app"
reason=""
if [ ! -d "$APP" ]; then
  reason="$(pick 'missing' '無い')"
elif [ "$(readlink "$APP/Contents/Resources/app" 2>/dev/null)" != "$AIOS_DIR" ]; then
  reason="$(pick 'it points at another clone' '別の clone を指している')"
elif [ "$(app_electron)" != "$(repo_electron)" ]; then
  reason="$(pick "Electron went from $(app_electron) to $(repo_electron)" "Electron が $(app_electron) → $(repo_electron) に上がった")"
elif [ -e "$APP/Contents/MacOS/aios-bin" ]; then
  reason="$(pick 'old layout (aios-bin; no notifications, TODO 375)' '旧い形 (aios-bin。通知が出ない、TODO 375)')"
fi
if [ -n "$reason" ]; then
  say "Rebuilding ($reason). If the keychain asks about \"aios Safe Storage\" on the next launch, press \"Always Allow\"" "作り直す ($reason)。次の起動でキーチェーンの「aios Safe Storage」の確認が出たら「常に許可」を押す"
  say "(if you press \"Deny\", the DB cannot be opened and it runs in memory only)" "(「拒否」すると DB が開けず、メモリだけで動く)"
  node scripts/make-app.mjs
else
  say "ok: not rebuilding (it is a symlink into the repo, so a build alone updates it)" "ok: 作り直さない (中身は repo への symlink なので、ビルドだけで新しくなっている)"
fi

# --- 9. Launch -----------------------------------------------------------------
step "9. Launch" "9. 起動"
if [ "$launch" = 1 ] || [ "$was_running" = 1 ]; then
  # open passes the caller's environment variables. If ELECTRON_RUN_AS_NODE is passed, it launches as plain Node and exits (TODO 375).
  env -u ELECTRON_RUN_AS_NODE open -a "$APP"
  say "Launched" "起動した"
else
  say "Skipped launching (open -a \"$APP\")" "起動は飛ばした (open -a \"$APP\")"
fi
[ "$fresh_clone" = 1 ] && say "The first launch runs a full scan to build the index (a few minutes). If macOS asks, allow it" "初回の起動では索引づくりの全走査が走る (数分)。macOS の確認が出たら許可する"
say "Done" "完了"
