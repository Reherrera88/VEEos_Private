import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { VEEosError, ErrorCodes } from '../utils/errors.js';
import { navigateToTool, ensureToolPage, clickSafe, fillSafe, selectOptionSafe, waitForGenerationComplete, waitForFlowReady } from '../browser/navigation.js';
import { instanceManager } from '../manager/instance-manager.js';

const ACTION_DELAY = get('actionDelayMs', 800);

async function delay(ms = ACTION_DELAY) {
  return new Promise(r => setTimeout(r, ms));
}

export async function generateImage(accountId, params) {
  const instance = await instanceManager.ensureAccountRunning(accountId);
  const { page } = instance;
  
  await ensureToolPage(page, 'image-generation');
  await waitForFlowReady(page);
  
  const { prompt, model = 'Nano Banana 2', ratio = '1:1', reference_images = [], auto_confirm = false, brand } = params;
  
  logger.info('Generating image', { accountId, model, ratio, auto_confirm });
  
  // Fill prompt
  await fillSafe(page, 'textarea[placeholder*="prompt"], textarea[placeholder*="Prompt"], textarea[data-testid="prompt-input"]', prompt);
  await delay();
  
  // Select model
  if (model) {
    await clickSafe(page, 'button[role="combobox"]:has-text("Model"), button:has-text("Nano Banana"), [data-testid="model-select"]');
    await delay(500);
    await clickSafe(page, `button:has-text("${model}"), [role="option"]:has-text("${model}"), li:has-text("${model}")`);
    await delay();
  }
  
  // Select ratio
  if (ratio) {
    await clickSafe(page, 'button[role="combobox"]:has-text("Ratio"), button:has-text("1:1"), [data-testid="ratio-select"]');
    await delay(500);
    await clickSafe(page, `button:has-text("${ratio}"), [role="option"]:has-text("${ratio}")`);
    await delay();
  }
  
  // Add reference images if provided
  for (const refImg of reference_images) {
    // This would need file upload handling
    logger.warn('Reference images not yet implemented', { refImg });
  }
  
  // Brand-based model selection (optional)
  if (brand && !model) {
    const selectedModel = brand === 'premium' ? 'Nano Banana Pro' : 'Nano Banana 2';
    await clickSafe(page, 'button[role="combobox"]:has-text("Model")');
    await delay(500);
    await clickSafe(page, `button:has-text("${selectedModel}")`);
    await delay();
  }
  
  if (auto_confirm) {
    // Verify we're in image mode (not video)
    const isImageMode = await page.evaluate(() => {
      return document.body.innerText.includes('Image Generation') || 
             document.body.innerText.includes('Nano Banana') ||
             document.body.innerText.includes('Imagen');
    });
    
    if (!isImageMode) {
      throw new VEEosError(ErrorCodes.FLOW_UI_CHANGED, 'Not in image generation mode');
    }
    
    // Click Generate
    await clickSafe(page, 'button:has-text("Generate"):not(:disabled), button[data-testid="generate-button"]:not(:disabled)');
    
    // Wait for completion
    const result = await waitForGenerationComplete(page);
    return { status: 'completed', autoConfirmed: true, ...result };
  } else {
    // Prepare only - return ready for confirmation
    await page.screenshot({ path: `/data/screenshots/${accountId}-${Date.now()}-ready.png` });
    return { status: 'ready_for_confirmation', message: 'Prompt filled, model/ratio selected. Call with auto_confirm=true to generate.' };
  }
}

