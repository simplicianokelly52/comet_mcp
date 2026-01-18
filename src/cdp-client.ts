// CDP Client wrapper for Comet browser control
// Supports macOS, Windows, and WSL

import CDP from "chrome-remote-interface";
import { spawn, ChildProcess, execSync } from "child_process";
import { platform } from "os";
import { existsSync } from "fs";
import type {
  CDPTarget,
  CDPVersion,
  NavigateResult,
  ScreenshotResult,
  EvaluateResult,
  CometState,
} from "./types.js";

// ============ PLATFORM DETECTION ============

/**
 * Detect if running in WSL (Windows Subsystem for Linux)
 */
function isWSL(): boolean {
  if (platform() !== 'linux') return false;
  try {
    const release = execSync('uname -r', { encoding: 'utf8' }).toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

const IS_WSL = isWSL();
const IS_WINDOWS = platform() === "win32" || IS_WSL;

/**
 * Get the appropriate Comet executable path for the current platform
 */
function getCometPath(): string {
  // Allow override via environment variable
  if (process.env.COMET_PATH) {
    return process.env.COMET_PATH;
  }

  const os = platform();

  if (os === "darwin") {
    return "/Applications/Comet.app/Contents/MacOS/Comet";
  }

  if (os === "win32" || IS_WSL) {
    // Common Windows installation paths for Comet
    const possiblePaths = [
      `${process.env.LOCALAPPDATA}\\Perplexity\\Comet\\Application\\comet.exe`,
      `${process.env.APPDATA}\\Perplexity\\Comet\\Application\\comet.exe`,
      "C:\\Program Files\\Perplexity\\Comet\\Application\\comet.exe",
      "C:\\Program Files (x86)\\Perplexity\\Comet\\Application\\comet.exe",
    ];

    for (const p of possiblePaths) {
      if (p && existsSync(p)) {
        return p;
      }
    }

    // Default to LOCALAPPDATA path
    return `${process.env.LOCALAPPDATA}\\Perplexity\\Comet\\Application\\comet.exe`;
  }

  // Fallback for other platforms
  return "/Applications/Comet.app/Contents/MacOS/Comet";
}

const COMET_PATH = getCometPath();
const DEFAULT_PORT = 9222;

// ============ MCP-DEDICATED INSTANCE CONFIG ============
// MCP uses a SEPARATE Comet instance to avoid interfering with user's personal browser

/**
 * Port for MCP-dedicated Comet instance (different from user's Comet on 9222)
 */
const MCP_PORT = 9223;

/**
 * Get MCP-specific user data directory for isolated browser profile
 */
function getMcpDataDir(): string {
  const os = platform();
  
  if (os === "darwin") {
    return `${process.env.HOME}/.comet-mcp`;
  }
  
  if (os === "win32") {
    return `${process.env.LOCALAPPDATA}\\comet-mcp`;
  }
  
  // Linux/WSL - use home directory
  return `${process.env.HOME}/.comet-mcp`;
}

const MCP_DATA_DIR = getMcpDataDir();

// ============ WSL NETWORK HELPERS ============

/**
 * Check if WSL can directly connect to Windows localhost (mirrored networking)
 */
async function canConnectToWindowsLocalhost(port: number): Promise<boolean> {
  if (!IS_WSL) return true;

  const net = await import('net');
  return new Promise((resolve) => {
    const client = net.createConnection({ port, host: '127.0.0.1' }, () => {
      client.destroy();
      resolve(true);
    });
    client.on('error', () => {
      resolve(false);
    });
    client.setTimeout(2000, () => {
      client.destroy();
      resolve(false);
    });
  });
}

/**
 * Get the port to use for CDP WebSocket connection from WSL
 * Throws helpful error if mirrored networking is not enabled
 */
async function getWSLConnectPort(targetPort: number): Promise<number> {
  if (!IS_WSL) return targetPort;

  const canConnect = await canConnectToWindowsLocalhost(targetPort);
  if (canConnect) {
    return targetPort;
  }

  throw new Error(
    `WSL cannot connect to Windows localhost:${targetPort}.\n\n` +
    `To fix this, enable WSL mirrored networking:\n` +
    `1. Create/edit %USERPROFILE%\\.wslconfig with:\n` +
    `   [wsl2]\n` +
    `   networkingMode=mirrored\n` +
    `2. Run: wsl --shutdown\n` +
    `3. Restart WSL and try again\n\n` +
    `Alternatively, run Claude Code from Windows PowerShell instead of WSL.`
  );
}

/**
 * Windows/WSL-compatible fetch using PowerShell
 * On WSL, native fetch connects to WSL's localhost, not Windows where Comet runs
 */
async function windowsFetch(
  url: string,
  method: string = 'GET'
): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  // Use native fetch on macOS/Linux (non-WSL)
  if (platform() !== 'win32' && !IS_WSL) {
    const response = await fetch(url, { method });
    return response;
  }

  // On Windows or WSL, use PowerShell to reach Windows localhost
  try {
    const psCommand = method === 'PUT'
      ? `Invoke-WebRequest -Uri '${url}' -Method PUT -UseBasicParsing | Select-Object -ExpandProperty Content`
      : `Invoke-WebRequest -Uri '${url}' -UseBasicParsing | Select-Object -ExpandProperty Content`;

    const result = execSync(`powershell.exe -NoProfile -Command "${psCommand}"`, {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });

    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(result.trim())
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      json: async () => { throw error; }
    };
  }
}

