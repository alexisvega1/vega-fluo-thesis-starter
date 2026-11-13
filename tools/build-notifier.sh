#!/bin/zsh
# Builds .cache/Vega Fluo.app: a tiny app whose only job is to post one notification and quit, so that
# Vega Fluo's reminders carry its own name and icon (macOS credits osascript notifications to Script Editor).
# It is not a background agent: the server opens it for a moment each time it has something to say.
set -euo pipefail
cd "${0:A:h}/.."
APP=".cache/Vega Fluo.app"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# the message is handed over in a file next to the app, read once, then deleted
cat > "$TMP/notify.applescript" <<'EOF'
on run
	set msgFile to (POSIX path of (path to me)) & "../notify.txt"
	try
		set msg to read (POSIX file msgFile) as «class utf8»
	on error
		return
	end try
	do shell script "rm -f " & quoted form of msgFile
	set AppleScript's text item delimiters to linefeed
	set parts to text items of msg
	set AppleScript's text item delimiters to ""
	if (count of parts) > 1 then
		display notification (item 2 of parts) with title "Vega Fluo" subtitle (item 1 of parts) sound name "Glass"
	else
		display notification msg with title "Vega Fluo" sound name "Glass"
	end if
	delay 1
end run
EOF

rm -rf "$APP"
mkdir -p .cache
osacompile -o "$APP" "$TMP/notify.applescript"

# icon from the app's own favicon
ICONSET="$TMP/VegaFluo.iconset"
mkdir -p "$ICONSET"
for s in 16 32 64 128 256 512; do
  sips -z $s $s web/favicon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); [ $d -le 1024 ] && sips -z $d $d web/favicon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/applet.icns"
rm -f "$APP/Contents/Resources/Assets.car" # newer macOS takes the default icon from here, over applet.icns

PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Vega Fluo" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile applet" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string applet" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Vega Fluo" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Vega Fluo" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string local.vegafluo.notifier" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier local.vegafluo.notifier" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$PLIST"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
touch "$APP"
echo "built $APP"
