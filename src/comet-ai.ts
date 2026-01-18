// Comet AI interaction module
// Handles sending prompts to Comet's AI assistant and reading responses

import { cometClient } from "./cdp-client.js";

// Input selectors - contenteditable div is primary for Perplexity
const INPUT_SELECTORS = [
  '[contenteditable="true"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Search"]',
  'textarea',
  'input[type="text"]',
];

export class CometAI {
  /**
   * Find the first matching element from a list of selectors
   */
  private async findInputElement(): Promise<string | null> {
    for (const selector of INPUT_SELECTORS) {
      const result = await cometClient.evaluate(`
        document.querySelector(${JSON.stringify(selector)}) !== null
      `);
      if (result.result.value === true) {
        return selector;
      }
    }
    return null;
  }

  /**
   * Send a prompt to Comet's AI (Perplexity)
   */
  async sendPrompt(prompt: string): Promise<string> {
    const inputSelector = await this.findInputElement();

    if (!inputSelector) {
      throw new Error("Could not find input element. Navigate to Perplexity first.");
    }

    // Focus the input element
    const focused = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el) {
          el.focus();
          // Clear existing content
          el.innerHTML = '';
          return { type: 'contenteditable' };
        }
        const textarea = document.querySelector('textarea');
        if (textarea) {
          textarea.focus();
          textarea.value = '';
          return { type: 'textarea' };
        }
        return null;
      })()
    `);

    if (!focused.result.value) {
      throw new Error("Failed to focus input element");
    }

    // Use CDP Input.insertText for reliable text insertion
    await cometClient.insertText(prompt);

    // Submit the prompt
    await this.submitPrompt();

    return `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`;
  }

  /**
   * Submit the current prompt
   */
  private async submitPrompt(): Promise<void> {
    // Wait for React to process the typed content
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify text was typed before attempting submit
    const hasContent = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length > 0) return true;
        const textarea = document.querySelector('textarea');
        if (textarea && textarea.value.trim().length > 0) return true;
        return false;
      })()
    `);

    if (!hasContent.result.value) {
      throw new Error("Prompt text not found in input - typing may have failed");
    }

    // Strategy 1: Use Enter key (most reliable for Perplexity)
    await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]') ||
                   document.querySelector('textarea');
        if (el) el.focus();
      })()
    `);
    await cometClient.pressKey("Enter");
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check if submission worked
    const submitted = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length < 5) return true;
        const hasLoading = document.querySelector('[class*="animate"]') !== null;
        return hasLoading;
      })()
    `);
    if (submitted.result.value) return;

    // Strategy 2: Click submit button
    await cometClient.evaluate(`
      (() => {
        const selectors = [
          'button[aria-label*="Submit"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="Ask"]',
          'button[type="submit"]',
        ];

        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled && btn.offsetParent !== null) {
            btn.click();
            return true;
          }
        }

        // Find rightmost button with SVG near input
        const inputEl = document.querySelector('[contenteditable="true"]') ||
                        document.querySelector('textarea');
        if (inputEl) {
          const inputRect = inputEl.getBoundingClientRect();
          let parent = inputEl.parentElement;
          let candidates = [];

          for (let i = 0; i < 4 && parent; i++) {
            const btns = parent.querySelectorAll('button:not([disabled])');
            for (const btn of btns) {
              const btnRect = btn.getBoundingClientRect();
              const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

              // Skip mode/attach/voice buttons (updated for new Perplexity UI)
              if (ariaLabel.includes('search') || ariaLabel.includes('deep research') ||
                  ariaLabel.includes('create files') || ariaLabel.includes('attach') ||
                  ariaLabel.includes('voice') || ariaLabel.includes('dictation')) {
                continue;
              }

              if (btn.querySelector('svg') && btn.offsetParent !== null &&
                  btnRect.left > inputRect.left && btnRect.width > 0) {
                candidates.push({ btn, right: btnRect.right });
              }
            }
            parent = parent.parentElement;
          }

          if (candidates.length > 0) {
            candidates.sort((a, b) => b.right - a.right);
            candidates[0].btn.click();
          }
        }
      })()
    `);

    // Final check and retry with Enter if still not submitted
    await new Promise(resolve => setTimeout(resolve, 500));
    const finalCheck = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length < 5) return true;
        const hasLoading = document.querySelector('[class*="animate"]') !== null;
        const hasProseContent = document.querySelectorAll('[class*="prose"]').length > 0;
        return hasLoading || hasProseContent;
      })()
    `);

    if (!finalCheck.result.value) {
      // Last resort: try Enter one more time
      await cometClient.pressKey("Enter");
    }
  }

  /**
   * Get current agent status and progress (for polling)
   */
  async getAgentStatus(): Promise<{
    status: "idle" | "working" | "completed";
    steps: string[];
    currentStep: string;
    response: string;
    hasStopButton: boolean;
    agentBrowsingUrl: string;
  }> {
    // Get browsing URL from agent's tab
    let agentBrowsingUrl = '';
    try {
      const tabs = await cometClient.listTabsCategorized();
      if (tabs.agentBrowsing) {
        agentBrowsingUrl = tabs.agentBrowsing.url;
      }
    } catch {
      // Continue without URL
    }

    // First, scroll to bottom to ensure all content is loaded
    await cometClient.safeEvaluate(`
      (() => {
        const main = document.querySelector('main') || document.body;
        main.scrollTo(0, main.scrollHeight);
      })()
    `);

    // Wait a moment for any lazy-loaded content
    await new Promise(resolve => setTimeout(resolve, 300));

    const result = await cometClient.safeEvaluate(`
      (() => {
        const body = document.body.innerText;

        // Check for active stop button
        let hasActiveStopButton = false;
        for (const btn of document.querySelectorAll('button')) {
          const rect = btn.querySelector('rect');
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          if ((rect || ariaLabel.includes('stop')) &&
              btn.offsetParent !== null && !btn.disabled) {
            hasActiveStopButton = true;
            break;
          }
        }

        const hasLoadingSpinner = document.querySelector('[class*="animate-spin"], [class*="animate-pulse"]') !== null;
        const hasStepsCompleted = /\\d+ steps? completed/i.test(body);
        const hasFinishedMarker = body.includes('Finished') && !hasActiveStopButton;
        const hasReviewedSources = /Reviewed \\d+ sources?/i.test(body);
        const hasAskFollowUp = body.includes('Ask a follow-up');
        const hasProseContent = [...document.querySelectorAll('[class*="prose"]')].some(
          el => el.innerText.trim().length > 0
        );

        const workingPatterns = [
          'Working', 'Searching', 'Reviewing sources', 'Preparing to assist',
          'Clicking', 'Typing:', 'Navigating to', 'Reading', 'Analyzing'
        ];
        const hasWorkingText = workingPatterns.some(p => body.includes(p));

        // Determine status
        let status = 'idle';
        if (hasActiveStopButton || hasLoadingSpinner) {
          status = 'working';
        } else if (hasStepsCompleted || hasFinishedMarker) {
          status = 'completed';
        } else if (hasReviewedSources && !hasWorkingText) {
          status = 'completed';
        } else if (hasWorkingText) {
          status = 'working';
        } else if (hasAskFollowUp && hasProseContent && !hasActiveStopButton) {
          status = 'completed';
        }

        // Extract steps
        const steps = [];
        const stepPatterns = [
          /Preparing to assist[^\\n]*/g, /Clicking[^\\n]*/g, /Typing:[^\\n]*/g,
          /Navigating[^\\n]*/g, /Reading[^\\n]*/g, /Searching[^\\n]*/g, /Found[^\\n]*/g
        ];
        for (const pattern of stepPatterns) {
          const matches = body.match(pattern);
          if (matches) steps.push(...matches.map(s => s.trim().substring(0, 100)));
        }

        // Extract FULL response - collect ALL prose elements, not just last
        let response = '';
        if (status === 'completed') {
          const mainContent = document.querySelector('main') || document.body;
          const allProseEls = mainContent.querySelectorAll('[class*="prose"]');
          const validProseTexts = [];

          // UI text patterns to filter out
          const uiPatterns = ['Library', 'Discover', 'Spaces', 'Finance', 'Account',
                             'Upgrade', 'Home', 'Search', 'Ask a follow-up', 'Sign in',
                             'Create account', 'Settings', 'Profile'];

          for (const el of allProseEls) {
            // Skip navigation/UI elements
            if (el.closest('nav, aside, header, footer, form, [role="navigation"]')) continue;

            const text = el.innerText.trim();
            
            // Skip UI text
            const isUIText = uiPatterns.some(ui => text.startsWith(ui));
            if (isUIText) continue;
            
            // Skip short questions (likely user prompts)
            if (text.endsWith('?') && text.length < 150) continue;
            
            // Skip very short text
            if (text.length < 10) continue;
            
            validProseTexts.push(text);
          }

          // Join ALL valid prose texts instead of just taking the last one
          if (validProseTexts.length > 0) {
            // For multiple responses in a thread, join with separator
            // Use Set-like deduplication for overlapping content
            const seen = new Set();
            const uniqueTexts = [];
            
            for (const text of validProseTexts) {
              // Create a key from first 100 chars to detect duplicates
              const key = text.substring(0, 100);
              if (!seen.has(key)) {
                seen.add(key);
                uniqueTexts.push(text);
              }
            }
            
            response = uniqueTexts.join('\\n\\n---\\n\\n');
          }

          // Clean up response
          if (response) {
            response = response.replace(/View All|Show more|Ask a follow-up|\\d+ sources?/gi, '').trim();
            // Normalize excessive whitespace but preserve paragraph breaks
            response = response.replace(/[ \\t]+/g, ' ');
            response = response.replace(/\\n{3,}/g, '\\n\\n');
          }
        }

        return {
          status,
          steps: [...new Set(steps)].slice(-5),
          currentStep: steps.length > 0 ? steps[steps.length - 1] : '',
          response: response.substring(0, 50000), // Increased limit for full research text
          hasStopButton: hasActiveStopButton
        };
      })()
    `);

    return {
      ...(result.result.value as {
        status: "idle" | "working" | "completed";
        steps: string[];
        currentStep: string;
        response: string;
        hasStopButton: boolean;
      }),
      agentBrowsingUrl,
    };
  }

  /**
   * Stop the current agent task
   */
  async stopAgent(): Promise<boolean> {
    const result = await cometClient.evaluate(`
      (() => {
        // Try aria-label buttons first
        for (const btn of document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="Cancel"]')) {
          btn.click();
          return true;
        }
        // Try square stop icon
        for (const btn of document.querySelectorAll('button')) {
          if (btn.querySelector('svg rect')) {
            btn.click();
            return true;
          }
        }
        return false;
      })()
    `);
    return result.result.value as boolean;
  }


  /**
   * Check if user is logged into Perplexity
   * Returns login status and helpful info for first-time setup
   */
  async isLoggedIn(): Promise<{
    loggedIn: boolean;
    message: string;
  }> {
    try {
      const result = await cometClient.safeEvaluate(`
        (() => {
          const body = document.body.innerText || '';
          const html = document.body.innerHTML || '';
          
          // Signs of being logged out
          const loggedOutIndicators = [
            'Sign in',
            'Log in',
            'Create account',
            'Sign up',
            'Get started',
          ];
          
          // Signs of being logged in
          const loggedInIndicators = [
            'Library',
            'Spaces',
            'Ask anything',
            'What do you want to know',
            'Home',
          ];
          
          // Check for profile menu or avatar (strong logged-in indicator)
          const hasProfileMenu = document.querySelector('[aria-label*="profile"], [aria-label*="account"], [aria-label*="user"], img[alt*="avatar"]') !== null;
          
          // Check for login buttons prominently displayed
          const hasLoginButton = html.includes('Sign in') || html.includes('Log in');
          
          // Count indicators
          const loggedOutScore = loggedOutIndicators.filter(i => body.includes(i)).length;
          const loggedInScore = loggedInIndicators.filter(i => body.includes(i)).length;
          
          // Determine status
          if (hasProfileMenu || (loggedInScore >= 2 && loggedOutScore === 0)) {
            return { loggedIn: true };
          }
          
          if (hasLoginButton && loggedOutScore > loggedInScore) {
            return { loggedIn: false };
          }
          
          // Ambiguous - likely logged in if we can see the main UI
          return { loggedIn: loggedInScore > 0 };
        })()
      `);

      const { loggedIn } = result.result.value as { loggedIn: boolean };

      if (loggedIn) {
        return {
          loggedIn: true,
          message: 'Logged into Perplexity. Ready to use.',
        };
      } else {
        return {
          loggedIn: false,
          message: 
            'Not logged into Perplexity.\n\n' +
            'Please log in to your Perplexity account in the MCP Comet browser window.\n' +
            'The browser should be visible on your screen.\n\n' +
            'After logging in, call comet_connect again.',
        };
      }
    } catch (error) {
      return {
        loggedIn: false,
        message: `Could not check login status: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

export const cometAI = new CometAI();
