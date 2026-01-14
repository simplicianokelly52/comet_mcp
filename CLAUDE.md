# CLAUDE.md

## What This Is
MCP server connecting Claude Code to Perplexity's Comet browser via Chrome DevTools Protocol (CDP).

**v3.0.0**: Now uses a DEDICATED MCP Comet instance (port 9223) - your personal browser tabs are never touched.

## Architecture
```
Claude Code → MCP Server (index.ts) → CometAI (comet-ai.ts) → CDP Client (cdp-client.ts) → MCP Comet Browser
                                                                                              ↓
                                                                                    Port 9223 (isolated)
                                                                                    Data: ~/.comet-mcp
```

## 8 Tools
- `comet_connect` - Start/connect to MCP-dedicated Comet (separate from personal browser)
- `comet_ask` - Send prompt, wait for response (15s default, use poll for longer)
- `comet_poll` - Check status of long-running tasks
- `comet_stop` - Stop current task
- `comet_screenshot` - Capture current page
- `comet_mode` - Switch Perplexity modes (search/research/labs/learn)
- `comet_folders` - Manage research folders (list/create/save)
- `comet_library` - Search existing research in Perplexity library

## Key Implementation Details

**Isolated MCP Instance (NEW in v3.0)**:
- Uses port 9223 (not 9222) to avoid conflicts with personal Comet
- Separate data directory: `~/.comet-mcp` (macOS/Linux) or `%LOCALAPPDATA%\comet-mcp` (Windows)
- Visual indicator: "[MCP]" in title + badge on page
- First launch prompts for Perplexity login

**Response extraction** (`comet-ai.ts:getAgentStatus`):
- Collects ALL prose elements (not just last) - fixes text truncation
- Scrolls to load lazy content before extraction
- 50KB response limit (up from 8KB)
- Filters UI text (Library, Discover, etc.) and questions

**Follow-up detection** (`index.ts`):
- Captures old prose count/text before sending
- Waits for NEW response (different text or more elements)

**Startup reliability**:
- 3 retry attempts on failure
- Kills stale processes before starting
- Extended timeout (30s) for slow startups

**Login detection**:
- Checks for logged-in indicators on connect
- Returns instructions if not logged in

## Build & Test
```bash
npm run build
pgrep -f "node.*comet-mcp" | xargs kill  # Restart MCP
```

Manual testing only (integration code, external DOM dependency).

## Test Cases
1. **Quick queries** - Simple questions should return within 15s
2. **Full text** - Research mode returns complete text (not truncated)
3. **Isolated instance** - Personal Comet tabs unaffected
4. **First login** - Fresh install prompts for Perplexity sign-in
5. **Agentic task** - "Take control of browser" triggers browsing
6. **Mode switching** - `comet_mode` changes search/research/labs/learn
7. **Folders** - `comet_folders` lists/creates/saves to folders
8. **Library search** - `comet_library` finds past research

## Known Edge Cases
- **Prompt not submitted**: If response shows 0 steps + COMPLETED, retry or use newChat
- **Stale poll response**: If poll returns unrelated response, send prompt again
- **Research mode**: Takes longer than search, may need multiple polls
- **Folder UI changes**: Perplexity may update UI, folder operations may need adjustment
