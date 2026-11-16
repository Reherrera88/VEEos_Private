import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { VEEosError, ErrorCodes } from '../utils/errors.js';

const FLOW_BASE_URL = 'https://labs.google/fx/tools/flow';
const FLOW_TOOLS_URL = 'https://labs.google/fx/tools/flow/tools';

export async function navigateToFlow(page, toolPath = '') {
  const locale = get('locale', 'en');
  const baseUrl = toolPath ? `${FLOW_TOOLS_URL}/${toolPath}` : FLOW_BASE_URL;
  const url = baseUrl.replace('/tools/flow', `/${locale}/tools/flow`);
  
  logger.info('Navigating to Flow', { url, toolPath });
  
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);
  } catch (e) {
    throw new VEEosError(ErrorCodes.FLOW_GENERATION_FAILED, `Navigation failed: ${e.message}`, { url });
  }
  
  const currentUrl = page.url();
  logger.info('Flow page loaded', { url: currentUrl.substring(0, 100) });
  
  // Check for OAuth/auth walls
  if (currentUrl.includes('accounts.google.com') || 
      currentUrl.includes('signin') ||
      currentUrl.includes('oauth')) {
    throw new VEEosError(ErrorCodes.OAUTH_REQUIRED, 'Google OAuth authentication required. Account needs manual login.', { url: currentUrl });
  }
  
  // Check for captcha
  const captcha = await page.evaluate(() => {
    return !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="captcha"], .g-recaptcha, #captcha');
  });
  if (captcha) {
    throw new VEEosError(ErrorCodes.FLOW_CAPTCHA, 'Captcha detected on Flow page', { url: currentUrl });
  }
  
  return { url: currentUrl, authenticated: true };
}

export async function navigateToTool(page, toolName) {
  const toolPaths = {
    'image-generation': 'image-generation',
    'video-generation': 'video-generation',
    'characters': 'characters',
    'scenes': 'scenes',
    'grid-architect': 'grid-architect',
    'tools-gallery': 'tools-gallery',
  };
  
  const path = toolPaths[toolName] || toolName;
  return await navigateToFlow(page, path);
}

export async function waitForFlowReady(page, timeout = 30000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      // Check for Flow app loaded indicators
      const ready = await page.evaluate(() => {
        // Look for Flow-specific elements
        return !!(
          document.querySelector('[data-testid*="flow"], [class*="FlowApp"], [class*="flow-app"], main[role="main"]') ||
          document.querySelector('button:has-text("Generate"), button:has-text("Create")') ||
          window.__FLOW_LOADED__ === true
        );
      });
      
      if (ready) return true;
    } catch (e) {
      // Page might be navigating
    }
    await page.waitForTimeout(1000);
  }
  
  return false;
}

export async function ensureToolPage(page, toolName) {
  const currentUrl = page.url();
  const toolPaths = {
    'image-generation': '/image-generation',
    'video-generation': '/video-generation',
    'characters': '/characters',
    'scenes': '/scenes',
    'grid-architect': '/grid-architect',
  };
  
  const expectedPath = toolPaths[toolName];
  if (expectedPath && !currentUrl.includes(expectedPath)) {
    await navigateToTool(page, toolName);
    await waitForFlowReady(page);
  }
  
  return page;
}

export async function clickSafe(page, selector, options = {}) {
  const { timeout = 10000, retries = 3, delay = 500 } = options;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.waitForSelector(selector, { state: 'visible', timeout });
      await page.click(selector, { timeout: 5000 });
      await page.waitForTimeout(delay);
      return true;
    } catch (e) {
      logger.warn('Click failed, retrying', { selector, attempt, error: e.message });
      if (attempt === retries) throw e;
      await page.waitForTimeout(delay * attempt);
    }
  }
  return false;
}