export class CometCDPClient {
  private client: CDP.Client | null = null;
  private cometProcess: ChildProcess | null = null;
  private state: CometState = {
    connected: false,
    port: DEFAULT_PORT,
  };
  private lastTargetId: string | undefined;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private isReconnecting: boolean = false;

  get isConnected(): boolean {
    return this.state.connected && this.client !== null;
  }

  /**
   * Health check - verify connection is actually alive (not just "connected" in state)
   * This catches cases where WebSocket died silently
   */
  async isHealthy(): Promise<boolean> {
    if (!this.client || !this.state.connected) return false;

    try {
      // Simple evaluation that should always work if connected
      const result = await Promise.race([
        this.client.Runtime.evaluate({ expression: '1+1', returnByValue: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 3000))
      ]);
      return (result as any)?.result?.value === 2;
    } catch {
      // Connection is dead
      this.state.connected = false;
      return false;
    }
  }

  /**
   * Ensure we have a healthy connection, reconnecting if needed
   * Call this before any CDP operation
   */
  async ensureHealthyConnection(): Promise<void> {
    const healthy = await this.isHealthy();
    if (!healthy) {
      // Try to reconnect first
      try {
        await this.reconnect();
        return;
      } catch {
        // Reconnect failed, try to restart Comet entirely
        try {
          await this.startComet(MCP_PORT);
          await this.connect();
        } catch (startError) {
          throw new Error(
            `Cannot establish healthy connection to MCP Comet.\n` +
            `Reconnect and restart both failed.\n` +
            `Error: ${startError instanceof Error ? startError.message : String(startError)}`
          );
        }
      }
    }
  }

  get currentState(): CometState {
    return { ...this.state };
  }