export async function generateVideo(accountId, params) {
  const instance = await instanceManager.ensureAccountRunning(accountId);
  const { page } = instance;
  
  await ensureToolPage(page, 'video-generation');
  await waitForFlowReady(page);
  
  const { prompt, model = 'Omni Flash', ratio = '16:9', duration = 5, reference_images = [] } = params;
  
  logger.info('Generating video', { accountId, model, ratio, duration });
  
  // Fill prompt
  await fillSafe(page, 'textarea[placeholder*="prompt"], textarea[placeholder*="Prompt"]', prompt);
  await delay();
  
  // Select model
  if (model) {
    await clickSafe(page, 'button[role="combobox"]:has-text("Model"), button:has-text("Omni Flash")');
    await delay(500);
    await clickSafe(page, `button:has-text("${model}"), [role="option"]:has-text("${model}")`);
    await delay();
  }
  
  // Select ratio
  if (ratio) {
    await clickSafe(page, 'button[role="combobox"]:has-text("Ratio")');
    await delay(500);
    await clickSafe(page, `button:has-text("${ratio}")`);
    await delay();
  }
  
  // Select duration
  if (duration) {
    await clickSafe(page, 'button[role="combobox"]:has-text("Duration"), button:has-text("5s")');
    await delay(500);
    await clickSafe(page, `button:has-text("${duration}s"), [role="option"]:has-text("${duration}s")`);
    await delay();
  }
  
  // Reference images
  for (const refImg of reference_images) {
    logger.warn('Reference images not yet implemented for video', { refImg });
  }
  
  // NOTE: Does NOT click Generate - stops at ready (per safety design)
  await page.screenshot({ path: `/data/screenshots/${accountId}-${Date.now()}-video-ready.png` });
  
  return { 
    status: 'ready_for_confirmation', 
    message: 'Video generation configured. Does not auto-confirm (consumes credits).',
    config: { prompt, model, ratio, duration }
  };
}

export async function createCharacter(accountId, params) {
  const instance = await instanceManager.ensureAccountRunning(accountId);
  const { page } = instance;
  
  await ensureToolPage(page, 'characters');
  await waitForFlowReady(page);
  
  const { name, description, reference_images = [] } = params;
  
  logger.info('Creating character', { accountId, name });
  
  // Click "Create character" or "+" button
  await clickSafe(page, 'button:has-text("Create character"), button:has-text("New character"), button[aria-label*="create"]');
  await delay(1000);
  
  // Fill name
  await fillSafe(page, 'input[placeholder*="name"], input[placeholder*="Name"], input[data-testid="character-name"]', name);
  await delay();
  
  // Fill description
  await fillSafe(page, 'textarea[placeholder*="description"], textarea[placeholder*="Description"]', description);
  await delay();
  
  // Reference images
  for (const refImg of reference_images) {
    logger.warn('Reference images not yet implemented for character', { refImg });
  }
  
  // Submit
  await clickSafe(page, 'button:has-text("Create"), button:has-text("Save"), button[type="submit"]');
  await delay(2000);
  
  return { status: 'created', name, description };
}

export async function importCharacter(accountId, params) {
  const instance = await instanceManager.ensureAccountRunning(accountId);
  const { page } = instance;
  
  await ensureToolPage(page, 'characters');
  await waitForFlowReady(page);
  
  const { file_path } = params;
  
  logger.info('Importing character', { accountId, file_path });
  
  // Click import button
  await clickSafe(page, 'button:has-text("Import"), button[aria-label*="import"]');
  await delay(1000);
  
  // File upload
  await page.setInputFiles('input[type="file"]', file_path);
  await delay(3000);
  
  return { status: 'imported', file: file_path };
}

export async function openCharacters(accountId) {
  const instance = await instanceManager.ensureAccountRunning(accountId);
  const { page } = instance;
  
  await ensureToolPage(page, 'characters');
  await waitForFlowReady(page);
  
  // List characters
  const characters = await page.evaluate(() => {
    const items = document.querySelectorAll('[data-testid="character-card"], .character-card, [class*="CharacterCard"]');
    return Array.from(items).map(el => ({
      name: el.querySelector('[data-testid="character-name"], h3, .name')?.textContent?.trim(),
      description: el.querySelector('[data-testid="character-description"], .description')?.textContent?.trim(),
    })).filter(c => c.name);
  });
  
  return { characters };
}

export async function createScene(accountId, params) {
  const instance = await instanceManager.ensureAccountRunning(accountId);
  const { page } = instance;
  
  await ensureToolPage(page, 'scenes');
  await waitForFlowReady(page);
  
  const { prompt, characters = [] } = params;
  
  logger.info('Creating scene', { accountId, charactersCount: characters.length });
  
  // Click new scene
  await clickSafe(page, 'button:has-text("Create scene"), button:has-text("New scene")');
  await delay(1000);
  
  // Fill prompt
  await fillSafe(page, 'textarea[placeholder*="prompt"], textarea[placeholder*="Prompt"]', prompt);
  await delay();
  
  // Add characters
  for (const charName of characters) {
    await clickSafe(page, 'button:has-text("Add character"), button[aria-label*="character"]');
    await delay(500);
    await clickSafe(page, `button:has-text("${charName}"), [role="option"]:has-text("${charName}")`);
    await delay();
  }
  
  // Submit
  await clickSafe(page, 'button:has-text("Create"), button:has-text("Save")');
  await delay(2000);
  
  return { status: 'created', prompt, characters };
}