export async function fillSafe(page, selector, value, options = {}) {
  const { timeout = 10000, retries = 3, delay = 300 } = options;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.waitForSelector(selector, { state: 'visible', timeout });
      await page.fill(selector, '', { timeout: 2000 });
      await page.fill(selector, value, { timeout: 5000 });
      await page.waitForTimeout(delay);
      return true;
    } catch (e) {
      logger.warn('Fill failed, retrying', { selector, attempt, error: e.message });
      if (attempt === retries) throw e;
      await page.waitForTimeout(delay * attempt);
    }
  }
  return false;
}

export async function selectOptionSafe(page, selector, value, options = {}) {
  const { timeout = 10000 } = options;
  
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout });
    await page.selectOption(selector, value);
    await page.waitForTimeout(300);
    return true;
  } catch (e) {
    logger.error('Select option failed', { selector, value, error: e.message });
    throw new VEEosError(ErrorCodes.FLOW_ELEMENT_NOT_FOUND, `Failed to select option: ${e.message}`, { selector, value });
  }
}

export async function waitForGenerationComplete(page, pollInterval = 5000, maxAttempts = 120) {
  logger.info('Waiting for generation to complete', { pollInterval, maxAttempts });
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const status = await page.evaluate(() => {
        // Look for completion indicators
        const generateButtons = Array.from(document.querySelectorAll('button'))
          .filter(b => b.textContent?.includes('Generate') || b.textContent?.includes('Create'));
        
        const downloading = document.querySelector('[class*="downloading"], [class*="progress"], [aria-busy="true"]');
        const completed = document.querySelector('[class*="complete"], [class*="finished"], [class*="result"]');
        const error = document.querySelector('[class*="error"], [role="alert"]');
        
        if (error) return { state: 'error', message: error.textContent };
        if (completed) return { state: 'completed' };
        if (downloading) return { state: 'generating' };
        if (generateButtons.some(b => !b.disabled && b.offsetParent !== null)) return { state: 'ready' };
        
        return { state: 'unknown' };
      });
      
      if (status.state === 'completed') {
        logger.info('Generation completed');
        return { success: true };
      }
      
      if (status.state === 'error') {
        throw new VEEosError(ErrorCodes.FLOW_GENERATION_FAILED, `Generation failed: ${status.message}`);
      }
      
      if (status.state === 'ready') {
        logger.info('Generation ready (may need manual confirm)');
        return { success: true, ready: true };
      }
      
    } catch (e) {
      if (e instanceof VEEosError) throw e;
      logger.debug('Generation poll error', { attempt, error: e.message });
    }
    
    await page.waitForTimeout(pollInterval);
  }
  
  throw new VEEosError(ErrorCodes.JOB_TIMEOUT, `Generation timed out after ${maxAttempts} attempts`, { maxAttempts });
}

export async function downloadLatestFile(page, downloadDir) {
  const downloadPath = path.resolve(downloadDir);
  
  // Try to find and click download button
  const downloaded = await page.evaluate(async (downloadPath) => {
    // Look for download buttons
    const buttons = Array.from(document.querySelectorAll('button, a'))
      .filter(el => el.textContent?.toLowerCase().includes('download') || 
                    el.getAttribute('aria-label')?.toLowerCase().includes('download'));
    
    for (const btn of buttons) {
      if (btn.offsetParent !== null) { // visible
        btn.click();
        return true;
      }
    }
    return false;
  }, downloadPath);
  
  if (!downloaded) {
    // Try keyboard shortcut or context menu
    await page.keyboard.press('Control+S');
    await page.waitForTimeout(2000);
  }
  
  // Wait for file to appear
  await page.waitForTimeout(5000);
  
  // Find the downloaded file
  const files = fs.readdirSync(downloadPath).filter(f => !f.endsWith('.crdownload'));
  if (files.length === 0) {
    throw new VEEosError(ErrorCodes.FLOW_DOWNLOAD_FAILED, 'No downloaded file found');
  }
  
  // Return most recent
  const latest = files
    .map(f => ({ name: f, path: path.join(downloadPath, f), time: fs.statSync(path.join(downloadPath, f)).mtime }))
    .sort((a, b) => b.time - a.time)[0];
  
  return latest;
}

import path from 'path';
import fs from 'fs';