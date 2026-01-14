# comet-mcp

[![npm version](https://img.shields.io/npm/v/comet-mcp.svg)](https://www.npmjs.com/package/comet-mcp)

<a href="https://glama.ai/mcp/servers/@hanzili/comet-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@hanzili/comet-mcp/badge" />
</a>

**Give Claude Code a browser that thinks.**

An MCP server that connects Claude Code to [Perplexity Comet](https://www.perplexity.ai/comet) - enabling agentic web browsing, deep research, and real-time task monitoring.

![Demo](demo.gif)

## What's New in v3.0

- **Isolated MCP Instance** - Uses a dedicated Comet browser (port 9223) - your personal tabs are never touched
- **Full Research Text** - Fixed truncation issue, now returns complete research responses
- **Reliable Startup** - Auto-retry logic, kills stale processes, extended timeouts
- **Login Detection** - First-time setup prompts for Perplexity sign-in
- **Visual Indicator** - MCP Comet shows "[MCP]" badge so you know which browser is which
- **Research Folders** - Save and organize research into folders
- **Library Search** - Search your existing Perplexity research history

## Why?

Existing web tools for Claude Code fall into two categories, both with limitations:

### 1. Search APIs (Tavily, Perplexity API, WebFetch)
Return static text. No interaction, no login, no dynamic content. Great for quick lookups, but can't navigate complex sites or fill forms.

### 2. Browser Automation (browser-use, Puppeteer MCP, Playwright MCP)
Can interact with pages, but use a **one-agent-do-all** approach: the same reasoning model that's writing your code is also deciding where to click, what to type, and how to navigate. This overwhelms the context window and fragments focus.

### 3. Comet MCP: Multi-Agent Delegation
**Comet MCP takes a different approach.** Instead of Claude controlling a browser directly, it delegates to [Perplexity Comet](https://www.perplexity.ai/comet) - an AI purpose-built for web research and browsing.

- **Claude** stays focused on your coding task
- **Comet** handles the browsing: navigation, login walls, dynamic content, deep research
- **Result**: Claude's coding intelligence + Perplexity's web intelligence, working together

## Quick Start

### 1. Configure Claude Code

Add to `~/.claude.json` or `.mcp.json`:

```json
{
  "mcpServers": {
    "comet-bridge": {
      "command": "npx",
      "args": ["-y", "comet-mcp"]
    }
  }
}
```

### 2. Install Comet Browser

Download and install [Perplexity Comet](https://www.perplexity.ai/comet).

### macOS: Create Isolated App Bundle (One-time)

On macOS, create a separate app bundle to run MCP Comet alongside your personal Comet:

```bash
# Create the MCP-specific Comet app
MCP_APP="$HOME/.comet-mcp/Comet-MCP.app"
mkdir -p "$HOME/.comet-mcp"
cp -R "/Applications/Comet.app" "$MCP_APP"

# Change bundle ID to make it a "different" app
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ai.perplexity.comet.mcp" "$MCP_APP/Contents/Info.plist"

# Re-sign (required after modifying the app)
find "$MCP_APP" -name "*.dylib" -exec codesign --force --sign - {} \;
find "$MCP_APP" -name "*.so" -exec codesign --force --sign - {} \;
find "$MCP_APP" -type d -name "*.framework" | while read -r fw; do
  codesign --force --sign - "$fw"
done
codesign --force --deep --sign - "$MCP_APP"
```

This creates `~/.comet-mcp/Comet-MCP.app` with a different bundle ID, allowing it to run truly separately from your personal Comet.

That's it! The MCP server automatically launches the dedicated Comet instance for MCP use.

### 3. First-Time Setup

On first `comet_connect`, if not logged in:
1. The MCP Comet browser window will open
2. Log into your Perplexity account
3. Call `comet_connect` again - you're ready!

### 4. Use in Claude Code

```
You: "Use Comet to research the top AI frameworks in 2025"
Claude: [delegates to Comet, monitors progress, returns results]

You: "Log into my GitHub and check my notifications"
Claude: [Comet handles the login flow and navigation]

You: "Save this research to my 'AI Projects' folder"
Claude: [uses comet_folders to organize research]
```

## Tools

| Tool | Description |
|------|-------------|
| `comet_connect` | Connect to MCP-dedicated Comet (auto-starts, isolated from personal browser) |
| `comet_ask` | Send a task and wait for response |
| `comet_poll` | Check progress on long-running tasks |
| `comet_stop` | Stop current task |
| `comet_screenshot` | Capture current page |
| `comet_mode` | Switch modes: search, research, labs, learn |
| `comet_folders` | List, create, or save to research folders |
| `comet_library` | Search your existing Perplexity research |

## How It Works

```
Claude Code  →  MCP Server  →  CDP (port 9223)  →  MCP Comet  →  Perplexity AI
   (reasoning)     (bridge)                         (isolated)    (web browsing)
```

- **Port 9223**: MCP uses its own port, never touches your personal Comet (9222)
- **Separate Profile**: Data stored in `~/.comet-mcp`, completely isolated
- **Visual Badge**: MCP Comet shows "[MCP]" indicator so you know which is which

Claude sends high-level goals ("research X", "log into Y"). Comet figures out the clicks, scrolls, and searches. Results flow back to Claude.

## Requirements

- Node.js 18+
- [Perplexity Comet Browser](https://www.perplexity.ai/comet)
- Claude Code (or any MCP client)
- **Supported platforms**: macOS, Windows, WSL2

## Windows & WSL Support

### Native Windows
Works out of the box. Comet MCP auto-detects Windows and launches Comet from its default install location.

### WSL2 (Windows Subsystem for Linux)
WSL2 requires **mirrored networking** to connect to Comet running on Windows:

1. **Enable mirrored networking** (one-time setup):
   ```
   # Create/edit %USERPROFILE%\.wslconfig (Windows side)
   [wsl2]
   networkingMode=mirrored
   ```

2. **Restart WSL**:
   ```bash
   wsl --shutdown
   # Then reopen your WSL terminal
   ```

3. **That's it!** Comet MCP auto-detects WSL and uses PowerShell to communicate with Windows.

If mirrored networking isn't available, you'll see a helpful error message with setup instructions.

### Custom Comet Path
If Comet is installed in a non-standard location:
```json
{
  "mcpServers": {
    "comet-bridge": {
      "command": "npx",
      "args": ["-y", "comet-mcp"],
      "env": {
        "COMET_PATH": "/path/to/your/Comet"
      }
    }
  }
}
```

## Troubleshooting

**"Cannot connect to Comet"**
- **macOS**: Ensure Comet is installed at `/Applications/Comet.app` and you've run the one-time setup to create `~/.comet-mcp/Comet-MCP.app`
- **Windows**: Comet should be in `%LOCALAPPDATA%\Perplexity\Comet\Application\`
- MCP uses port 9223 (not 9222) - check if available

**"MCP Comet closes my personal Comet" (macOS)**
- You need to create the separate app bundle first (see "macOS: Create Isolated App Bundle" above)
- Without this, Electron's single-instance lock will replace your personal browser

**"Not logged in" message**
- Log into Perplexity in the MCP Comet browser window (the one with [MCP] badge)
- Then call `comet_connect` again

**"WSL cannot connect to Windows localhost"**
- Enable mirrored networking (see WSL section above)
- Or run Claude Code from Windows PowerShell instead of WSL

**"Tools not showing in Claude"**
- Restart Claude Code after config changes

**"Research text is truncated"**
- Upgrade to v3.0.0 - this issue is fixed
- Use `comet_poll` for long research to get full results

## License

MIT

---

[Report Issues](https://github.com/hanzili/comet-mcp/issues) · [Contribute](https://github.com/hanzili/comet-mcp)
