import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { logger } from '../utils/logger.js';
import { get } from '../utils/config.js';
import { VEEosError, ErrorCodes } from '../utils/errors.js';
import { instanceManager } from '../manager/instance-manager.js';
import * as flowTools from '../tools/flow-tools.js';
import { AccountDB, JobDB, CreditDB } from '../utils/database.js';
import crypto from 'crypto';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(get('api.cors') || { origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.debug('HTTP request', { method: req.method, path: req.path, status: res.statusCode, duration: Date.now() - start });
  });
  next();
});

// Auth middleware
const authConfig = get('api.auth') || { type: 'none' };
function authenticate(req, res, next) {
  if (authConfig.type === 'none') return next();
  
  const authHeader = req.headers[authConfig.headerName?.toLowerCase() || 'authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authentication required', code: ErrorCodes.AUTH_REQUIRED });
  }
  
  if (authConfig.type === 'bearer') {
    const token = authHeader.replace('Bearer ', '');
    if (token !== authConfig.token) {
      return res.status(401).json({ error: 'Invalid token', code: ErrorCodes.AUTH_INVALID });
    }
  } else if (authConfig.type === 'apikey') {
    if (authHeader !== authConfig.token) {
      return res.status(401).json({ error: 'Invalid API key', code: ErrorCodes.AUTH_INVALID });
    }
  }
  
  next();
}

app.use('/v1', authenticate);
app.use('/api', authenticate);

// WebSocket clients
const wsClients = new Set();
wss.on('connection', (ws, req) => {
  wsClients.add(ws);
  logger.debug('WS client connected', { total: wsClients.size });
  
  ws.on('close', () => {
    wsClients.delete(ws);
    logger.debug('WS client disconnected', { total: wsClients.size });
  });
  
  ws.on('error', (err) => {
    logger.warn('WS error', { error: err.message });
    wsClients.delete(ws);
  });
});

function broadcast(event, data) {
  const msg = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ===== HEALTH =====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'veeos', timestamp: new Date().toISOString() });
});

app.get('/health/detailed', async (req, res) => {
  const status = instanceManager.getStatus();
  const healthResults = await instanceManager.healthCheck();
  res.json({ ...status, healthChecks: healthResults });
});

// ===== ACCOUNTS =====
app.get('/v1/accounts', (req, res) => {
  const accounts = Array.from(instanceManager.instances.values()).map(i => ({
    id: i.account.id,
    email: i.account.email,
    credits: i.account.credits,
    initialCredits: i.account.initialCredits,
    priority: i.account.priority,
    status: i.status,
    enabled: i.account.enabled,
    healthFailures: i.account.healthFailures,
    queue: i.queue.getStatus(),
  }));
  res.json({ accounts });
});

app.get('/v1/accounts/:id', (req, res) => {
  const account = instanceManager.getAccount(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found', code: ErrorCodes.CONFIG_INVALID });
  res.json(account);
});

app.post('/v1/accounts/:id/start', async (req, res) => {
  try {
    await instanceManager.startAccount(req.params.id);
    res.json({ status: 'started', accountId: req.params.id });
  } catch (error) {
    res.status(500).json({ error: error.message, code: error.code });
  }
});

app.post('/v1/accounts/:id/restart', async (req, res) => {
  try {
    const { cleanupAccount } = await import('../browser/connect.js');
    await cleanupAccount(req.params.id);
    await instanceManager.startAccount(req.params.id);
    res.json({ status: 'restarted', accountId: req.params.id });
  } catch (error) {
    res.status(500).json({ error: error.message, code: error.code });
  }
});

app.get('/v1/accounts/:id/credits/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const history = CreditDB.getHistory(req.params.id, limit);
  const balance = CreditDB.getBalance(req.params.id);
  res.json({ accountId: req.params.id, balance, history });
});