export async function useGridArchitect(accountId, params) {
  const instance = await instanceManager.ensureAccountRunning(accountId);
  const { page } = instance;
  
  await ensureToolPage(page, 'grid-architect');
  await waitForFlowReady(page);
  
  const { theme_prompt, shot_prompts = [], engine = 'Nano Banana 2', ratio = '16:9', visual_logic, references = [] } = params;
  
  logger.info('Using Grid Architect', { accountId, shots: shot_prompts.length });
  
  // Fill theme prompt
  await fillSafe(page, 'textarea[placeholder*="theme"], textarea[placeholder*="Theme"]', theme_prompt);
  await delay();
  
  // Fill shot prompts
  for (let i = 0; i < shot_prompts.length; i++) {
    const shotPrompt = shot_prompts[i];
    // This depends on Grid Architect UI structure
    await fillSafe(page, `textarea[placeholder*="Shot ${i + 1}"], textarea[data-shot-index="${i}"]`, shotPrompt);
    await delay();
  }
  
  // Select engine
  if (engine) {
    await clickSafe(page, 'button[role="combobox"]:has-text("Engine")');
    await delay(500);
    await clickSafe(page, `button:has-text("${engine}")`);
    await delay();
  }
  
  // Select ratio
  if (ratio) {
    await clickSafe(page, 'button[role="combobox"]:has-text("Ratio")');
    await delay(500);
    await clickSafe(page, `button:has-text("${ratio}")`);
    await delay();
  }
  
  // Visual logic
  if (visual_logic) {
    await clickSafe(page, 'button[role="combobox"]:has-text("Visual logic")');
    await delay(500);
    await clickSafe(page, `button:has-text("${visual_logic}")`);
    await delay();
  }
  
  // References
  for (const refImg of references) {
    logger.warn('References not yet implemented for Grid Architect', { refImg });
  }
  
  await page.screenshot({ path: `/data/screenshots/${accountId}-${Date.now()}-grid-ready.png` });
  
  return { status: 'ready_for_confirmation', config: { theme_prompt, shot_prompts, engine, ratio, visual_logic } };
}

export async function useFlowTool(accountId, params) {
  const instance = await instanceManager.ensureAccountRunning(accountId);
  const { page } = instance;
  
  const { tool_name, params: toolParams = {} } = params;
  
  logger.info('Using Flow tool', { accountId, tool_name });
  
  // Open tools gallery first
  await ensureToolPage(page, 'tools-gallery');
  await waitForFlowReady(page);
  
  // Find and click the tool
  await clickSafe(page, `button:has-text("${tool_name}"), [data-tool-name="${tool_name}"]`);
  await delay(2000);
  
  // Fill tool-specific params
  for (const [key, value] of Object.entries(toolParams)) {
    await fillSafe(page, `input[name="${key}"], textarea[name="${key}"], [data-param="${key}"]`, String(value));
    await delay();
  }
  
  await page.screenshot({ path: `/data/screenshots/${accountId}-${Date.now()}-${tool_name}-ready.png` });
  
  return { status: 'configured', tool: tool_name, params: toolParams };
}

export async function downloadLatest(accountId) {
  const instance = await instanceManager.ensureAccountRunning(accountId);
  const { page } = instance;
  
  // Try to find download button
  await clickSafe(page, 'button:has-text("Download"), button[aria-label*="download"], a[download]');
  await delay(3000);
  
  // Check for downloaded file
  const fs = await import('fs');
  const downloadDir = '/data/downloads';
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
  
  const files = fs.readdirSync(downloadDir).filter(f => !f.endsWith('.crdownload'));
  if (files.length === 0) {
    throw new VEEosError(ErrorCodes.FLOW_DOWNLOAD_FAILED, 'No file downloaded');
  }
  
  const latest = files
    .map(f => ({ name: f, path: path.join(downloadDir, f), time: fs.statSync(path.join(downloadDir, f)).mtime }))
    .sort((a, b) => b.time - a.time)[0];
  
  return { file: latest.name, path: latest.path };
}

import path from 'path';