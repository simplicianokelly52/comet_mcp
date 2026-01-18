---
name: comet-research
description: Deep web research using Perplexity Comet browser. Use when user asks for current events, research questions, technical investigation, competitive analysis, or needs up-to-date information with citations. Triggers on "research", "look up", "find out", "what's the latest", "current news".
---

# Comet Research Skill

Use the Comet MCP server to perform deep web research via Perplexity AI's agentic browser.

## Available Tools

| Tool | Purpose |
|------|---------|
| `comet_connect` | Connect to MCP-dedicated Comet browser (port 9223) |
| `comet_ask` | Send research query and get response |
| `comet_poll` | Check status of long-running research tasks |
| `comet_stop` | Stop current task if going off-track |
| `comet_mode` | Switch Perplexity mode (search/research/labs) |
| `comet_folders` | Manage research spaces (list/create/save) |
| `comet_library` | Search past research in Perplexity library |
| `comet_screenshot` | Capture current page state |

## Quick Start

### Simple Query (< 15 seconds)
```
comet_connect
comet_ask(prompt="What is [topic]?")
```

### Deep Research (may take minutes)
```
comet_connect
comet_mode(mode="research")
comet_ask(prompt="Comprehensive analysis of [topic]", timeout=30000)
# If still processing, poll for completion
comet_poll()
```

## Mode Selection Guide

Choose the appropriate mode based on the task:

| Mode | Use Case | Speed |
|------|----------|-------|
| **search** | Quick facts, definitions, simple questions | Fast (5-15s) |
| **research** | In-depth analysis, multiple sources, citations | Slow (30s-5min) |
| **labs** | Create files, apps, and visualizations | Medium |

## Research Workflow

### Step 1: Connect
Always start by connecting:
```
comet_connect
```

### Step 2: Check/Set Mode
For complex research, switch to research mode:
```
comet_mode(mode="research")
```

### Step 3: Send Query
```
comet_ask(
  prompt="Your detailed research question here",
  timeout=30000,
  newChat=true
)
```

### Step 4: Handle Long Tasks
If the response indicates the task is still running:
```
comet_poll()
```

### Step 5: Save Important Research
```
comet_folders(action="save", name="My Research Space")
```

## Best Practices

1. **Always connect first** before any operation
2. **Use `newChat: true`** when switching to unrelated topics
3. **Use research mode** for comprehensive analysis
4. **Poll for long tasks** instead of long timeouts
5. **Cite sources** from the response in your answer
6. **Save valuable research** to spaces for future reference

## Error Handling

| Issue | Solution |
|-------|----------|
| Connection fails | Wait 5s, retry `comet_connect` |
| Stale response | `comet_ask(prompt="...", newChat=true)` |
| Task stuck | `comet_stop()` then retry with simpler query |

## Response Formatting

When presenting research results:

1. Summarize key findings in bullet points
2. Include citations with source names
3. Note confidence level based on source quality
4. Highlight contradictions if sources disagree
