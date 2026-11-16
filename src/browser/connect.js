import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { VEEosError, ErrorCodes } from '../utils/errors.js';

const activeBrowsers = new Map(); // accountId -> { browser, context, page, chromeProcess, tempDir }

export async function connectToAccount(account) {
  const { id, cdpPort, chromeProfile, hostUserDataDir } = account;
  
  logger.info('Connecting to account', { accountId: id, cdpPort });
  
  // Check if already connected
  const existing = activeBrowsers.get(id);
  if (existing && existing.browser && existing.browser.isConnected()) {
    try {
      const pg = existing.context?.pages()[0] || await existing.context.newPage();
      existing.page = pg;
      logger.info('Reusing existing browser connection', { accountId: id });
      return { browser: existing.browser, context: existing.context, page: pg };
    } catch (e) {
      logger.warn('Existing connection stale, reconnecting', { accountId: id, error: e.message });
      await cleanupAccount(id);
    }
  }
  
  // Try CDP connection first
  try {
    logger.info('Attempting CDP connection', { cdpPort });
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();
    
    activeBrowsers.set(id, { browser, context, page, cdpPort });
    logger.info('CDP connection successful', { accountId: id });
    return { browser, context, page };
  } catch (cdpError) {
    logger.info('CDP connection failed, launching new Chrome', { accountId: id, error: cdpError.message });
  }
  
  // Launch new Chrome instance with profile copy
  return await launchChromeForAccount(account);
}

async function launchChromeForAccount(account) {
  const { id, cdpPort, chromeProfile, hostUserDataDir } = account;
  const chromePath = get('chromePath', '/usr/bin/google-chrome-stable');
  const headless = get('headless', true);
  
  if (!fs.existsSync(chromePath)) {
    throw new VEEosError(ErrorCodes.CHROME_NOT_FOUND, `Chrome not found at ${chromePath}`);
  }
  
  // Source profile path (host mounted)
  const profileSource = path.join(hostUserDataDir, chromeProfile);
  if (!fs.existsSync(profileSource)) {
    throw new VEEosError(ErrorCodes.PROFILE_NOT_FOUND, `Chrome profile not found: ${profileSource}`);
  }
  
  // Create temp directory for this account's Chrome instance
  const tempDir = `/tmp/veeos-chrome-${id}-${cdpPort}-${Date.now()}`;
  fs.mkdirSync(tempDir, { recursive: true });
  
  // Copy profile to temp dir
  const targetProfile = path.join(tempDir, chromeProfile);
  try {
    fs.cpSync(profileSource, targetProfile, { recursive: true });
    logger.info('Profile copied to temp directory', { accountId: id, targetProfile });
  } catch (e) {
    throw new VEEosError(ErrorCodes.PROFILE_COPY_FAILED, `Failed to copy profile: ${e.message}`, { source: profileSource, target: targetProfile });
  }
  
  // Copy Local State
  const localStateSrc = path.join(hostUserDataDir, 'Local State');
  if (fs.existsSync(localStateSrc)) {
    fs.cpSync(localStateSrc, path.join(tempDir, 'Local State'));
  }
  
  // Kill any existing Chrome on this CDP port
  await killPort(cdpPort);
  await new Promise(r => setTimeout(r, 1000));
  
  // Launch Chrome directly (not via Playwright) for anti-detection
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tempDir}`,
    `--profile-directory=${chromeProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--window-size=1920,1080',
    '--start-maximized',
  ];
  
  if (headless) {
    args.push('--headless=new');
    args.push('--disable-gpu');
  }
  
  logger.info('Launching Chrome', { accountId: id, cdpPort, headless, args: args.filter(a => !a.includes('user-data')).join(' ') });
  
  const chromeProcess = spawn(chromePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  
  chromeProcess.stdout?.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) logger.debug('Chrome stdout', { accountId: id, msg: msg.substring(0, 200) });
  });
  
  chromeProcess.stderr?.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes('devtools')) {
      logger.warn('Chrome stderr', { accountId: id, msg: msg.substring(0, 300) });
    }
  });
  
  // Wait for CDP to be ready
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  let attempts = 0;
  const maxAttempts = 30;
  
  while (attempts < maxAttempts) {
    try {
      const resp = await fetch(`${cdpUrl}/json/version`);
      if (resp.ok) {
        logger.info('Chrome CDP ready', { accountId: id, attempts });
        break;
      }
    } catch (e) {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 1000));
    attempts++;
  }
  
  if (attempts >= maxAttempts) {
    chromeProcess.kill('SIGTERM');
    await cleanupTempDir(tempDir);
    throw new VEEosError(ErrorCodes.CHROME_LAUNCH_FAILED, 'Chrome CDP failed to start in time', { accountId: id, cdpPort });
  }
  
  // Connect Playwright via CDP
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (e) {
    chromeProcess.kill('SIGTERM');
    await cleanupTempDir(tempDir);
    throw new VEEosError(ErrorCodes.CDP_CONNECTION_FAILED, `Failed to connect Playwright to CDP: ${e.message}`, { accountId: id });
  }
  
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();
  
  // Verify webdriver is not detected
  const webdriver = await page.evaluate(() => navigator.webdriver);
  logger.info('Browser connected', { accountId: id, webdriver, url: page.url() });
  
  // Store connection info
  activeBrowsers.set(id, { browser, context, page, chromeProcess, tempDir, cdpPort });
  
  return { browser, context, page };
}

