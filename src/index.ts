#!/usr/bin/env node

// Comet Browser MCP Server
// Claude Code ↔ Perplexity Comet bidirectional interaction
// Simplified to 6 essential tools

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cometClient } from "./cdp-client.js";
import { cometAI } from "./comet-ai.js";

const TOOLS: Tool[] = [
  {
    name: "comet_connect",
    description: "Connect to Comet browser (auto-starts if needed)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_ask",
    description: "Send a prompt to Comet/Perplexity and wait for the complete response (blocking). Ideal for tasks requiring real browser interaction (login walls, dynamic content, filling forms) or deep research with agentic browsing.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Question or task for Comet - focus on goals and context" },
        newChat: { type: "boolean", description: "Start a fresh conversation (default: false)" },
        timeout: { type: "number", description: "Max wait time in ms (default: 15000 = 15s)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "comet_poll",
    description: "Check agent status and progress. Call repeatedly to monitor agentic tasks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_stop",
    description: "Stop the current agent task if it's going off track",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_screenshot",
    description: "Capture a screenshot of current page",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_mode",
    description: "Switch Perplexity search mode. Modes: 'search' (basic), 'research' (deep research), 'labs' (create files/apps). Call without mode to see current mode.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["search", "research", "labs"],
          description: "Mode to switch to (optional - omit to see current mode)",
        },
      },
    },
  },
  {
    name: "comet_folders",
    description: "Manage research spaces in Perplexity. List existing spaces, create new ones, or save current research to a space.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "save"],
          description: "Action: 'list' spaces, 'create' new space, 'save' current research to space",
        },
        name: {
          type: "string",
          description: "Space name (required for 'create' and 'save' actions)",
        },
      },
    },
  },
  {
    name: "comet_library",
    description: "Search your Perplexity library for existing research. Returns past research threads matching your query.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find past research",
        },
      },
    },
  },
  {
    name: "comet_done",
    description: "Call when you're finished with the current research and won't need it anymore. Clears the research context and hides the app. Use after you've gathered all needed information and answered all follow-up questions.",
    inputSchema: {
      type: "object",
      properties: {
        save_to_folder: {
          type: "string",
          description: "Optional: folder name to save research before closing",
        },
      },
    },
  },
];