  /**
   * Auto-reconnect wrapper for operations with exponential backoff
   */
  private async withAutoReconnect<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isReconnecting) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    try {
      const result = await operation();
      this.reconnectAttempts = 0;
      return result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const connectionErrors = [
        'WebSocket', 'CLOSED', 'not open', 'disconnected',
        'ECONNREFUSED', 'ECONNRESET', 'Protocol error', 'Target closed', 'Session closed'
      ];

      if (connectionErrors.some(e => errorMessage.includes(e)) &&
          this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.isReconnecting = true;

        try {
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 5000);
          await new Promise(resolve => setTimeout(resolve, delay));
          await this.reconnect();
          this.isReconnecting = false;
          return await operation();
        } catch (reconnectError) {
          this.isReconnecting = false;
          throw reconnectError;
        }
      }

      throw error;
    }
  }

  /**
   * Reconnect to the last connected tab
   */
  async reconnect(): Promise<string> {
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
    }
    this.state.connected = false;
    this.client = null;

    // Verify Comet is running
    try {
      await this.getVersion();
    } catch {
      try {
        await this.startComet(this.state.port);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch {
        throw new Error('Cannot connect to Comet. Ensure Comet is running with --remote-debugging-port=9222');
      }
    }

    // Try to reconnect to last target
    if (this.lastTargetId) {
      try {
        const targets = await this.listTargets();
        if (targets.find(t => t.id === this.lastTargetId)) {
          return await this.connect(this.lastTargetId);
        }
      } catch { /* target gone */ }
    }

    // Find best target
    const targets = await this.listTargets();
    const target = targets.find(t => t.type === 'page' && t.url.includes('perplexity.ai')) ||
                   targets.find(t => t.type === 'page' && t.url !== 'about:blank');

    if (target) {
      return await this.connect(target.id);
    }

    throw new Error('No suitable tab found for reconnection');
  }

  /**
   * List tabs with categorization
   */
  async listTabsCategorized(): Promise<{
    main: CDPTarget | null;
    sidecar: CDPTarget | null;
    agentBrowsing: CDPTarget | null;
    overlay: CDPTarget | null;
    others: CDPTarget[];
  }> {
    const targets = await this.listTargets();

    return {
      main: targets.find(t =>
        t.type === 'page' && t.url.includes('perplexity.ai') && !t.url.includes('sidecar')
      ) || null,
      sidecar: targets.find(t =>
        t.type === 'page' && t.url.includes('sidecar')
      ) || null,
      agentBrowsing: targets.find(t =>
        t.type === 'page' &&
        !t.url.includes('perplexity.ai') &&
        !t.url.includes('chrome-extension') &&
        !t.url.includes('chrome://') &&
        t.url !== 'about:blank'
      ) || null,
      overlay: targets.find(t =>
        t.url.includes('chrome-extension') && t.url.includes('overlay')
      ) || null,
      others: targets.filter(t =>
        t.type === 'page' &&
        !t.url.includes('perplexity.ai') &&
        !t.url.includes('chrome-extension')
      ),
    };
  }

  /**
   * Check if MCP-specific Comet process is running (NOT personal Comet)
   * Only detects Comet instances started with MCP's debugging port
   */
  private async isMcpCometRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      if (IS_WINDOWS) {
        // Windows: use WMIC to find Comet with MCP port in command line
        const check = spawn('wmic', ['process', 'where', `name='comet.exe' and commandline like '%--remote-debugging-port=${MCP_PORT}%'`, 'get', 'processid']);
        let output = '';
        check.stdout?.on('data', (data) => { output += data.toString(); });
        check.on('close', () => {
          // WMIC returns header + data if found, just header if not
          const lines = output.trim().split('\n').filter(l => l.trim() && !l.includes('ProcessId'));
          resolve(lines.length > 0);
        });
        check.on('error', () => resolve(false));
      } else {
        // macOS/Linux: use pgrep with MCP-specific port pattern
        // This ensures we only detect MCP Comet, not personal Comet on port 9222
        const check = spawn('pgrep', ['-f', `remote-debugging-port=${MCP_PORT}`]);
        check.on('close', (code) => resolve(code === 0));
        check.on('error', () => resolve(false));
      }
    });
  }

  /**
   * Kill only MCP-specific Comet process (NEVER kills personal Comet)
   * Only terminates Comet instances started with MCP's debugging port
   */
  private async killMcpComet(): Promise<void> {
    return new Promise((resolve) => {
      if (IS_WINDOWS) {
        // Windows: use WMIC to find and kill only MCP Comet by port
        const kill = spawn('wmic', ['process', 'where', `name='comet.exe' and commandline like '%--remote-debugging-port=${MCP_PORT}%'`, 'call', 'terminate']);
        kill.on('close', () => setTimeout(resolve, 1000));
        kill.on('error', () => setTimeout(resolve, 1000));
      } else {
        // macOS/Linux: use pkill with MCP-specific port pattern
        // This ensures we ONLY kill MCP Comet, never personal Comet on port 9222
        const kill = spawn('pkill', ['-f', `remote-debugging-port=${MCP_PORT}`]);
        kill.on('close', () => setTimeout(resolve, 1000));
        kill.on('error', () => setTimeout(resolve, 1000));
      }
    });
  }

  /**
   * Start Comet browser with remote debugging enabled
   * Handles macOS, Windows, and WSL environments
   */
  async startComet(port: number = MCP_PORT): Promise<string> {
    this.state.port = port;

    // Ensure we're using MCP port, never interfere with user's Comet on 9222
    if (port === 9222) {
      port = MCP_PORT;
      this.state.port = port;
    }

    // Create MCP data directory if it doesn't exist
    const { mkdirSync } = await import('fs');
    try {
      mkdirSync(MCP_DATA_DIR, { recursive: true });
    } catch {
      // Directory may already exist
    }

    // Common launch arguments for isolated MCP instance
    // CRITICAL: These flags ensure a truly separate Comet instance
    const launchArgs = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${MCP_DATA_DIR}`,
      // Force new instance even if another Comet is running
      '--no-first-run',
      '--no-default-browser-check',
      // Disable single-instance lock (Electron apps)
      '--disable-features=SingleInstanceCheck',
      // Allow multiple instances
      '--class=comet-mcp',
      // Start with clean session
      '--new-window',
    ];

    // ========== WSL: Use PowerShell to communicate with Windows ==========
    if (IS_WSL) {
      // Check if MCP Comet is already running via PowerShell HTTP
      try {
        const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          const version = await response.json() as CDPVersion;
          return `MCP Comet already running on Windows host, port: ${port} (${version.Browser})`;
        }
      } catch {
        // MCP Comet not accessible, need to launch
      }

      // Kill any stale MCP Comet process on this port
      try {
        execSync(`powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`, {
          timeout: 5000,
          windowsHide: true,
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch {
        // No stale process
      }

      // Get Windows LOCALAPPDATA path and construct Comet path
      let cometPath = '';
      let winDataDir = '';
      try {
        const localAppData = execSync('cmd.exe /c echo %LOCALAPPDATA%', { encoding: 'utf8' })
          .trim().replace(/\r?\n/g, '');
        cometPath = `${localAppData}\\Perplexity\\Comet\\Application\\Comet.exe`;
        winDataDir = `${localAppData}\\comet-mcp`;
      } catch {
        cometPath = 'C:\\Users\\' + (process.env.USER || 'user') +
          '\\AppData\\Local\\Perplexity\\Comet\\Application\\Comet.exe';
        winDataDir = 'C:\\Users\\' + (process.env.USER || 'user') + '\\AppData\\Local\\comet-mcp';
      }

      // Retry logic for startup reliability
      const maxRetries = 3;
      let lastError: Error | null = null;

      for (let retry = 0; retry < maxRetries; retry++) {
        try {
          // Launch MCP Comet via PowerShell with isolated profile
          const psCommand = `Set-Location C:\\; Start-Process -FilePath '${cometPath}' -ArgumentList '--remote-debugging-port=${port}','--user-data-dir=${winDataDir}'`;
          spawn('powershell.exe', ['-NoProfile', '-Command', psCommand], {
            detached: true,
            stdio: 'ignore',
          }).unref();

          // Wait for Comet to start with extended timeout
          const result = await new Promise<string>((resolve, reject) => {
            const maxAttempts = 60; // 30 seconds
            let attempts = 0;

            const checkReady = async () => {
              attempts++;
              try {
                const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);
                if (response.ok) {
                  resolve(`MCP Comet started via WSL->PowerShell on port ${port} (isolated profile)`);
                  return;
                }
              } catch { /* keep trying */ }

              if (attempts < maxAttempts) {
                setTimeout(checkReady, 500);
              } else {
                reject(new Error(`Timeout waiting for MCP Comet after ${maxAttempts * 500 / 1000}s`));
              }
            };

            setTimeout(checkReady, 2000);
          });

          return result;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (retry < maxRetries - 1) {
            // Kill and retry
            try {
              execSync(`powershell.exe -NoProfile -Command "Get-Process comet -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*${port}*' } | Stop-Process -Force"`, {
                timeout: 5000,
                windowsHide: true,
              });
            } catch { /* continue */ }
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }

      throw new Error(
        `Cannot start MCP Comet after ${maxRetries} attempts.\n` +
        `Path: ${cometPath}\n` +
        `Port: ${port}\n` +
        `Data dir: ${winDataDir}\n` +
        `Last error: ${lastError?.message}`
      );
    }

    // ========== Native Windows: Use windowsFetch for HTTP ==========
    if (platform() === 'win32') {
      try {
        const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          const version = await response.json() as CDPVersion;
          return `MCP Comet already running with debug port ${port}: ${version.Browser}`;
        }
      } catch {
        // Check for stale process and kill it
        const isRunning = await this.isMcpCometRunning();
        if (isRunning) {
          await this.killMcpComet();
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Retry logic
      const maxRetries = 3;
      let lastError: Error | null = null;

      for (let retry = 0; retry < maxRetries; retry++) {
        try {
          // Start MCP Comet on Windows with isolated profile
          this.cometProcess = spawn(COMET_PATH, launchArgs, {
            detached: true,
            stdio: "ignore",
          });
          this.cometProcess.unref();

          const result = await new Promise<string>((resolve, reject) => {
            const maxAttempts = 60;
            let attempts = 0;

            const checkReady = async () => {
              attempts++;
              try {
                const response = await windowsFetch(`http://127.0.0.1:${port}/json/version`);
                if (response.ok) {
                  resolve(`MCP Comet started with debug port ${port} (isolated profile)`);
                  return;
                }
              } catch { /* keep trying */ }

              if (attempts < maxAttempts) {
                setTimeout(checkReady, 500);
              } else {
                reject(new Error(`Timeout waiting for MCP Comet`));
              }
            };

            setTimeout(checkReady, 1500);
          });

          return result;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (retry < maxRetries - 1) {
            await this.killMcpComet();
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }

      throw new Error(
        `Cannot start MCP Comet after ${maxRetries} attempts.\n` +
        `Path: ${COMET_PATH}\n` +
        `Args: ${launchArgs.join(' ')}\n` +
        `Error: ${lastError?.message}`
      );
    }

    // ========== macOS/Linux: Original approach with improvements ==========
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`http://localhost:${port}/json/version`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.ok) {
        const version = await response.json() as CDPVersion;
        return `MCP Comet already running with debug port ${port}: ${version.Browser}`;
      }
    } catch {
      // Check for stale process and kill it
      const isRunning = await this.isMcpCometRunning();
      if (isRunning) {
        await this.killMcpComet();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Retry logic for macOS/Linux
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        // On macOS, use a SEPARATE app bundle to truly isolate from personal Comet
        // This bypasses Electron's single-instance lock by being a "different app"
        if (platform() === 'darwin') {
          const mcpAppPath = `${process.env.HOME}/.comet-mcp/Comet-MCP.app`;
          const mcpAppExists = existsSync(mcpAppPath);

          if (mcpAppExists) {
            // Use the MCP-specific Comet app (different bundle ID = truly separate)
            // -g flag: launch in background without bringing to foreground
            this.cometProcess = spawn('open', [
              '-g',  // Don't bring app to foreground
              '-a', mcpAppPath,
              '--args',
              ...launchArgs,
            ], {
              detached: true,
              stdio: 'ignore',
            });
            this.cometProcess.unref();
          } else {
            // Fallback: try direct spawn (may interfere with personal Comet)
            console.error('Warning: ~/.comet-mcp/Comet-MCP.app not found. Run setup first.');
            this.cometProcess = spawn(COMET_PATH, launchArgs, {
              detached: true,
              stdio: "ignore",
            });
            this.cometProcess.unref();
          }
        } else {
          // Linux: use direct spawn
          this.cometProcess = spawn(COMET_PATH, launchArgs, {
            detached: true,
            stdio: "ignore",
          });
          this.cometProcess.unref();
        }

        const result = await new Promise<string>((resolve, reject) => {
          const maxAttempts = 60;
          let attempts = 0;

          const checkReady = async () => {
            attempts++;
            try {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 2000);
              const response = await fetch(`http://localhost:${port}/json/version`, { signal: controller.signal });
              clearTimeout(timeoutId);

              if (response.ok) {
                const version = await response.json() as CDPVersion;
                resolve(`MCP Comet started with debug port ${port}: ${version.Browser} (isolated profile at ${MCP_DATA_DIR})`);
                return;
              }
            } catch { /* keep trying */ }

            if (attempts < maxAttempts) {
              setTimeout(checkReady, 500);
            } else {
              reject(new Error(`Timeout waiting for MCP Comet after ${maxAttempts * 500 / 1000}s`));
            }
          };

          setTimeout(checkReady, 1500);
        });

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (retry < maxRetries - 1) {
          await this.killMcpComet();
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    throw new Error(
      `Cannot start MCP Comet after ${maxRetries} attempts.\n` +
      `Path: ${COMET_PATH}\n` +
      `Args: ${launchArgs.join(' ')}\n` +
      `Data dir: ${MCP_DATA_DIR}\n` +
      `Error: ${lastError?.message}\n\n` +
      `Try manually: ${COMET_PATH} ${launchArgs.join(' ')}`
    );
  }

  /**
   * Get CDP version info
   */
  async getVersion(): Promise<CDPVersion> {
    const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/version`);
    if (!response.ok) throw new Error(`Failed to get version: ${response.status}`);
    return response.json() as Promise<CDPVersion>;
  }

  /**
   * List all available tabs/targets
   */
  async listTargets(): Promise<CDPTarget[]> {
    const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/list`);
    if (!response.ok) throw new Error(`Failed to list targets: ${response.status}`);
    return response.json() as Promise<CDPTarget[]>;
  }

  /**
   * Connect to a specific tab
   */
  async connect(targetId?: string): Promise<string> {
    if (this.client) {
      await this.disconnect();
    }

    // On WSL, verify mirrored networking is available for WebSocket connection
    const connectPort = await getWSLConnectPort(this.state.port);

    const options: CDP.Options = { port: connectPort, host: '127.0.0.1' };
    if (targetId) options.target = targetId;

    this.client = await CDP(options);

    await Promise.all([
      this.client.Page.enable(),
      this.client.Runtime.enable(),
      this.client.DOM.enable(),
      this.client.Network.enable(),
    ]);

    // Intercept popups to keep browsing inside Comet (not Chrome)
    await this.setupPopupInterception();

    // Ensure window is visible and usable (don't force specific size - let user resize)
    try {
      const { windowId } = await (this.client as any).Browser.getWindowForTarget({ targetId });
      // Just ensure window is in normal state (not minimized), don't restrict size
      await (this.client as any).Browser.setWindowBounds({
        windowId,
        bounds: { windowState: 'normal' },
      });
    } catch { /* continue - window management not critical */ }

    this.state.connected = true;
    this.state.activeTabId = targetId;
    this.lastTargetId = targetId;
    this.reconnectAttempts = 0;

    const { result } = await this.client.Runtime.evaluate({ expression: "window.location.href" });
    this.state.currentUrl = result.value as string;

    // Add visual indicator that this is MCP-controlled Comet
    try {
      await this.client.Runtime.evaluate({
        expression: `
          (() => {
            // Add MCP badge to document title
            if (!document.title.includes('[MCP]')) {
              document.title = '[MCP] ' + document.title;
            }
            // Also add a subtle visual indicator
            if (!document.getElementById('mcp-indicator')) {
              const indicator = document.createElement('div');
              indicator.id = 'mcp-indicator';
              indicator.style.cssText = 'position:fixed;top:4px;right:4px;background:#D97757;color:white;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;z-index:999999;pointer-events:none;opacity:0.9;';
              indicator.textContent = 'MCP';
              document.body.appendChild(indicator);
            }
          })()
        `
      });
    } catch { /* non-critical */ }

    return `Connected to tab: ${this.state.currentUrl}`;
  }

  /**
   * Disconnect from current tab
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.state.connected = false;
      this.state.activeTabId = undefined;
    }
  }

  /**
   * Navigate to a URL
   */
  async navigate(url: string, waitForLoad: boolean = true): Promise<NavigateResult> {
    this.ensureConnected();
    const result = await this.client!.Page.navigate({ url });
    if (waitForLoad) await this.client!.Page.loadEventFired();
    this.state.currentUrl = url;
    return result as NavigateResult;
  }

  /**
   * Capture screenshot
   */
  async screenshot(format: "png" | "jpeg" = "png"): Promise<ScreenshotResult> {
    this.ensureConnected();
    return this.client!.Page.captureScreenshot({ format }) as Promise<ScreenshotResult>;
  }

  /**
   * Execute JavaScript in the page context
   */
  async evaluate(expression: string): Promise<EvaluateResult> {
    this.ensureConnected();
    return this.client!.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as Promise<EvaluateResult>;
  }

  /**
   * Execute JavaScript with auto-reconnect on connection loss
   * This is the PREFERRED method - always use this instead of evaluate()
   */
  async safeEvaluate(expression: string): Promise<EvaluateResult> {
    // Always check health first to catch silently dead connections
    await this.ensureHealthyConnection();

    return this.withAutoReconnect(async () => {
      this.ensureConnected();
      return this.client!.Runtime.evaluate({
        expression,
        awaitPromise: true,
        returnByValue: true,
      }) as Promise<EvaluateResult>;
    });
  }

  /**
   * Press a key
   */
  async pressKey(key: string): Promise<void> {
    this.ensureConnected();
    await this.client!.Input.dispatchKeyEvent({ type: "keyDown", key });
    await this.client!.Input.dispatchKeyEvent({ type: "keyUp", key });
  }

  /**
   * Insert text at the current focus (uses CDP Input.insertText)
   */
  async insertText(text: string): Promise<void> {
    this.ensureConnected();
    await this.client!.Input.insertText({ text });
  }

  /**
   * Create a new tab
   */
  async newTab(url?: string): Promise<CDPTarget> {
    const response = await windowsFetch(
      `http://127.0.0.1:${this.state.port}/json/new${url ? `?${url}` : ""}`,
      'PUT'
    );
    if (!response.ok) throw new Error(`Failed to create new tab: ${response.status}`);
    return response.json() as Promise<CDPTarget>;
  }

  /**
   * Close a tab
   */
  async closeTab(targetId: string): Promise<boolean> {
    try {
      if (this.client) {
        const result = await this.client.Target.closeTarget({ targetId });
        return result.success;
      }
    } catch { /* fallback to HTTP */ }

    try {
      const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/close/${targetId}`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Hide the Comet app (like Cmd+H on macOS)
   * Keeps process alive for fast reconnection
   */
  async hideApp(): Promise<void> {
    try {
      if (platform() === 'darwin') {
        // macOS: Use AppleScript to hide the app (Cmd+H behavior)
        execSync(`osascript -e 'tell application "System Events" to set visible of process "Comet-MCP" to false' 2>/dev/null || osascript -e 'tell application "System Events" to set visible of process "Comet" to false' 2>/dev/null`, { stdio: 'ignore' });
      } else if (platform() === 'win32') {
        // Windows: Minimize window via CDP
        if (this.client && this.state.activeTabId) {
          const { windowId } = await (this.client as any).Browser.getWindowForTarget({
            targetId: this.state.activeTabId
          });
          await (this.client as any).Browser.setWindowBounds({
            windowId,
            bounds: { windowState: 'minimized' }
          });
        }
      }
    } catch {
      // Non-critical - window management may not be available
    }
  }

  private ensureConnected(): void {
    if (!this.client) {
      throw new Error("Not connected to Comet. Call connect() first.");
    }
  }

  /**
   * Set up interception for popups/new windows to keep browsing inside Comet
   * This prevents Perplexity's agentic browsing from opening Chrome
   */
  private async setupPopupInterception(): Promise<void> {
    if (!this.client) return;

    try {
      // Enable auto-attach to catch new targets (popups, new windows)
      await (this.client as any).Target.setAutoAttach({
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });

      // Listen for new targets and handle them
      (this.client as any).Target.on('attachedToTarget', async (params: any) => {
        const { targetInfo, sessionId } = params;

        // If it's a new page/popup, handle it within Comet
        if (targetInfo.type === 'page' && targetInfo.url && targetInfo.url !== 'about:blank') {
          console.log(`[MCP] Intercepted popup: ${targetInfo.url}`);
        }
      });

      // Inject JavaScript to override window.open() and keep navigation in Comet
      await this.injectPopupOverride();
    } catch (error) {
      // Non-critical - continue without popup interception
      console.error('[MCP] Popup interception setup failed:', error);
    }
  }

  /**
   * Inject JavaScript to override window.open() behavior
   * Opens URLs in new Comet tabs instead of external Chrome
   */
  private async injectPopupOverride(): Promise<void> {
    if (!this.client) return;

    try {
      // Add script to execute on every new document
      await (this.client as any).Page.addScriptToEvaluateOnNewDocument({
        source: `
          (function() {
            // Store original window.open
            const originalOpen = window.open;

            // Override window.open to prevent external browser
            window.open = function(url, target, features) {
              // If URL is provided, try to handle it internally
              if (url && typeof url === 'string') {
                // Check if it's an absolute URL to external site
                if (url.startsWith('http://') || url.startsWith('https://')) {
                  // For external URLs, open in a new tab within Comet
                  // by returning null (handled by CDP) or navigating current window
                  console.log('[MCP] Intercepted window.open:', url);

                  // Create a link and click it to open in new tab
                  const link = document.createElement('a');
                  link.href = url;
                  link.target = '_blank';
                  link.rel = 'noopener';
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);

                  // Return null to prevent external browser
                  return null;
                }
              }
              // For other cases, use original behavior
              return originalOpen.call(window, url, target, features);
            };

            // Also intercept shell.openExternal if available (Electron)
            if (typeof require !== 'undefined') {
              try {
                const { shell } = require('electron');
                if (shell && shell.openExternal) {
                  const originalOpenExternal = shell.openExternal.bind(shell);
                  shell.openExternal = function(url, options) {
                    console.log('[MCP] Intercepted shell.openExternal:', url);
                    // Navigate within Comet instead
                    window.location.href = url;
                    return Promise.resolve();
                  };
                }
              } catch (e) {
                // Not in Electron context, ignore
              }
            }
          })();
        `
      });
    } catch (error) {
      // Non-critical - continue without override
      console.error('[MCP] Failed to inject popup override:', error);
    }
  }
}

export const cometClient = new CometCDPClient();
