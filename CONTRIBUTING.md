# Contributing

Thanks for your interest in contributing to comet-mcp!

## How to Contribute

1. **Open an issue first** - Describe the bug or feature you want to work on
2. **Discuss** - Wait for feedback before starting work
3. **Submit a PR** - Reference the issue in your PR

PRs without a related issue may be closed.

## Development

```bash
git clone https://github.com/hanzili/comet-mcp.git
cd comet-mcp
npm install
npm run build
```

To test your changes, point Claude Code to your local build:

```json
{
  "mcpServers": {
    "comet": {
      "command": "node",
      "args": ["/path/to/comet-mcp/dist/index.js"]
    }
  }
}
```

## Testing

Manual testing against Perplexity's Comet browser. See README for setup.
