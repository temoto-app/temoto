#!/bin/bash
# Fetches the built Temoto.app from GitHub Releases and installs it into ~/Applications (macOS / Apple Silicon only, TODO 492).
# It is attached to a Release and distributed that way. On the user's machine, neither Node nor Command Line Tools nor a build is needed.
#
# Install or update (both are the same; see "How to install" in the README):
#   curl -fsSLO https://github.com/temoto-app/temoto/releases/latest/download/install-temoto.sh && bash install-temoto.sh
# or, with the GitHub CLI:
#   gh release download -R temoto-app/temoto -p install-temoto.sh --clobber && bash install-temoto.sh
# After installing, Temoto updates itself (TODO 103; "Updates" in settings, and it can be stopped from settings too).
# TODO 1263: renamed from install-aios.sh. gh is used when it is installed and logged in; otherwise the Release assets of the public repo are
# fetched with curl, without authentication (https only). Either way the SHA-256 and the signature are checked the same way.
#
# Options:
#   --version vX.Y.Z   the version to install (default: the latest Release). Also used to go back to an earlier version (if its version directory remains, it is not fetched)
#   --force            reinstall even if the same version is installed
#   --yes              quit a running Temoto without asking / proceed with installing the agent CLI without asking
#   --no-launch        do not launch Temoto at the end
#
# Environment variables:
#   AIOS_REPO           the repo to fetch the Release from (default temoto-app/temoto)
#   AIOS_APP            the install destination (default ~/Applications/Temoto.app; the real .app is placed there)
#   AIOS_INSTALL_ROOT   the root of the per-version directories (default ~/.local/share/<data name>; see "Data name" below)
#
# Layout (TODO 103 + 1050: the real app sits in ~/Applications, and the versions set aside are kept in versions. Temoto's auto-update works on the same layout;
# see src/main/update/layout.ts):
#   $AIOS_APP                                          the real app of the installed version (the path the Dock remembers; always points to the latest)
#   $AIOS_INSTALL_ROOT/versions/<version>/Temoto.app   the older versions set aside (keeps 3 at most, newest first, including the version just installed)
#   $AIOS_INSTALL_ROOT/install.json                    {"link":"<AIOS_APP>","releaseRepo":"<AIOS_REPO>"[,"hold":"<version>"]} (read by Temoto's auto-update)
#     releaseRepo: TODO 1185 changed the key's name from the repo. The old key's repo still holds the default from before the switch, so Temoto does not read it
#     hold: when --version went back to a version older than the current one, the version from before going back. Temoto does not auto-install this version or older ones (it resumes with a newer Release)
#   Swapping is only a rename: the current $AIOS_APP is set aside into versions/<current version>/, and the new version is renamed into $AIOS_APP (going back to an earlier version works the same way).
#   The symlink form that 103 installed ($AIOS_APP pointing at a versions entry) is replaced by the real thing at this point (done in one go).
#
# Stages:
#   1. Prerequisites: macOS / Apple Silicon. gh is optional (used when installed and logged in; otherwise curl against the public repo)
#   2. If the destination, or ~/Applications/aios.app, is the development machine's shell (a .app pointing at the repo), stop. Update the development machine with npm run reboot / promote
#   3. Decide the version (the latest Release, or --version). If the same version is installed, do nothing (reinstall with --force).
#      But if it is the symlink form, replace it with the real form without fetching anything
#   4. Fetch the zip, SHA256SUMS and install-backend.sh, and verify the SHA-256 (if that version's directory already exists, the zip is not fetched)
#   5. Check whether the agent CLI (Temoto does not bundle it) is installed and logged in. If not, install it with install-backend.sh
#   6. Expand with ditto -x -k and verify the signature (identifier io.github.temoto-app.temoto)
#   7. Quit the running Temoto, put the new version into the version directory, set the current Temoto.app aside and install the new version by rename, clean up the older versions, launch
#
# The name was changed from aios to Temoto (TODO 1254). ~/Applications/aios.app, installed under the previous name, is kept rather than deleted, and is reported at the end
# (the data and settings stay in the same place, and Temoto takes them over).
#
# Data name (TODO 1263): if this machine already has the legacy userData (~/Library/Application Support/aios, a real directory, not a symlink),
# Temoto keeps running under the legacy name (aios: userData, the keychain item "aios Safe Storage", ~/aios/, ~/Library/Logs/aios,
# ~/.local/share/aios). Otherwise everything is under Temoto. A machine whose ~/Library/Application Support/Temoto already holds the DB
# (aios.db, a real file in a real directory) stays on Temoto even if the legacy userData appears later. The same decision as
# src/common/app-identity.ts (a test compares them).
set -euo pipefail