const server = new Server(
  { name: "comet-bridge", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "comet_connect": {
        // Auto-start MCP-dedicated Comet instance (separate from user's browser)
        const startResult = await cometClient.startComet();

        // Get all tabs and clean up - close all except one
        const targets = await cometClient.listTargets();
        const pageTabs = targets.filter(t => t.type === 'page');

        // Close extra tabs, keep only one
        if (pageTabs.length > 1) {
          for (let i = 1; i < pageTabs.length; i++) {
            try {
              await cometClient.closeTab(pageTabs[i].id);
            } catch { /* ignore */ }
          }
        }

        // Get fresh tab list
        const freshTargets = await cometClient.listTargets();
        const anyPage = freshTargets.find(t => t.type === 'page');

        let connectionMsg = startResult;

        if (anyPage) {
          await cometClient.connect(anyPage.id);
          // Always navigate to Perplexity home for clean state
          await cometClient.navigate("https://www.perplexity.ai/", true);
          await new Promise(resolve => setTimeout(resolve, 2000));
          connectionMsg += `\nConnected to Perplexity (cleaned ${pageTabs.length - 1} old tabs)`;
        } else {
          // No tabs at all - create a new one
          const newTab = await cometClient.newTab("https://www.perplexity.ai/");
          await new Promise(resolve => setTimeout(resolve, 2500)); // Wait for page load
          await cometClient.connect(newTab.id);
          connectionMsg += `\nCreated new tab and navigated to Perplexity`;
        }

        // Check login status for first-time setup
        const loginStatus = await cometAI.isLoggedIn();
        if (!loginStatus.loggedIn) {
          return {
            content: [{
              type: "text",
              text: connectionMsg + '\n\n⚠️ ' + loginStatus.message
            }]
          };
        }

        return { content: [{ type: "text", text: connectionMsg + '\n✓ Logged in and ready.' }] };
      }

      case "comet_ask": {
        let prompt = args?.prompt as string;
        const timeout = (args?.timeout as number) || 15000; // Default 15s, use poll for longer tasks
        const newChat = (args?.newChat as boolean) || false;

        // Validate prompt
        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }] };
        }

        // Normalize prompt - convert markdown/bullets to natural text
        prompt = prompt
          .replace(/^[-*•]\s*/gm, '')  // Remove bullet points
          .replace(/\n+/g, ' ')         // Collapse newlines to spaces
          .replace(/\s+/g, ' ')         // Collapse multiple spaces
          .trim();

        // For newChat: full reset (same as comet_connect) to handle post-agentic state
        if (newChat) {
          // Clean up extra tabs (fixes CDP state after agentic browsing)
          const targets = await cometClient.listTargets();
          const pageTabs = targets.filter(t => t.type === 'page');
          if (pageTabs.length > 1) {
            for (let i = 1; i < pageTabs.length; i++) {
              try { await cometClient.closeTab(pageTabs[i].id); } catch { /* ignore */ }
            }
          }

          // Fresh connect to remaining tab
          const freshTargets = await cometClient.listTargets();
          const mainTab = freshTargets.find(t => t.type === 'page');
          if (mainTab) {
            await cometClient.connect(mainTab.id);
          }

          // Navigate to Perplexity home
          await cometClient.navigate("https://www.perplexity.ai/", true);
          await new Promise(resolve => setTimeout(resolve, 1500));
        } else {
          // Not newChat - just ensure we're on Perplexity
          const tabs = await cometClient.listTabsCategorized();
          if (tabs.main) {
            await cometClient.connect(tabs.main.id);
          }

          const urlResult = await cometClient.evaluate('window.location.href');
          const currentUrl = urlResult.result.value as string;
          const isOnPerplexity = currentUrl?.includes('perplexity.ai');

          if (!isOnPerplexity) {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        // Capture old response state BEFORE sending prompt (for follow-up detection)
        const oldStateResult = await cometClient.evaluate(`
          (() => {
            const proseEls = document.querySelectorAll('[class*="prose"]');
            const lastProse = proseEls[proseEls.length - 1];
            return {
              count: proseEls.length,
              lastText: lastProse ? lastProse.innerText.substring(0, 100) : ''
            };
          })()
        `);
        const oldState = oldStateResult.result.value as { count: number; lastText: string };

        // Send the prompt
        await cometAI.sendPrompt(prompt);

        // Wait for completion
        const startTime = Date.now();
        const stepsCollected: string[] = [];
        let sawNewResponse = false;

        while (Date.now() - startTime < timeout) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2s

          // Check if we have a NEW response (more prose elements or different text)
          const currentStateResult = await cometClient.evaluate(`
            (() => {
              const proseEls = document.querySelectorAll('[class*="prose"]');
              const lastProse = proseEls[proseEls.length - 1];
              return {
                count: proseEls.length,
                lastText: lastProse ? lastProse.innerText.substring(0, 100) : ''
              };
            })()
          `);
          const currentState = currentStateResult.result.value as { count: number; lastText: string };

          // Detect new response
          if (!sawNewResponse) {
            if (currentState.count > oldState.count ||
                (currentState.lastText && currentState.lastText !== oldState.lastText)) {
              sawNewResponse = true;
            }
          }

          const status = await cometAI.getAgentStatus();

          // Collect steps
          for (const step of status.steps) {
            if (!stepsCollected.includes(step)) {
              stepsCollected.push(step);
            }
          }

          // Task completed - return result directly (but only if we saw a NEW response)
          if (status.status === 'completed' && sawNewResponse) {
            return { content: [{ type: "text", text: status.response || 'Task completed (no response text extracted)' }] };
          }
        }

        // Still working after initial wait - return "in progress" (non-blocking)
        const finalStatus = await cometAI.getAgentStatus();
        let inProgressMsg = `Task in progress (${stepsCollected.length} steps so far).\n`;
        inProgressMsg += `Status: ${finalStatus.status.toUpperCase()}\n`;
        if (finalStatus.currentStep) {
          inProgressMsg += `Current: ${finalStatus.currentStep}\n`;
        }
        if (finalStatus.agentBrowsingUrl) {
          inProgressMsg += `Browsing: ${finalStatus.agentBrowsingUrl}\n`;
        }
        if (stepsCollected.length > 0) {
          inProgressMsg += `\nSteps:\n${stepsCollected.map(s => `  • ${s}`).join('\n')}\n`;
        }
        inProgressMsg += `\nUse comet_poll to check progress or comet_stop to cancel.`;

        return { content: [{ type: "text", text: inProgressMsg }] };
      }

      case "comet_poll": {
        const status = await cometAI.getAgentStatus();

        // If completed, return the response directly (most useful case)
        if (status.status === 'completed' && status.response) {
          return { content: [{ type: "text", text: status.response }] };
        }

        // Still working - return progress info
        let output = `Status: ${status.status.toUpperCase()}\n`;

        if (status.agentBrowsingUrl) {
          output += `Browsing: ${status.agentBrowsingUrl}\n`;
        }

        if (status.currentStep) {
          output += `Current: ${status.currentStep}\n`;
        }

        if (status.steps.length > 0) {
          output += `\nSteps:\n${status.steps.map(s => `  • ${s}`).join('\n')}\n`;
        }

        if (status.status === 'working') {
          output += `\n[Use comet_stop to interrupt, or comet_screenshot to see current page]`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "comet_stop": {
        const stopped = await cometAI.stopAgent();
        return {
          content: [{
            type: "text",
            text: stopped ? "Agent stopped" : "No active agent to stop",
          }],
        };
      }

      case "comet_screenshot": {
        const result = await cometClient.screenshot("png");
        return {
          content: [{ type: "image", data: result.data, mimeType: "image/png" }],
        };
      }

      case "comet_mode": {
        const mode = args?.mode as string | undefined;

        // If no mode provided, show current mode
        if (!mode) {
          const result = await cometClient.evaluate(`
            (() => {
              // Try button group first (wide screen) - use new aria-labels
              const modeLabels = [
                { label: 'Search', key: 'search' },
                { label: 'Deep research', key: 'research' },
                { label: 'Create files and apps', key: 'labs' }
              ];
              for (const { label, key } of modeLabels) {
                const btn = document.querySelector('button[aria-label="' + label + '"]');
                if (btn && (btn.getAttribute('data-state') === 'checked' || btn.getAttribute('aria-checked') === 'true')) {
                  return key;
                }
              }
              // Try dropdown (narrow screen) - look for the mode selector button
              const dropdownBtn = document.querySelector('button[class*="gap"]');
              if (dropdownBtn) {
                const text = dropdownBtn.innerText.toLowerCase();
                if (text.includes('deep research')) return 'research';
                if (text.includes('create files')) return 'labs';
                if (text.includes('search')) return 'search';
              }
              return 'search';
            })()
          `);

          const currentMode = result.result.value as string;
          const descriptions: Record<string, string> = {
            search: 'Basic web search',
            research: 'Deep research with comprehensive analysis',
            labs: 'Create files, apps, and visualizations'
          };

          let output = `Current mode: ${currentMode}\n\nAvailable modes:\n`;
          for (const [m, desc] of Object.entries(descriptions)) {
            const marker = m === currentMode ? "→" : " ";
            output += `${marker} ${m}: ${desc}\n`;
          }

          return { content: [{ type: "text", text: output }] };
        }

        // Switch mode - use new Perplexity aria-labels
        const modeMap: Record<string, string> = {
          search: "Search",
          research: "Deep research",
          labs: "Create files and apps",
        };
        const ariaLabel = modeMap[mode];
        if (!ariaLabel) {
          return {
            content: [{ type: "text", text: `Invalid mode: ${mode}. Use: search, research, labs, learn` }],
            isError: true,
          };
        }

        // Navigate to Perplexity home page if not on a page with mode selector
        // Mode selector only exists on the home page, not on /spaces, /library, etc.
        const state = cometClient.currentState;
        const url = state.currentUrl || "";
        const needsNav = !url.includes("perplexity.ai") ||
          url.includes("/spaces") || url.includes("/library") ||
          url.includes("/discover") || url.includes("/finance");
        if (needsNav) {
          await cometClient.navigate("https://www.perplexity.ai/", true);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Try both UI patterns: button group (wide) and dropdown (narrow)
        const result = await cometClient.evaluate(`
          (() => {
            // Strategy 1: Direct button (wide screen)
            const btn = document.querySelector('button[aria-label="${ariaLabel}"]');
            if (btn) {
              btn.click();
              return { success: true, method: 'button' };
            }

            // Strategy 2: Dropdown menu (narrow screen)
            // Find and click the dropdown trigger (button with current mode text)
            const allButtons = document.querySelectorAll('button');
            for (const b of allButtons) {
              const text = b.innerText.toLowerCase();
              if ((text.includes('search') || text.includes('research') ||
                   text.includes('labs') || text.includes('learn')) &&
                  b.querySelector('svg')) {
                b.click();
                return { success: true, method: 'dropdown-open', needsSelect: true };
              }
            }

            return { success: false, error: "Mode selector not found" };
          })()
        `);

        const clickResult = result.result.value as { success: boolean; method?: string; needsSelect?: boolean; error?: string };

        if (clickResult.success && clickResult.needsSelect) {
          // Wait for dropdown to open, then select the mode
          await new Promise(resolve => setTimeout(resolve, 300));
          const selectResult = await cometClient.evaluate(`
            (() => {
              // Look for dropdown menu items
              const items = document.querySelectorAll('[role="menuitem"], [role="option"], button');
              for (const item of items) {
                if (item.innerText.toLowerCase().includes('${mode}')) {
                  item.click();
                  return { success: true };
                }
              }
              return { success: false, error: "Mode option not found in dropdown" };
            })()
          `);
          const selectRes = selectResult.result.value as { success: boolean; error?: string };
          if (selectRes.success) {
            return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
          } else {
            return { content: [{ type: "text", text: `Failed: ${selectRes.error}` }], isError: true };
          }
        }

        if (clickResult.success) {
          return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
        } else {
          return {
            content: [{ type: "text", text: `Failed to switch mode: ${clickResult.error}` }],
            isError: true,
          };
        }
      }

      case "comet_folders": {
        const action = (args?.action as string) || "list";
        const spaceName = args?.name as string;

        if (action === "list") {
          // Navigate to spaces page (folders are now called "Spaces" in Perplexity)
          await cometClient.navigate("https://www.perplexity.ai/spaces", true);
          await new Promise(resolve => setTimeout(resolve, 2000));

          const result = await cometClient.evaluate(`
            (() => {
              const spaces = [];
              // Look for space links in the UI
              const spaceEls = document.querySelectorAll('a[href*="/spaces/"]');
              for (const el of spaceEls) {
                const href = el.getAttribute('href') || '';
                // Skip navigation links like /spaces or /spaces/templates
                if (href === '/spaces' || href === '/spaces/templates' || !href.match(/\\/spaces\\/[a-zA-Z0-9-]+/)) {
                  continue;
                }
                const name = el.textContent?.trim()?.split(/\\d{1,2}\\s*(hr|min|sec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/)[0]?.trim();
                if (name && name.length > 0 && name.length < 100) {
                  spaces.push({ name, href });
                }
              }

              // Deduplicate
              const seen = new Set();
              return spaces.filter(s => {
                if (seen.has(s.name)) return false;
                seen.add(s.name);
                return true;
              });
            })()
          `);

          const spaces = result.result.value as { name: string; href: string }[];

          if (spaces.length === 0) {
            return { content: [{ type: "text", text: "No spaces found. Create one using comet_folders with action: 'create'" }] };
          }

          let output = `Found ${spaces.length} space(s):\n`;
          for (const space of spaces) {
            output += `  • ${space.name}\n`;
          }
          return { content: [{ type: "text", text: output }] };
        }

        if (action === "create") {
          if (!spaceName) {
            return { content: [{ type: "text", text: "Error: 'name' is required for create action" }], isError: true };
          }

          // Navigate to spaces page
          await cometClient.navigate("https://www.perplexity.ai/spaces", true);
          await new Promise(resolve => setTimeout(resolve, 2000));

          const result = await cometClient.evaluate(`
            (() => {
              // Look for "New Space" button (aria-label="New Space")
              const newSpaceBtn = document.querySelector('button[aria-label="New Space"]');
              if (newSpaceBtn) {
                newSpaceBtn.click();
                return { clicked: true };
              }

              // Fallback: look for button with text
              const createBtns = document.querySelectorAll('button');
              for (const btn of createBtns) {
                const text = btn.textContent?.toLowerCase() || '';
                if (text.includes('new space') || text.includes('create space')) {
                  btn.click();
                  return { clicked: true };
                }
              }

              return { clicked: false, error: 'New Space button not found' };
            })()
          `);

          const clickResult = result.result.value as { clicked: boolean; error?: string };

          if (!clickResult.clicked) {
            return { content: [{ type: "text", text: `Could not create space: ${clickResult.error}. Try creating it manually in Perplexity.` }], isError: true };
          }

          // Wait for dialog and enter space name
          await new Promise(resolve => setTimeout(resolve, 500));
          await cometClient.evaluate(`
            (() => {
              const input = document.querySelector('input[type="text"], input[placeholder*="space"], input[placeholder*="name"], input[placeholder*="Space"]');
              if (input) {
                input.value = '${spaceName.replace(/'/g, "\\'")}';
                input.dispatchEvent(new Event('input', { bubbles: true }));
              }
            })()
          `);

          // Click confirm/create button
          await new Promise(resolve => setTimeout(resolve, 300));
          await cometClient.evaluate(`
            (() => {
              const btns = document.querySelectorAll('button');
              for (const btn of btns) {
                const text = btn.textContent?.toLowerCase() || '';
                if (text.includes('create') || text.includes('save') || text.includes('confirm')) {
                  btn.click();
                  break;
                }
              }
            })()
          `);

          return { content: [{ type: "text", text: `Created space: ${spaceName}` }] };
        }

        if (action === "save") {
          if (!spaceName) {
            return { content: [{ type: "text", text: "Error: 'name' is required to specify which space to save to" }], isError: true };
          }

          // Try to save current thread to space via UI
          const result = await cometClient.evaluate(`
            (() => {
              // Look for save/bookmark/add to space button
              const btns = document.querySelectorAll('button');
              for (const btn of btns) {
                const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                const text = (btn.textContent || '').toLowerCase();
                if (label.includes('save') || label.includes('bookmark') || label.includes('add to') ||
                    text.includes('save') || text.includes('bookmark')) {
                  btn.click();
                  return { clicked: true };
                }
              }
              return { clicked: false, error: 'Save button not found' };
            })()
          `);

          const saveResult = result.result.value as { clicked: boolean; error?: string };

          if (!saveResult.clicked) {
            return { content: [{ type: "text", text: `Could not save: ${saveResult.error}` }], isError: true };
          }

          // Wait for space picker and select space
          await new Promise(resolve => setTimeout(resolve, 500));
          const selectResult = await cometClient.evaluate(`
            (() => {
              // Look for space in the picker
              const items = document.querySelectorAll('[role="menuitem"], [role="option"], button, a');
              for (const item of items) {
                if (item.textContent?.includes('${spaceName.replace(/'/g, "\\'")}')) {
                  item.click();
                  return { selected: true };
                }
              }
              return { selected: false, error: 'Space not found in picker' };
            })()
          `);

          const selectRes = selectResult.result.value as { selected: boolean; error?: string };

          if (selectRes.selected) {
            return { content: [{ type: "text", text: `Saved to space: ${spaceName}` }] };
          } else {
            return { content: [{ type: "text", text: `Could not select space: ${selectRes.error}` }], isError: true };
          }
        }

        return { content: [{ type: "text", text: `Unknown action: ${action}. Use 'list', 'create', or 'save'` }], isError: true };
      }

      case "comet_library": {
        const query = args?.query as string;

        // Navigate to library
        await cometClient.navigate("https://www.perplexity.ai/library", true);
        await new Promise(resolve => setTimeout(resolve, 2000));

        if (query) {
          // Try to find and use search input
          const searchResult = await cometClient.evaluate(`
            (() => {
              const searchInputs = document.querySelectorAll('input[type="search"], input[placeholder*="search"], input[placeholder*="Search"]');
              for (const input of searchInputs) {
                input.value = '${query.replace(/'/g, "\\'")}';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                return { searched: true };
              }
              return { searched: false };
            })()
          `);

          const searched = (searchResult.result.value as { searched: boolean }).searched;
          if (searched) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }

        // Extract library items
        const result = await cometClient.evaluate(`
          (() => {
            const items = [];
            // Look for thread/research items
            const threadEls = document.querySelectorAll('[data-testid*="thread"], [class*="thread"], a[href*="/search/"], a[href*="/thread/"]');

            for (const el of threadEls) {
              const title = el.querySelector('h2, h3, [class*="title"]')?.textContent?.trim() ||
                           el.textContent?.substring(0, 100).trim();
              const href = el.getAttribute('href') || el.querySelector('a')?.getAttribute('href') || '';

              if (title && title.length > 2) {
                items.push({
                  title: title.substring(0, 150),
                  url: href.startsWith('/') ? 'https://www.perplexity.ai' + href : href
                });
              }
            }

            // Also check for card-like elements
            const cards = document.querySelectorAll('[class*="card"], [class*="item"], article');
            for (const card of cards) {
              const link = card.querySelector('a');
              const title = card.querySelector('h2, h3, [class*="title"]')?.textContent?.trim();
              if (title && link) {
                const href = link.getAttribute('href') || '';
                items.push({
                  title: title.substring(0, 150),
                  url: href.startsWith('/') ? 'https://www.perplexity.ai' + href : href
                });
              }
            }

            // Deduplicate
            const seen = new Set();
            return items.filter(i => {
              const key = i.title;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }).slice(0, 20);
          })()
        `);

        const items = result.result.value as { title: string; url: string }[];

        if (items.length === 0) {
          return { content: [{ type: "text", text: query ? `No research found matching: "${query}"` : "No research found in library" }] };
        }

        let output = query ? `Found ${items.length} result(s) for "${query}":\n\n` : `Library contains ${items.length} item(s):\n\n`;
        for (const item of items) {
          output += `• ${item.title}\n`;
          if (item.url) output += `  ${item.url}\n`;
          output += '\n';
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "comet_done": {
        const saveToSpace = args?.save_to_folder as string | undefined;

        // Optional: save to space before closing
        if (saveToSpace) {
          try {
            // Click the save button and save to specified space
            await cometClient.evaluate(`
              (() => {
                // Look for save/bookmark button
                const saveBtn = document.querySelector('[aria-label*="save"], [aria-label*="Save"], button[class*="bookmark"], button[class*="save"]');
                if (saveBtn) saveBtn.click();
              })()
            `);
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Try to select space
            await cometClient.evaluate(`
              (() => {
                const spaceName = '${saveToSpace.replace(/'/g, "\\'")}';
                const spaceItems = document.querySelectorAll('[role="menuitem"], [class*="space"], button, a');
                for (const item of spaceItems) {
                  if (item.textContent?.includes(spaceName)) {
                    item.click();
                    return;
                  }
                }
              })()
            `);
            await new Promise(resolve => setTimeout(resolve, 500));
          } catch {
            // Continue even if save fails
          }
        }

        // Navigate to home to clear research context
        await cometClient.navigate("https://www.perplexity.ai/", true);
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Hide the app
        await cometClient.hideApp();

        const msg = saveToSpace
          ? `Research saved to "${saveToSpace}" and closed. Ready for next task.`
          : "Research closed. Ready for next task.";

        return { content: [{ type: "text", text: msg }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : error}` }],
      isError: true,
    };
  }
});

// CLI argument handling
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`comet-mcp v3.0.0

MCP server connecting Claude Code to Perplexity Comet browser.

Usage:
  Add to ~/.claude.json:
  {
    "mcpServers": {
      "comet": {
        "command": "npx",
        "args": ["-y", "comet-mcp"]
      }
    }
  }

Tools:
  comet_connect    Connect to MCP-dedicated Comet browser
  comet_ask        Send prompt and wait for response
  comet_poll       Check status of long-running tasks
  comet_stop       Stop current task
  comet_screenshot Capture current page
  comet_mode       Switch Perplexity mode (search/research/labs)
  comet_folders    Manage research spaces
  comet_library    Search existing research
  comet_done       Cleanup and close research session

More info: https://github.com/hanzili/comet-mcp`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log('comet-mcp v3.0.0');
  process.exit(0);
}

const transport = new StdioServerTransport();
server.connect(transport);
