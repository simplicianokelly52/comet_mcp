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
echo "[1/5] Creating ~/.comet-mcp directory..."
mkdir -p "$HOME/.comet-mcp"

# Copy app
echo "[2/5] Copying Comet.app to Comet-MCP.app..."
if [ -d "$MCP_APP" ]; then
  echo "      (Removing existing installation)"
  rm -rf "$MCP_APP"
fi
cp -R "/Applications/Comet.app" "$MCP_APP"

# Change bundle ID
echo "[3/5] Setting unique bundle ID..."
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ai.perplexity.comet.mcp" \
  "$MCP_APP/Contents/Info.plist"

# Download icon
echo "[4/5] Downloading custom MCP icon..."
ICON_URL="https://raw.githubusercontent.com/hanzili/comet-mcp/main/assets/comet-mcp.icns"
ICON_PATH="$MCP_APP/Contents/Resources/app.icns"

# Try to download, check if valid (icns files start with "icns")
if curl -sL "$ICON_URL" -o /tmp/comet-mcp-icon.icns 2>/dev/null; then
  if head -c 4 /tmp/comet-mcp-icon.icns | grep -q "icns"; then
    cp /tmp/comet-mcp-icon.icns "$ICON_PATH"
    cp /tmp/comet-mcp-icon.icns "$MCP_APP/Contents/Resources/electron.icns"
    echo "      ✓ Custom icon installed"
  else
    echo "      (Using default icon - download failed)"
  fi
  rm -f /tmp/comet-mcp-icon.icns
else
  echo "      (Using default icon - network error)"
fi

# Re-sign
echo "[5/5] Re-signing app..."
codesign --force --deep --sign - "$MCP_APP" 2>/dev/null

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