# The public product name, the public repo and the identifiers (TODO 1254 / 1263). The same values as `name`, `releaseRepo`, `bundleId`, `dataName`
# and `legacyDataName` in src/shared/product.json (test/product-name.test.ts checks that they match).
PRODUCT=Temoto
PUBLIC_REPO=temoto-app/temoto
BUNDLE_ID=io.github.temoto-app.temoto
DATA_NAME=Temoto
LEGACY_DATA_NAME=aios
# The identifier of an install under the name from before the rename (~0.92), only used to ask it to quit.
LEGACY_BUNDLE_ID=local.aios
LEGACY_USER_DATA="$HOME/Library/Application Support/$LEGACY_DATA_NAME"
CURRENT_USER_DATA="$HOME/Library/Application Support/$DATA_NAME"
# The DB file inside userData (USER_DATA_DB_FILE in src/common/app-identity.ts).
USER_DATA_DB=aios.db
current_has_db() { [ -d "$CURRENT_USER_DATA" ] && [ ! -L "$CURRENT_USER_DATA" ] && [ -f "$CURRENT_USER_DATA/$USER_DATA_DB" ] && [ ! -L "$CURRENT_USER_DATA/$USER_DATA_DB" ]; }
if ! current_has_db && [ -d "$LEGACY_USER_DATA" ] && [ ! -L "$LEGACY_USER_DATA" ]; then DATA_NAME="$LEGACY_DATA_NAME"; fi
APP_NAME="$PRODUCT.app"
REPO="${AIOS_REPO:-$PUBLIC_REPO}"
APP="${AIOS_APP:-$HOME/Applications/$APP_NAME}"
DEFAULT_ROOT="$HOME/.local/share/$DATA_NAME"
ROOT="${AIOS_INSTALL_ROOT:-$DEFAULT_ROOT}"
VERSIONS="$ROOT/versions"
# The pgrep pattern for the running Temoto. Both ends are fixed (TODO 931): a prefix match would also hit an orphaned MCP gateway left behind
# (`<…/Temoto> …/gateway.js`, started with process.execPath), and the update would stop because the old one "does not quit".
# The same approach as reboot-stable.sh / promote-stable.sh.
AIOS_PGREP="^($VERSIONS/[^/]*/$APP_NAME|$APP)/Contents/MacOS/$PRODUCT\$"
# An install under the name from before the rename (~0.92) (TODO 1254). On a development machine's shell, stop here. If the distributed build is left,
# it is also quit before the swap (the data location is the same, so both cannot run at once). Nothing is deleted.
LEGACY_APP="$HOME/Applications/aios.app"
LEGACY_PGREP="^($VERSIONS/[^/]*/aios.app|$LEGACY_APP)/Contents/MacOS/aios\$"
# How many versions to keep (newest first, including the version just installed). The same as KEEP_VERSIONS in src/main/update/stage.ts.
KEEP_VERSIONS=3

want_tag=""
force=0
assume_yes=0
launch=1
while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || { echo "install-temoto: --version に版を付ける (例: --version v0.24.0)" >&2; exit 2; }
      want_tag="$2"
      shift
      ;;
    --version=*) want_tag="${1#--version=}" ;;
    --force) force=1 ;;
    --yes | -y) assume_yes=1 ;;
    --no-launch) launch=0 ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "install-temoto: 知らないオプション: $1" >&2
      exit 2
      ;;
  esac
  shift
done
case "$want_tag" in "" | v*) ;; *) want_tag="v$want_tag" ;; esac