async function killPort(port) {
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    await browser.close();
  } catch (e) {
    // No existing browser, that's fine
  }
}

async function cleanupTempDir(tempDir) {
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      logger.debug('Temp directory cleaned', { tempDir });
    }
  } catch (e) {
    logger.warn('Failed to cleanup temp dir', { tempDir, error: e.message });
  }
}

export async function cleanupAccount(accountId) {
  const conn = activeBrowsers.get(accountId);
  if (!conn) return;
  
  logger.info('Cleaning up account', { accountId });
  
  try {
    if (conn.browser) {
      await conn.browser.close();
    }
  } catch (e) {
    logger.warn('Error closing browser', { accountId, error: e.message });
  }
  
  try {
    if (conn.chromeProcess && !conn.chromeProcess.killed) {
      conn.chromeProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!conn.chromeProcess.killed) {
        conn.chromeProcess.kill('SIGKILL');
      }
    }
  } catch (e) {
    logger.warn('Error killing chrome process', { accountId, error: e.message });
  }
  
  if (conn.tempDir) {
    await cleanupTempDir(conn.tempDir);
  }
  
  activeBrowsers.delete(accountId);
}

export async function cleanupAll() {
  const accountIds = Array.from(activeBrowsers.keys());
  await Promise.all(accountIds.map(cleanupAccount));
}

export function getAccountPage(accountId) {
  const conn = activeBrowsers.get(accountId);
  if (!conn?.page) {
    throw new VEEosError(ErrorCodes.CDP_CONNECTION_FAILED, `No active page for account ${accountId}`);
  }
  return conn.page;
}

export function getAccountBrowser(accountId) {
  const conn = activeBrowsers.get(accountId);
  if (!conn?.browser) {
    throw new VEEosError(ErrorCodes.CDP_CONNECTION_FAILED, `No active browser for account ${accountId}`);
  }
  return conn.browser;
}

export function isAccountConnected(accountId) {
  const conn = activeBrowsers.get(accountId);
  return conn?.browser?.isConnected() === true;
}

export function getActiveAccounts() {
  const result = [];
  for (const [id, conn] of activeBrowsers.entries()) {
    result.push({
      id,
      cdpPort: conn.cdpPort,
      connected: conn.browser?.isConnected() === true,
      hasPage: !!conn.page,
    });
  }
  return result;
}