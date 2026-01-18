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
    description: "Switch Perplexity search mode. Modes: 'search' (basic), 'research' (deep research), 'labs' (analytics/visualization), 'learn' (educational). Call without mode to see current mode.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["search", "research", "labs", "learn"],
          description: "Mode to switch to (optional - omit to see current mode)",
        },
      },
    },
  },
  {
    name: "comet_folders",
    description: "Manage research folders in Perplexity. List existing folders, create new ones, or save current research to a folder.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "save"],
          description: "Action: 'list' folders, 'create' new folder, 'save' current research to folder",
        },
        name: {
          type: "string",
          description: "Folder name (required for 'create' and 'save' actions)",
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
            // Minimize window after successful response
            await cometClient.hideApp();
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
          // Minimize window after successful response
          await cometClient.hideApp();
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
              // Try button group first (wide screen)
              const modes = ['Search', 'Research', 'Labs', 'Learn'];
              for (const mode of modes) {
                const btn = document.querySelector('button[aria-label="' + mode + '"]');
                if (btn && btn.getAttribute('data-state') === 'checked') {
                  return mode.toLowerCase();
                }
              }
              // Try dropdown (narrow screen) - look for the mode selector button
              const dropdownBtn = document.querySelector('button[class*="gap"]');
              if (dropdownBtn) {
                const text = dropdownBtn.innerText.toLowerCase();
                if (text.includes('search')) return 'search';
                if (text.includes('research')) return 'research';
                if (text.includes('labs')) return 'labs';
                if (text.includes('learn')) return 'learn';
              }
              return 'search';
            })()
          `);

          const currentMode = result.result.value as string;
          const descriptions: Record<string, string> = {
            search: 'Basic web search',
            research: 'Deep research with comprehensive analysis',
            labs: 'Analytics, visualizations, and coding',
            learn: 'Educational content and explanations'
          };

          let output = `Current mode: ${currentMode}\n\nAvailable modes:\n`;
          for (const [m, desc] of Object.entries(descriptions)) {
            const marker = m === currentMode ? "→" : " ";
            output += `${marker} ${m}: ${desc}\n`;
          }

          return { content: [{ type: "text", text: output }] };
        }

        // Switch mode
        const modeMap: Record<string, string> = {
          search: "Search",
          research: "Research",
          labs: "Labs",
          learn: "Learn",
        };
        const ariaLabel = modeMap[mode];
        if (!ariaLabel) {
          return {
            content: [{ type: "text", text: `Invalid mode: ${mode}. Use: search, research, labs, learn` }],
            isError: true,
          };
        }

        // Navigate to Perplexity first if not there
        const state = cometClient.currentState;
        if (!state.currentUrl?.includes("perplexity.ai")) {
          await cometClient.navigate("https://www.perplexity.ai/", true);
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
        const folderName = args?.name as string;

        if (action === "list") {
          // Navigate to library and extract folders
          await cometClient.navigate("https://www.perplexity.ai/library", true);
          await new Promise(resolve => setTimeout(resolve, 2000));

          const result = await cometClient.evaluate(`
            (() => {
              const folders = [];
              // Look for folder elements in the library sidebar/UI
              const folderEls = document.querySelectorAll('[data-testid*="folder"], [class*="folder"], a[href*="/collection/"]');
              for (const el of folderEls) {
                const name = el.textContent?.trim();
                const href = el.getAttribute('href') || '';
                if (name && name.length > 0 && name.length < 100) {
                  folders.push({ name, href });
                }
              }

              // Also check sidebar navigation
              const sidebarLinks = document.querySelectorAll('nav a, aside a');
              for (const link of sidebarLinks) {
                const text = link.textContent?.trim();
                const href = link.getAttribute('href') || '';
                if (href.includes('/collection/') && text) {
                  folders.push({ name: text, href });
                }
              }

              // Deduplicate
              const seen = new Set();
              return folders.filter(f => {
                if (seen.has(f.name)) return false;
                seen.add(f.name);
                return true;
              });
            })()
          `);

          const folders = result.result.value as { name: string; href: string }[];

          if (folders.length === 0) {
            return { content: [{ type: "text", text: "No folders found. Create one using comet_folders with action: 'create'" }] };
          }

          let output = `Found ${folders.length} folder(s):\n`;
          for (const folder of folders) {
            output += `  • ${folder.name}\n`;
          }
          return { content: [{ type: "text", text: output }] };
        }

        if (action === "create") {
          if (!folderName) {
            return { content: [{ type: "text", text: "Error: 'name' is required for create action" }], isError: true };
          }

          // Navigate to library and create folder
          await cometClient.navigate("https://www.perplexity.ai/library", true);
          await new Promise(resolve => setTimeout(resolve, 2000));

          const result = await cometClient.evaluate(`
            (() => {
              // Look for "New folder" or "Create folder" button
              const createBtns = document.querySelectorAll('button');
              for (const btn of createBtns) {
                const text = btn.textContent?.toLowerCase() || '';
                if (text.includes('new folder') || text.includes('create folder') || text.includes('add folder')) {
                  btn.click();
                  return { clicked: true };
                }
              }

              // Try the + button
              for (const btn of createBtns) {
                if (btn.querySelector('svg') && btn.getAttribute('aria-label')?.toLowerCase().includes('add')) {
                  btn.click();
                  return { clicked: true };
                }
              }

              return { clicked: false, error: 'Create folder button not found' };
            })()
          `);

          const clickResult = result.result.value as { clicked: boolean; error?: string };

          if (!clickResult.clicked) {
            return { content: [{ type: "text", text: `Could not create folder: ${clickResult.error}. Try creating it manually in Perplexity.` }], isError: true };
          }

          // Wait for dialog and enter folder name
          await new Promise(resolve => setTimeout(resolve, 500));
          await cometClient.evaluate(`
            (() => {
              const input = document.querySelector('input[type="text"], input[placeholder*="folder"], input[placeholder*="name"]');
              if (input) {
                input.value = '${folderName.replace(/'/g, "\\'")}';
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

          return { content: [{ type: "text", text: `Created folder: ${folderName}` }] };
        }

        if (action === "save") {
          if (!folderName) {
            return { content: [{ type: "text", text: "Error: 'name' is required to specify which folder to save to" }], isError: true };
          }

          // Try to save current thread to folder via UI
          const result = await cometClient.evaluate(`
            (() => {
              // Look for save/bookmark/add to folder button
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

          // Wait for folder picker and select folder
          await new Promise(resolve => setTimeout(resolve, 500));
          const selectResult = await cometClient.evaluate(`
            (() => {
              // Look for folder in the picker
              const items = document.querySelectorAll('[role="menuitem"], [role="option"], button, a');
              for (const item of items) {
                if (item.textContent?.includes('${folderName.replace(/'/g, "\\'")}')) {
                  item.click();
                  return { selected: true };
                }
              }
              return { selected: false, error: 'Folder not found in picker' };
            })()
          `);

          const selectRes = selectResult.result.value as { selected: boolean; error?: string };

          if (selectRes.selected) {
            return { content: [{ type: "text", text: `Saved to folder: ${folderName}` }] };
          } else {
            return { content: [{ type: "text", text: `Could not select folder: ${selectRes.error}` }], isError: true };
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

const transport = new StdioServerTransport();
server.connect(transport);