say() { echo "install-temoto: $*"; }
die() {
  echo "install-temoto: $*" >&2
  exit 1
}
ask_yes() {
  # $1 = the question. With --yes it says yes without asking. If there is no terminal, it says no.
  [ "$assume_yes" = 1 ] && return 0
  [ -r /dev/tty ] || return 1
  local answer
  printf 'install-temoto: %s [Y/n] ' "$1" >/dev/tty
  read -r answer </dev/tty || return 1
  case "$answer" in n | N | no | NO) return 1 ;; *) return 0 ;; esac
}

# --- 1. Prerequisites -----------------------------------------------------------------
[ "$(uname -s)" = Darwin ] || die "macOS 専用。"
[ "$(id -u)" != 0 ] || die "sudo を付けずに実行する (入れる先は実行したユーザの ~/Applications)。"
[ "$(sysctl -in hw.optional.arm64 2>/dev/null)" = 1 ] || die "Apple Silicon の Mac 専用 (配っているのは arm64 だけ)。"

# Fetching from the Release (TODO 1263). gh when it is installed and logged in (any AIOS_REPO, private ones included); otherwise curl against the
# public repo only, without authentication, https only (redirects included: the assets are served from release-assets.githubusercontent.com).
use_gh=0
if command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; then use_gh=1; fi
if [ "$use_gh" = 0 ]; then
  [ "$REPO" = "$PUBLIC_REPO" ] || die "AIOS_REPO ($REPO) から取るには gh が要る (gh なしで取れるのは公開 repo $PUBLIC_REPO だけ)。gh を入れて gh auth login する"
  command -v curl >/dev/null 2>&1 || die "curl が無い"
fi
CURL=(curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 30 --retry 2)
# The tag of the latest Release.
latest_tag() {
  if [ "$use_gh" = 1 ]; then
    gh release view -R "$REPO" --json tagName --jq .tagName 2>/dev/null
    return
  fi
  "${CURL[@]}" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$PUBLIC_REPO/releases/latest" |
    plutil -extract tag_name raw -o - -
}
# $1 = tag (already checked to be vX.Y.Z), $2 = destination directory, the rest = asset names.
fetch_assets() {
  local tag="$1" dest="$2" name
  shift 2
  if [ "$use_gh" = 1 ]; then
    local args=()
    for name in "$@"; do args+=(-p "$name"); done
    gh release download "$tag" -R "$REPO" -D "$dest" "${args[@]}"
    return
  fi
  for name in "$@"; do
    "${CURL[@]}" -o "$dest/$name" "https://github.com/$PUBLIC_REPO/releases/download/$tag/$name" || return 1
  done
}

# --- 2. Do not overwrite a development machine's shell ---------------------------------------------
# On a development machine, ~/Applications/aios.app is a shell that points at the repo (aios-stable and the like) (scripts/make-app.mjs).
# It is a shell if Contents/Resources/app is a symlink. In the distributed build, that is a real directory.
# TODO 1254: the destination's name has changed to Temoto.app, so the shell's location under the previous name is checked too. On a development machine, nothing is done, as before.
for candidate in "$APP" "$LEGACY_APP"; do
  if [ -L "$candidate/Contents/Resources/app" ]; then
    die "$candidate は開発機の殻 ($(readlink "$candidate/Contents/Resources/app") を指している)。上書きしない。開発機の更新は repo で npm run reboot (または npm run promote)"
  fi
