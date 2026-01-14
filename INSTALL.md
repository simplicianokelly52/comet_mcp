# Comet MCP Installation

## Quick Install (3 Steps)

### Step 1: Install Comet Browser
Download from: https://www.perplexity.ai/comet

### Step 2: Add to Claude Code
Add this to `~/.claude.json`:
```json
{
  "mcpServers": {
    "comet": {
      "command": "npx",
      "args": ["-y", "comet-mcp"]
    }
  }
}
```

### Step 3: macOS Only - Run Setup Script
```bash
curl -sL https://raw.githubusercontent.com/hanzili/comet-mcp/main/scripts/setup-macos.sh | bash
```

Or manually:
```bash
# Create MCP Comet app (separate from personal Comet)
MCP_APP="$HOME/.comet-mcp/Comet-MCP.app"
mkdir -p "$HOME/.comet-mcp"
cp -R "/Applications/Comet.app" "$MCP_APP"

# Change bundle ID
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ai.perplexity.comet.mcp" \
  "$MCP_APP/Contents/Info.plist"

# Download custom icon
curl -sL "https://raw.githubusercontent.com/hanzili/comet-mcp/main/assets/comet-mcp.icns" \
  -o "$MCP_APP/Contents/Resources/app.icns"
cp "$MCP_APP/Contents/Resources/app.icns" "$MCP_APP/Contents/Resources/electron.icns"

# Re-sign app
codesign --force --deep --sign - "$MCP_APP"

echo "✓ MCP Comet installed at $MCP_APP"
```

### Step 4: First Use
1. Restart Claude Code
2. Say: "Connect to Comet"
3. Login to Perplexity in the MCP browser window (first time only)
4. Done! Ask Claude to research anything

---

## How It Works

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Claude Code │ ──► │  MCP Server │ ──► │ MCP Comet   │
│  (you talk  │     │  (bridge)   │     │ (separate   │
│   to this)  │     │  port 9223  │     │  browser)   │
└─────────────┘     └─────────────┘     └─────────────┘
                                              │
                                              ▼
                                        ┌─────────────┐
                                        │ Perplexity  │
                                        │     AI      │
                                        └─────────────┘
```

- **Personal Comet** = Your normal browser (untouched)
- **MCP Comet** = Separate browser for Claude (different icon)

---

## Available Commands

| What to say to Claude | What happens |
|-----------------------|--------------|
| "Connect to Comet" | Starts MCP browser |
| "Research [topic]" | Deep research with sources |
| "Search for [query]" | Quick search |
| "Take a screenshot" | Captures current page |
| "Show my library" | Lists past research |

---

## Troubleshooting

**"Cannot connect"**
→ Run the macOS setup script (Step 3)

**"Closes my personal Comet"**  
→ You need the separate MCP app bundle. Run Step 3.

**"Not logged in"**
→ Login in the MCP Comet window (has [MCP] badge), then reconnect

**Windows/WSL**
→ No setup script needed, just Steps 1-2
