#!/bin/sh
# Build a dockable macOS .app in /Applications that runs ./start.sh in a new
# Terminal window. Re-running this script replaces the existing install.
# The script path is baked in at install time — re-run after moving the repo.
#
# Icon: drop icon.icns (preferred) or icon.png (1024x1024 recommended) in the
# repo root before running. icon.png is auto-converted via sips + iconutil.
set -eu

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="XFarm"
BUNDLE_ID="local.xfarm.app"
APP_PATH="/Applications/${APP_NAME}.app"
SCRIPT="$REPO_DIR/start.sh"

# Legacy install from earlier versions of this script
OLD_APP_PATH="/Applications/start.app"
OLD_BUNDLE_ID="local.xfarm.start"

if [ ! -x "$SCRIPT" ]; then
  echo "error: $SCRIPT not found or not executable" >&2
  exit 1
fi

if [ -e "$OLD_APP_PATH" ]; then
  OLD_ID="$(defaults read "$OLD_APP_PATH/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
  if [ "$OLD_ID" = "$OLD_BUNDLE_ID" ]; then
    echo "Removing legacy $OLD_APP_PATH"
    rm -rf "$OLD_APP_PATH"
  fi
fi

if [ -e "$APP_PATH" ]; then
  EXISTING_ID="$(defaults read "$APP_PATH/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
  if [ "$EXISTING_ID" != "$BUNDLE_ID" ]; then
    echo "error: $APP_PATH exists but isn't ours (bundle id: ${EXISTING_ID:-unknown})" >&2
    echo "remove it manually if you're sure you want to overwrite it" >&2
    exit 1
  fi
  echo "Removing existing $APP_PATH"
  rm -rf "$APP_PATH"
fi

mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources"

ICON_KEY=""
ICON_ICNS="$REPO_DIR/icon.icns"
ICON_PNG="$REPO_DIR/icon.png"
if [ -f "$ICON_ICNS" ]; then
  cp "$ICON_ICNS" "$APP_PATH/Contents/Resources/AppIcon.icns"
  ICON_KEY="<key>CFBundleIconFile</key><string>AppIcon</string>"
elif [ -f "$ICON_PNG" ]; then
  ICONSET_DIR="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$ICONSET_DIR"
  for spec in \
    "16 icon_16x16" \
    "32 icon_16x16@2x" \
    "32 icon_32x32" \
    "64 icon_32x32@2x" \
    "128 icon_128x128" \
    "256 icon_128x128@2x" \
    "256 icon_256x256" \
    "512 icon_256x256@2x" \
    "512 icon_512x512" \
    "1024 icon_512x512@2x"; do
    size="${spec%% *}"
    name="${spec#* }"
    sips -z "$size" "$size" "$ICON_PNG" --out "$ICONSET_DIR/${name}.png" >/dev/null
  done
  iconutil -c icns "$ICONSET_DIR" -o "$APP_PATH/Contents/Resources/AppIcon.icns"
  rm -rf "$(dirname "$ICONSET_DIR")"
  ICON_KEY="<key>CFBundleIconFile</key><string>AppIcon</string>"
fi

cat > "$APP_PATH/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  ${ICON_KEY}
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cat > "$APP_PATH/Contents/MacOS/${APP_NAME}" <<WRAPPER
#!/bin/sh
open -a Terminal "$SCRIPT"
WRAPPER

chmod +x "$APP_PATH/Contents/MacOS/${APP_NAME}"
touch "$APP_PATH"

echo "Installed $APP_PATH"
if [ -z "$ICON_KEY" ]; then
  echo "Tip: drop icon.icns (or icon.png, ideally 1024x1024) in the repo root and re-run to set an app icon."
fi
echo "Open it once from Finder (right-click → Open) to clear Gatekeeper, then drag it to the Dock."