done
# Whether a distribution installed under the previous name remains (reported at the end. If the destination was set to the previous name with AIOS_APP, it is the same thing and is not counted).
legacy=0
if [ "$APP" != "$LEGACY_APP" ] && { [ -e "$LEGACY_APP" ] || [ -L "$LEGACY_APP" ]; }; then legacy=1; fi
# Whether it is running: a Temoto running from the version directory (even when started through the symlink, it runs under the real path), the real $APP,
# and a distribution installed under the previous name (TODO 1254. The data location is the same, so if one remains, it is quit too before the swap).
temoto_running() { pgrep -u "$(id -u)" -f "$AIOS_PGREP" >/dev/null 2>&1; }
legacy_running() { [ "$legacy" = 1 ] && pgrep -u "$(id -u)" -f "$LEGACY_PGREP" >/dev/null 2>&1; }
aios_running() { temoto_running || legacy_running; }
# The identifiers to ask to quit for a running Temoto.app: the new one always, and LEGACY_BUNDLE_ID when a bundle that AIOS_PGREP covers
# (the real $APP or a version directory) says so in its Info.plist (0.92.x: Temoto.app signed local.aios). Any other value is ignored.
temoto_bundle_ids() {
  local bundle ident legacy_id=0
  for bundle in "$APP" "$VERSIONS"/*/"$APP_NAME"; do
    [ -f "$bundle/Contents/Info.plist" ] || continue
    ident=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Contents/Info.plist" 2>/dev/null || true)
    [ "$ident" = "$LEGACY_BUNDLE_ID" ] && legacy_id=1
  done
  echo "$BUNDLE_ID"
  [ "$legacy_id" = 1 ] && echo "$LEGACY_BUNDLE_ID"
  return 0
}
# form: symlink (the 103 form; replaced with the real form) / real (the real thing) / none (not there yet)
form=none
if [ -L "$APP" ]; then
  # A symlink that points at a version directory (TODO 103). If it points at something else, do not touch it.
  case "$(readlink "$APP")" in
    "$VERSIONS"/*/"$APP_NAME") form=symlink ;;
    *) die "$APP は $(readlink "$APP") を指す symlink で、$VERSIONS の版ではない。別のものなら退けてからもう一度" ;;
  esac
elif [ -e "$APP" ]; then
  [ -d "$APP/Contents/Resources/app" ] || die "$APP が $PRODUCT の配布物の形でない。別のものなら退けてからもう一度"
  form=real
fi

# --- 3. Version -------------------------------------------------------------------
if [ -n "$want_tag" ]; then
  tag="$want_tag"
else
  tag=$(latest_tag) ||
    die "$REPO の最新の Release を引けなかった (gh を使うなら gh auth status でログインを確かめる)"
fi
version="${tag#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "版の形でない: $tag"
installed=""
if [ -f "$APP/Contents/Info.plist" ]; then
  installed=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || true)
fi
say "入れる版: $version$([ -n "$installed" ] && echo " (いま: $installed)")"
# Strings for install.json (`"` and `\` are escaped. Used both in the "already installed" branch and after the swap).
json_string() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}
# A real-form Temoto cannot trace the root from its own location (review 57-10). When the root is not the default location (AIOS_INSTALL_ROOT), it places
# `install-root` (one line with the absolute path of the root) in the default root, so that Temoto's auto-update can follow it. If the root is the default, it deletes it.
# DEFAULT_ROOT is ~/.local/share/<data name> (set at the top, TODO 1263).
record_root() {
  if [ "$ROOT" != "$DEFAULT_ROOT" ]; then
    mkdir -p "$DEFAULT_ROOT"
    printf '%s\n' "$ROOT" >"$DEFAULT_ROOT/install-root"
  else
    rm -f "$DEFAULT_ROOT/install-root"
  fi
}
# The same version is installed. For the real form, do nothing. For the symlink form, replace it with the real form without fetching anything (adopt: the version
# directory already holds that version's .app, so it is simply put in place).
adopt=0
if [ "$installed" = "$version" ] && [ "$force" = 0 ] && [ "$form" = symlink ] && [ -d "$VERSIONS/$version/$APP_NAME" ]; then
  adopt=1
  say "既に $version が入っている。symlink を実体の .app に置き換える"
fi
if [ "$installed" = "$version" ] && [ "$force" = 0 ] && [ "$form" = real ]; then
  say "既に $version が入っている。入れ直すなら --force"
  # A real install made by an old install-aios.sh has no memo for Temoto's auto-update to read. If there is none, write one (hold is not touched).
  # TODO 1263: a memo written for the .app of the name before the rename (link .../aios.app) is replaced too (its hold is about the old versions).
  if [ ! -f "$ROOT/install.json" ] || grep -q '"link":"[^"]*/aios\.app"' "$ROOT/install.json"; then
    mkdir -p "$ROOT"
    printf '{"link":%s,"releaseRepo":%s}\n' "$(json_string "$APP")" "$(json_string "$REPO")" >"$ROOT/install.json"
  fi
  record_root
  if [ "$launch" = 1 ] && ! aios_running; then
    env -u ELECTRON_RUN_AS_NODE open -a "$APP"
  fi
  exit 0
