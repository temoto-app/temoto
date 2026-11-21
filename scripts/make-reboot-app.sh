#!/bin/sh
# Makes an app, callable from the Dock / Spotlight / BetterTouchTool, that "restarts Temoto with the latest version".
#
#   scripts/make-reboot-app.sh [output directory]   the default is ~/Applications → Temoto-reboot.app
#
# The shell it restarts is still ~/Applications/aios.app (the internal file name stays; its Dock / menu name is Temoto, TODO 1254).
# The previous aios-reboot.app is left as it is (delete it by hand once this one is on the Dock).
# The contents are an AppleScript app that only calls scripts/reboot-stable.sh through a login shell (-i: it reads the PATH from .zshrc).
# The location of the repo is embedded as it was when the app was made.
# The result is shown as a notification, and the full text remains in ~/Library/Logs/Temoto-reboot.log.
# After making it, drag ~/Applications/Temoto-reboot.app onto the Dock in Finder.
set -eu

[ "$(uname)" = Darwin ] || { echo "macOS 専用。" >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
# Even if it is made from a worktree, the one that users refer to is the main repo's script.
main=$(git -C "$root" worktree list --porcelain | sed -n '1s/^worktree //p')
out=${1:-$HOME/Applications}
app="$out/Temoto-reboot.app"
mkdir -p "$out"
rm -rf "$app"

osacompile -o "$app" -e "
set logFile to (POSIX path of (path to home folder)) & \"Library/Logs/Temoto-reboot.log\"
set cmd to \"cd '$main' && sh scripts/reboot-stable.sh\"
try
	do shell script \"/bin/zsh -ilc \" & quoted form of cmd & \" > \" & quoted form of logFile & \" 2>&1\"
	display notification \"最新版で起動しました\" with title \"Temoto reboot\"
on error errMsg
	display notification \"失敗: \" & errMsg & \" (~/Library/Logs/Temoto-reboot.log)\" with title \"Temoto reboot\"
end try
"

# It needs neither a window nor a bounce of the Dock icon (it runs in the background and only shows a notification).
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$app/Contents/Info.plist" 2>/dev/null || true
echo "作った: $app"
echo "Dock へ入れる: Finder で $app を Dock の右側 (ゴミ箱の左) へドラッグ"