// ===== JOBS =====
app.post('/v1/jobs/images', async (req, res) => {
  try {
    const { prompt, model, ratio, auto_confirm, reference_images, brand, priority, preferred_account } = req.body;
    
    if (!prompt) return res.status(400).json({ error: 'Prompt is required', code: ErrorCodes.VALIDATION_ERROR });
    
    const params = { prompt, model, ratio, auto_confirm, reference_images, brand };
    const requiredCredits = instanceManager.estimateCredits('generate_image', params);
    
    let accountId = preferred_account;
    if (!accountId) {
      const bestAccount = await instanceManager.getBestAccount(requiredCredits);
      accountId = bestAccount.id;
    }
    
    const { job } = await instanceManager.executeJob(accountId, 'generate_image', params, {
      creditsCost: requiredCredits,
      priority,
    });
    
    // Execute asynchronously
    instanceManager.instances.get(accountId).queue.on('complete', async (completedJob) => {
      if (completedJob.id === job.id) {
        broadcast('job.completed', { jobId: job.id, accountId, result: completedJob.result });
      }
    });
    
    instanceManager.instances.get(accountId).queue.on('failed', async (failedJob) => {
      if (failedJob.id === job.id) {
        broadcast('job.failed', { jobId: job.id, accountId, error: failedJob.error });
      }
    });
    
    // Run in background
    (async () => {
      try {
        const result = await flowTools.generateImage(accountId, params);
        await instanceManager.completeJob(accountId, job.id, result);
        broadcast('job.completed', { jobId: job.id, accountId, result });
      } catch (error) {
        await instanceManager.failJob(accountId, job.id, error);
        broadcast('job.failed', { jobId: job.id, accountId, error: error.message });
      }
    })();
    
    res.status(202).json({ jobId: job.id, accountId, status: 'queued', estimatedCredits: requiredCredits });
  } catch (error) {
    res.status(500).json({ error: error.message, code: error.code });
  }
});

app.post('/v1/jobs/videos', async (req, res) => {
  try {
    const { prompt, model, ratio, duration, reference_images, priority, preferred_account } = req.body;
    
    if (!prompt) return res.status(400).json({ error: 'Prompt is required', code: ErrorCodes.VALIDATION_ERROR });
    
    const params = { prompt, model, ratio, duration, reference_images };
    const requiredCredits = instanceManager.estimateCredits('generate_video', params);
    
    let accountId = preferred_account;
    if (!accountId) {
      const bestAccount = await instanceManager.getBestAccount(requiredCredits);
      accountId = bestAccount.id;
    }
    
    const { job } = await instanceManager.executeJob(accountId, 'generate_video', params, {
      creditsCost: requiredCredits,
      priority,
    });
    
    (async () => {
      try {
        const result = await flowTools.generateVideo(accountId, params);
        await instanceManager.completeJob(accountId, job.id, result);
        broadcast('job.completed', { jobId: job.id, accountId, result });
      } catch (error) {
        await instanceManager.failJob(accountId, job.id, error);
        broadcast('job.failed', { jobId: job.id, accountId, error: error.message });
      }
    })();
    
    res.status(202).json({ jobId: job.id, accountId, status: 'queued', estimatedCredits: requiredCredits });
  } catch (error) {
    res.status(500).json({ error: error.message, code: error.code });
  }
});

app.post('/v1/jobs/characters', async (req, res) => {
  try {
    const { name, description, reference_images, priority, preferred_account } = req.body;
    
    if (!name || !description) return res.status(400).json({ error: 'Name and description required', code: ErrorCodes.VALIDATION_ERROR });
    
    const params = { name, description, reference_images };
    const requiredCredits = instanceManager.estimateCredits('create_character', params);
    
    let accountId = preferred_account;
    if (!accountId) {
      const bestAccount = await instanceManager.getBestAccount(requiredCredits);
      accountId = bestAccount.id;
    }
    
    const { job } = await instanceManager.executeJob(accountId, 'create_character', params, {
      creditsCost: requiredCredits,
      priority,
    });
    
    (async () => {
      try {
        const result = await flowTools.createCharacter(accountId, params);
        await instanceManager.completeJob(accountId, job.id, result);
        broadcast('job.completed', { jobId: job.id, accountId, result });
      } catch (error) {
        await instanceManager.failJob(accountId, job.id, error);
        broadcast('job.failed', { jobId: job.id, accountId, error: error.message });
      }
    })();
    
    res.status(202).json({ jobId: job.id, accountId, status: 'queued', estimatedCredits: requiredCredits });
  } catch (error) {
    res.status(500).json({ error: error.message, code: error.code });
  }
});

app.post('/v1/jobs/scenes', async (req, res) => {
  try {
    const { prompt, characters, priority, preferred_account } = req.body;
    
    if (!prompt) return res.status(400).json({ error: 'Prompt is required', code: ErrorCodes.VALIDATION_ERROR });
    
    const params = { prompt, characters };
    const requiredCredits = instanceManager.estimateCredits('create_scene', params);
    
    let accountId = preferred_account;
    if (!accountId) {
      const bestAccount = await instanceManager.getBestAccount(requiredCredits);
      accountId = bestAccount.id;
    }
    
    const { job } = await instanceManager.executeJob(accountId, 'create_scene', params, {
      creditsCost: requiredCredits,
      priority,
    });
    
    (async () => {
      try {
        const result = await flowTools.createScene(accountId, params);
        await instanceManager.completeJob(accountId, job.id, result);
        broadcast('job.completed', { jobId: job.id, accountId, result });
      } catch (error) {
        await instanceManager.failJob(accountId, job.id, error);
        broadcast('job.failed', { jobId: job.id, accountId, error: error.message });
      }
    })();
    
    res.status(202).json({ jobId: job.id, accountId, status: 'queued', estimatedCredits: requiredCredits });
  } catch (error) {
    res.status(500).json({ error: error.message, code: error.code });
  }
});