fi

# --- 4. Fetch ----------------------------------------------------------------------
tmp=$(mktemp -d "${TMPDIR:-/tmp}/aios-install.XXXXXX")
stage=""
cleanup() {
  rm -rf "$tmp"
  if [ -n "$stage" ]; then rm -rf "$stage"; fi
}
trap cleanup EXIT
zip="$PRODUCT-${version}-arm64-mac.zip"
# If that version's directory already exists (it was put there by going back to an earlier version, or by Temoto's auto-update), the zip is not fetched and that one is used.
reuse=0
if [ "$adopt" = 1 ]; then
  : # Not fetched (only the .app in the version directory is put in place)
elif [ "$force" = 0 ] && [ -d "$VERSIONS/$version/$APP_NAME" ]; then
  reuse=1
  say "版のディレクトリを使う: $VERSIONS/$version"
  fetch_assets "$tag" "$tmp" SHA256SUMS install-backend.sh ||
    die "Release $tag から取れなかった"
  [ "$(awk '$2 == "install-backend.sh"' "$tmp/SHA256SUMS" | wc -l | tr -d ' ')" = 1 ] ||
    die "SHA256SUMS に install-backend.sh の行がちょうど 1 行は無い。取り直すか、オーナーに知らせる"
  (cd "$tmp" && grep -E "  install-backend\.sh\$" SHA256SUMS | shasum -a 256 -c -) >/dev/null ||
    die "SHA-256 が合わない (SHA256SUMS)。取り直すか、オーナーに知らせる"
else
  say "取る: $REPO $tag ($zip)$([ "$use_gh" = 1 ] && echo ' (gh)' || echo ' (curl)')"
  fetch_assets "$tag" "$tmp" "$zip" SHA256SUMS install-backend.sh ||
    die "Release $tag から取れなかった"
  # Before verifying, check that each needed file has exactly one line (a hole that fails only when no line matches at all, TODO 931).
  for f in "$zip" install-backend.sh; do
    [ "$(awk -v f="$f" '$2 == f' "$tmp/SHA256SUMS" | wc -l | tr -d ' ')" = 1 ] ||
      die "SHA256SUMS に $f の行がちょうど 1 行は無い。取り直すか、オーナーに知らせる"
  done
  (cd "$tmp" && grep -E "  ($zip|install-backend\.sh)\$" SHA256SUMS | shasum -a 256 -c -) >/dev/null ||
    die "SHA-256 が合わない (SHA256SUMS)。取り直すか、オーナーに知らせる"
fi
[ "$adopt" = 1 ] || say "SHA-256: ok"

# --- 5. Agent CLI -----------------------------------------------------
# Temoto does not bundle the CLI (it runs the CLI that the user installed and logged in to, as a child process).
# Only install-backend.sh (compat/ in the repo) knows the CLI's name and its official installer.
if [ "$adopt" = 1 ]; then
  : # install-backend.sh was not fetched (only the form changes, at the same version; it was checked when it was installed earlier)
elif bash "$tmp/install-backend.sh" --check; then
  :
elif ask_yes "エージェント CLI が無いかログインしていない。いま入れる / ログインする?"; then
  bash "$tmp/install-backend.sh"
else
  say "CLI は後で入れる (bash install-backend.sh)。無いままでも $PRODUCT は起動するが、スレッドは動かない"
fi

# --- 6. Expansion and signature check ---------------------------------------------
# Expansion goes into a staging area next to the version directory (it is put in place with one rename; even if it stops partway,
# the version directory is not touched). The zip is expanded with ditto (an Electron .app holds symlinks inside Framework. unzip keeps them too,
# but ditto is the macOS standard).
verify_app() {
  codesign --verify --deep --strict "$1" 2>/dev/null || die "$APP_NAME の署名が壊れている ($1)"
  local ident
  ident=$(codesign -dv "$1" 2>&1 | sed -n 's/^Identifier=//p')
  [ "$ident" = "$BUNDLE_ID" ] || die "署名の identifier が $BUNDLE_ID でない ($ident)"
  # Show the signing authority (TODO 951: from 0.58 on there is a Developer ID + notarized build. A version self-signed with aios dev can also be installed).
  local who
  who=$(codesign -dvv "$1" 2>&1 | sed -n 's/^Authority=//p' | sed -n 1p)
  say "署名: ${who:-ad-hoc}"
}
mkdir -p "$VERSIONS"
if [ "$adopt" = 1 ]; then
  verify_app "$VERSIONS/$version/$APP_NAME"
