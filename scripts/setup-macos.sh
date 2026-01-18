#!/bin/bash
#
# Comet MCP - macOS Setup Script
# Creates isolated MCP Comet app with custom icon
#

set -e

echo "╔════════════════════════════════════════════╗"
echo "║     Comet MCP - macOS Setup                ║"
echo "╚════════════════════════════════════════════╝"
echo ""

# Check if Comet is installed
if [ ! -d "/Applications/Comet.app" ]; then
  echo "✗ Error: Comet.app not found in /Applications"
  echo ""
  echo "Please install Comet first:"
  echo "  https://www.perplexity.ai/comet"
  exit 1
fi

MCP_APP="$HOME/.comet-mcp/Comet-MCP.app"

# Create directory
echo "[1/6] Creating ~/.comet-mcp directory..."
mkdir -p "$HOME/.comet-mcp"

# Copy app
echo "[2/6] Copying Comet.app to Comet-MCP.app..."
if [ -d "$MCP_APP" ]; then
  echo "      (Removing existing installation)"
  rm -rf "$MCP_APP"
fi
cp -R "/Applications/Comet.app" "$MCP_APP"

# Change bundle ID
echo "[3/6] Setting unique bundle ID..."
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ai.perplexity.comet.mcp" \
  "$MCP_APP/Contents/Info.plist"

# Download and apply icon
echo "[4/6] Downloading custom MCP icon..."
ICON_URL="https://raw.githubusercontent.com/hanzili/comet-mcp/main/assets/icon.icns"
ICON_TMP="/tmp/comet-mcp-icon.icns"

if curl -sL "$ICON_URL" -o "$ICON_TMP" 2>/dev/null; then
  # Verify it's a valid icns (starts with 'icns' magic bytes)
  if head -c 4 "$ICON_TMP" 2>/dev/null | grep -q "icns"; then
    cp "$ICON_TMP" "$MCP_APP/Contents/Resources/app.icns"
    cp "$ICON_TMP" "$MCP_APP/Contents/Resources/electron.icns"
    echo "      ✓ Icon files installed"
  else
    echo "      (Using default icon)"
  fi
  rm -f "$ICON_TMP"
fi

# Re-sign
echo "[5/6] Re-signing app..."
codesign --force --deep --sign - "$MCP_APP" 2>/dev/null

# Set custom icon using AppleScript (most reliable method)
echo "[6/6] Setting app icon..."
osascript << EOF 2>/dev/null || true
use framework "Foundation"
use framework "AppKit"
set iconPath to "$MCP_APP/Contents/Resources/app.icns"
set appPath to "$MCP_APP"
set iconImage to current application's NSImage's alloc()'s initWithContentsOfFile:iconPath
current application's NSWorkspace's sharedWorkspace()'s setIcon:iconImage forFile:appPath options:0
EOF

# Clear icon cache (macOS caches icons aggressively)
echo "      Clearing icon cache..."
rm -f "$MCP_APP/Contents/Resources/.DS_Store" 2>/dev/null || true
touch "$MCP_APP"
touch "$MCP_APP/Contents/Info.plist"
sudo rm -rf /Library/Caches/com.apple.iconservices.store 2>/dev/null || true
rm -rf ~/Library/Caches/com.apple.iconservices.store 2>/dev/null || true

# Refresh Finder and Dock
killall Finder 2>/dev/null || true
killall Dock 2>/dev/null || true

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║     ✓ Setup Complete!                      ║"
echo "╚════════════════════════════════════════════╝"
echo ""
echo "Installed: $MCP_APP"
echo ""
echo "Next steps:"
echo "  1. Restart Claude Code"
echo "  2. Say: 'Connect to Comet'"
echo "  3. Login to Perplexity (first time only)"
echo ""