app.post('/v1/jobs/grid-architect', async (req, res) => {
  try {
    const { theme_prompt, shot_prompts, engine, ratio, visual_logic, references, priority, preferred_account } = req.body;
    
    if (!theme_prompt) return res.status(400).json({ error: 'Theme prompt is required', code: ErrorCodes.VALIDATION_ERROR });
    
    const params = { theme_prompt, shot_prompts, engine, ratio, visual_logic, references };
    const requiredCredits = instanceManager.estimateCredits('grid_architect', params);
    
    let accountId = preferred_account;
    if (!accountId) {
      const bestAccount = await instanceManager.getBestAccount(requiredCredits);
      accountId = bestAccount.id;
    }
    
    const { job } = await instanceManager.executeJob(accountId, 'grid_architect', params, {
      creditsCost: requiredCredits,
      priority,
    });
    
    (async () => {
      try {
        const result = await flowTools.useGridArchitect(accountId, params);
        await instanceManager.completeJob(accountId, job.id, result);
        broadcast('job.completed', { jobId: job.id, accountId, result });
      } catch (error) {
        await instanceManager.failJob(accountId, job.id, error);
        broadcast('job.failed', { jobId: job.id, accountId, error: error.message });
      }
    })();
    
    res.status(202).json({ jobId: job.id, accountId, status: 'queued', estimatedCredits: requiredCredits });
  } catch (error) {
    res.status(500).json({ error: error.message, code: error.code });
  }
});

app.get('/v1/jobs/:id', (req, res) => {
  const job = JobDB.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/v1/jobs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const accountId = req.query.account_id;
  const status = req.query.status;
  
  let jobs = accountId ? JobDB.getByAccount(accountId, limit) : JobDB.getRecent(limit);
  
  if (status) {
    jobs = jobs.filter(j => j.status === status);
  }
  
  res.json({ jobs });
});

// ===== DOWNLOADS =====
app.get('/v1/downloads/:accountId/latest', async (req, res) => {
  try {
    const result = await flowTools.downloadLatest(req.params.accountId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message, code: error.code });
  }
});

// ===== POOL STATUS =====
app.get('/v1/pool/status', (req, res) => {
  res.json(instanceManager.getStatus());
});

app.post('/v1/pool/health-check', async (req, res) => {
  const results = await instanceManager.healthCheck(req.body.account_id);
  res.json({ results });
});

// ===== OPENAI-COMPATIBLE ENDPOINTS (for drop-in replacement) =====
app.post('/v1/images/generations', async (req, res) => {
  // OpenAI-compatible endpoint
  const { prompt, model = 'nano-banana-2', size = '1024x1024', n = 1, quality = 'standard' } = req.body;
  
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
  
  // Map size to ratio
  const ratioMap = { '1024x1024': '1:1', '1792x1024': '16:9', '1024x1792': '9:16' };
  const ratio = ratioMap[size] || '1:1';
  
  // Map model
  const modelMap = { 'nano-banana-pro': 'Nano Banana Pro', 'nano-banana-2': 'Nano Banana 2', 'imagen-4': 'Imagen 4' };
  const flowModel = modelMap[model] || 'Nano Banana 2';
  
  try {
    const params = { prompt, model: flowModel, ratio, auto_confirm: true };
    const requiredCredits = instanceManager.estimateCredits('generate_image', params);
    
    const bestAccount = await instanceManager.getBestAccount(requiredCredits);
    const accountId = bestAccount.id;
    
    const { job } = await instanceManager.executeJob(accountId, 'generate_image', params, {
      creditsCost: requiredCredits,
      priority: 'normal',
    });
    
    const result = await flowTools.generateImage(accountId, params);
    await instanceManager.completeJob(accountId, job.id, result);
    
    // OpenAI-compatible response
    const images = result.files?.map(f => ({ url: `file://${f.path}` })) || [];
    res.json({
      created: Math.floor(Date.now() / 1000),
      data: images.length > 0 ? images : [{ url: 'pending', jobId: job.id }],
    });
  } catch (error) {
    res.status(500).json({ error: { message: error.message, type: 'server_error' } });
  }
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('API error', { path: req.path, error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
});

export async function startApiServer() {
  const port = get('api.port', 3456);
  const host = get('api.host', '0.0.0.0');
  
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      logger.info('VEEos API server started', { host, port, ws: true });
      resolve({ app, server, wss });
    });
  });
}

export function stopApiServer() {
  return new Promise((resolve) => {
    wss.close();
    server.close(resolve);
  });
}

export { app, server, wss, broadcast };