elif [ "$reuse" = 1 ]; then
  verify_app "$VERSIONS/$version/$APP_NAME"
else
  stage=$(mktemp -d "$VERSIONS/.staging-XXXXXX")
  mkdir -p "$stage/x" "$stage/out"
  ditto -x -k "$tmp/$zip" "$stage/x"
  new="$stage/x/$APP_NAME"
  [ -d "$new" ] || die "zip の中に $APP_NAME が無い"
  verify_app "$new"
  # gh / curl do not attach the quarantine mark, but remove it in case the zip came from a browser download (so that no Gatekeeper confirmation is shown).
  xattr -dr com.apple.quarantine "$new" 2>/dev/null || true
  mv "$new" "$stage/out/$APP_NAME"
fi

# --- 7. Quit -> place -> swap -> launch -----------------------------------------
was_running=0
if aios_running; then
  was_running=1
  ask_yes "$PRODUCT が起動中。終了してから入れ替える?" || die "$PRODUCT を終了してからもう一度実行する"
  # A Temoto.app may still carry the old identifier: 0.92.x was already Temoto.app but signed local.aios (TODO 1263 code-review).
  # Asking only the new identifier left it running, and the swap gave up after 60 s. Each identifier a bundle the pgrep pattern covers
  # carries is asked (only the two known ones; read from Info.plist, never from the process).
  if temoto_running; then
    for id in $(temoto_bundle_ids); do
      osascript -e "tell application id \"$id\" to quit" >/dev/null 2>&1 || true
    done
  fi
  # An install under the name from before the rename has the old identifier (TODO 1263). Only asked when it is the one running.
  if legacy_running; then
    osascript -e "tell application id \"$LEGACY_BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  fi
  waited=0
  while aios_running; do
    sleep 1
    waited=$((waited + 1))
    ((waited < 60)) || die "60 秒待っても $PRODUCT が終了しない。手で終了してからもう一度実行する"
  done
  say "$PRODUCT を終了した"
fi

# Put it in the version directory (one rename. When reinstalling the same version with --force, set the previous one aside first).
if [ "$reuse" = 0 ] && [ "$adopt" = 0 ]; then
  if [ -e "$VERSIONS/$version" ]; then mv "$VERSIONS/$version" "$stage/replaced"; fi
  mv "$stage/out" "$VERSIONS/$version" || die "$VERSIONS/$version に置けなかった"
fi

# The memo that Temoto's auto-update reads (the symlink location, the repo, and the hold).
# hold: when --version went back to a version older than the current one, write the version from before going back. Temoto does not install
# that version or older ones (so that a later check does not re-fetch and undo the going back). If the earlier hold is newer than that, keep it.
# Clear it when no --version is given (the latest), or when a version newer than the hold is installed.
is_semver() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; }
version_lt() {
  # True if $1 < $2 (compares the three numbers).
  local IFS=.
  local -a a=($1) b=($2)
  local i
  for i in 0 1 2; do
    if ((10#${a[i]} < 10#${b[i]})); then return 0; fi
    if ((10#${a[i]} > 10#${b[i]})); then return 1; fi
  done
  return 1
}
prev_hold=""
if [ -f "$ROOT/install.json" ]; then
  prev_hold=$(sed -n 's/.*"hold":"\([0-9][0-9.]*\)".*/\1/p' "$ROOT/install.json" | head -n 1)
  is_semver "$prev_hold" || prev_hold=""
fi
hold=""
if [ -n "$want_tag" ]; then
  if is_semver "$installed" && version_lt "$version" "$installed"; then hold="$installed"; fi
  if [ -n "$prev_hold" ] && version_lt "$version" "$prev_hold" && { [ -z "$hold" ] || version_lt "$hold" "$prev_hold"; }; then
    hold="$prev_hold"
  fi
fi
mkdir -p "$ROOT"
hold_json=""
if [ -n "$hold" ]; then hold_json=",\"hold\":$(json_string "$hold")"; fi
printf '{"link":%s,"releaseRepo":%s%s}\n' "$(json_string "$APP")" "$(json_string "$REPO")" "$hold_json" >"$ROOT/install.json.tmp"
mv -f "$ROOT/install.json.tmp" "$ROOT/install.json"
record_root

# Set the current Temoto.app aside into versions/<current version>/, and install the new version by a rename (a rename on the same volume only;
# if it fails partway, undo it). The Dock remembers the real path of $APP, so the latest always opens. The symlink form (103) is removed and
# replaced with the real thing.
mkdir -p "$(dirname "$APP")"
retired=""
undo_link=""
if [ -L "$APP" ]; then
  undo_link=$(readlink "$APP")
  rm -f "$APP"
elif [ -e "$APP" ]; then
  if is_semver "$installed" && [ "$installed" != "$version" ] && [ ! -e "$VERSIONS/$installed" ]; then
    mkdir "$VERSIONS/$installed"
    mv "$APP" "$VERSIONS/$installed/$APP_NAME"
    retired="$VERSIONS/$installed/$APP_NAME"
  else
    mv "$APP" "$tmp/old.app"
    retired="$tmp/old.app"
  fi
fi
if ! mv "$VERSIONS/$version/$APP_NAME" "$APP"; then
  if [ -n "$retired" ] && [ ! -e "$APP" ]; then mv "$retired" "$APP"; fi
  if [ -n "$undo_link" ] && [ ! -e "$APP" ]; then ln -s "$undo_link" "$APP"; fi
  die "$APP に据えられなかった (元に戻した)"
fi
# The version directory after the swap is empty (rmdir removes it only when it is empty).
rmdir "$VERSIONS/$version" 2>/dev/null || true

# Clean up the older versions (keep up to KEEP_VERSIONS, newest first, including the version just installed).
kept=1 # for the version just installed (the real $APP)
for old in $(ls -1 "$VERSIONS" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
  [ "$old" = "$version" ] && continue
  if [ "$kept" -ge "$KEEP_VERSIONS" ]; then
    rm -rf "${VERSIONS:?}/$old"
    say "古い版を片付けた: $old"
  else
    kept=$((kept + 1))
  fi
done

# Have LaunchServices learn it again (icon, and drop onto the Dock). Only for the default location: registering a copy at another location (AIOS_APP)
# would list two identical entries of the same identifier, which could garble notifications and the target of `tell application id` (the same as make-app.mjs).
if [ "$APP" = "$HOME/Applications/$APP_NAME" ]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
fi
say "入れた: $APP ($version)"
if [ -n "$hold" ]; then
  say "自動更新は保留: $hold までは入れない ($hold より新しい Release が出たら再開。今すぐ戻すなら --version なしで実行)"
fi

if [ "$launch" = 1 ] || [ "$was_running" = 1 ]; then
  # open passes the caller's environment variables. If ELECTRON_RUN_AS_NODE is passed, it launches as plain Node and exits (TODO 375).
  env -u ELECTRON_RUN_AS_NODE open -a "$APP"
  say "起動した"
else
  say "起動は飛ばした (open -a \"$APP\")"
fi
if [ -z "$installed" ]; then
  say "初回の起動でキーチェーンの「$DATA_NAME Safe Storage」の確認が出たら「常に許可」を押す (「拒否」すると DB が開けない)"
  say "初回は索引づくりの全走査が走る (数分)。macOS のアクセスの確認が出たら許可する"
fi
say "以後は $PRODUCT が自分で更新する (設定の「更新」。止めるのも設定から)"
if [ "$legacy" = 1 ]; then
  say "前の名前で入れた $LEGACY_APP が残っている。会話・設定・索引はそのまま $PRODUCT が引き継いだので、確かめたら $LEGACY_APP を削除する (ゴミ箱へ)"
fi
say "完了"
