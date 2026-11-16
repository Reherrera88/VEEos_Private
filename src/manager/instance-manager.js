import { loadConfig, get } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { VEEosError, ErrorCodes } from '../utils/errors.js';
import { connectToAccount, cleanupAccount, getAccountPage, isAccountConnected, getActiveAccounts, cleanupAll } from '../browser/connect.js';
import { JobQueue } from './job-queue.js';
import { AccountDB, JobDB } from '../utils/database.js';
import crypto from 'crypto';

class InstanceManager {
  constructor() {
    this.instances = new Map(); // accountId -> { account, queue, browser, status, credits }
    this.config = null;
    this.healthCheckInterval = null;
    this.initialized = false;
  }

  async initialize(configPath = null) {
    if (this.initialized) return;
    
    this.config = loadConfig(configPath);
    const poolConfig = this.config.pool || {};
    const accountsConfig = this.config.accounts || [];
    
    logger.info('Initializing Instance Manager', { 
      accountsCount: accountsConfig.length,
      cdpPortBase: poolConfig.cdpPortBase || 9222 
    });
    
    // Initialize accounts from config
    for (let i = 0; i < accountsConfig.length; i++) {
      const accConfig = accountsConfig[i];
      if (!accConfig.enabled) continue;
      
      const account = {
        id: accConfig.id || `flow-${i + 1}`,
        email: accConfig.email,
        chromeProfile: accConfig.chromeProfile,
        hostUserDataDir: accConfig.hostUserDataDir,
        cdpPort: (poolConfig.cdpPortBase || 9222) + i,
        credits: accConfig.initialCredits || 150,
        initialCredits: accConfig.initialCredits || 150,
        priority: accConfig.priority || 'normal',
        enabled: accConfig.enabled !== false,
        status: 'initializing',
        healthFailures: 0,
      };
      
      // Persist to database
      try {
        AccountDB.create(account);
      } catch (e) {
        // Might already exist
        const existing = AccountDB.getById(account.id);
        if (existing) {
          account.credits = existing.credits;
          account.status = existing.status;
          account.healthFailures = existing.health_failures || 0;
        }
      }
      
      // Create job queue for this account
      const queue = new JobQueue(account.id);
      
      this.instances.set(account.id, {
        account,
        queue,
        browser: null,
        context: null,
        page: null,
        status: 'initializing',
        lastActivity: null,
      });
    }
    
    this.initialized = true;
    logger.info('Instance Manager initialized', { instances: this.instances.size });
    
    // Start health checks
    this.startHealthChecks();
    
    return this;
  }

  async startAccount(accountId) {
    const instance = this.instances.get(accountId);
    if (!instance) {
      throw new VEEosError(ErrorCodes.CONFIG_INVALID, `Account not found: ${accountId}`);
    }
    
    if (instance.status === 'healthy' || instance.status === 'connecting') {
      return instance;
    }
    
    instance.status = 'connecting';
    logger.info('Starting account', { accountId });
    
    try {
      const { browser, context, page } = await connectToAccount(instance.account);
      
      instance.browser = browser;
      instance.context = context;
      instance.page = page;
      instance.status = 'healthy';
      instance.account.status = 'healthy';
      instance.lastActivity = new Date().toISOString();
      
      // Update database
      AccountDB.update(instance.account.id, { status: 'healthy', health_failures: 0 });
      
      logger.info('Account started successfully', { accountId });
      return instance;
    } catch (error) {
      instance.status = 'error';
      instance.account.status = 'error';
      instance.account.healthFailures++;
      AccountDB.update(instance.account.id, { 
        status: 'error', 
        health_failures: instance.account.healthFailures 
      });
      logger.error('Failed to start account', { accountId, error: error.message });
      throw error;
    }
  }

  async ensureAccountRunning(accountId) {
    const instance = this.instances.get(accountId);
    if (!instance) throw new VEEosError(ErrorCodes.CONFIG_INVALID, `Account not found: ${accountId}`);
    
    if (instance.status === 'healthy' && isAccountConnected(accountId)) {
      return instance;
    }
    
    return await this.startAccount(accountId);
  }

  getAvailableAccounts(options = {}) {
    const { requireCredits = 0, priority = null, status = 'healthy' } = options;
    
    const accounts = [];
    for (const [id, instance] of this.instances.entries()) {
      if (!instance.account.enabled) continue;
      if (status && instance.status !== status) continue;
      if (instance.account.credits < requireCredits) continue;
      if (priority && instance.account.priority !== priority) continue;
      if (instance.queue.getStatus().hasActiveJob) continue;
      
      accounts.push({
        id: instance.account.id,
        email: instance.account.email,
        credits: instance.account.credits,
        priority: instance.account.priority,
        status: instance.status,
        queueStatus: instance.queue.getStatus(),
      });
    }
    
    // Sort by priority (high first), then credits (desc), then queue length
    const priorityOrder = { high: 3, normal: 2, low: 1 };
    accounts.sort((a, b) => {
      const pDiff = (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0);
      if (pDiff !== 0) return pDiff;
      return b.credits - a.credits;
    });
    
    return accounts;
  }

  async getBestAccount(requiredCredits = 0) {
    const accounts = this.getAvailableAccounts({ requireCredits: requiredCredits });
    if (accounts.length === 0) {
      throw new VEEosError(ErrorCodes.NO_AVAILABLE_INSTANCE, 'No available accounts with sufficient credits', { requiredCredits });
    }
    return accounts[0];
  }

  async executeJob(accountId, jobType, params, options = {}) {
    const instance = await this.ensureAccountRunning(accountId);
    const { account, queue } = instance;
    
    // Check credits
    const requiredCredits = options.creditsCost || this.estimateCredits(jobType, params);
    if (account.credits < requiredCredits) {
      throw new VEEosError(ErrorCodes.INSUFFICIENT_CREDITS, 
        `Account ${account.email} has ${account.credits} credits, need ${requiredCredits}`, 
        { accountId, available: account.credits, required: requiredCredits });
    }
    
    // Create job
    const job = queue.createJob(jobType, params, { 
      creditsCost: requiredCredits,
      priority: options.priority || 'normal',
    });
    
    // Persist job
    JobDB.create({
      id: job.id,
      account_id: accountId,
      type: jobType,
      params: JSON.stringify(params),
      status: 'queued',
      priority: job.priority,
      credits_cost: requiredCredits,
    });
    
    // Deduct credits immediately (reserve)
    AccountDB.updateCredits(accountId, -requiredCredits, job.id, `${jobType}: ${JSON.stringify(params).substring(0, 100)}`);
    account.credits -= requiredCredits;
    
    // Start job
    queue.startJob(job.id);
    JobDB.start(job.id);
    
    instance.lastActivity = new Date().toISOString();
    
    return { job, instance };
  }

  estimateCredits(jobType, params) {
    const modelCosts = get('scheduler.modelCosts') || {};
    
    const baseCosts = {
      'generate_image': modelCosts[params.model] || modelCosts['Nano Banana 2'] || 5,
      'generate_video': modelCosts[params.model] || modelCosts['Omni Flash'] || 15,
      'create_character': 3,
      'create_scene': 5,
      'grid_architect': modelCosts['Grid Architect'] || 20,
      'use_tool': 5,
    };
    
    return baseCosts[jobType] || 5;
  }

  async completeJob(accountId, jobId, result) {
    const instance = this.instances.get(accountId);
    if (!instance) return;
    
    instance.queue.completeJob(jobId, result);
    JobDB.complete(jobId, result);
    AccountDB.incrementStats(accountId, true);
    instance.lastActivity = new Date().toISOString();
  }

  async failJob(accountId, jobId, error) {
    const instance = this.instances.get(accountId);
    if (!instance) return;
    
    instance.queue.failJob(jobId, error);
    JobDB.fail(jobId, error);
    AccountDB.incrementStats(accountId, false);
    instance.lastActivity = new Date().toISOString();
  }

  async refundCredits(accountId, jobId, amount, reason) {
    const instance = this.instances.get(accountId);
    if (!instance) return;
    
    const newCredits = AccountDB.updateCredits(accountId, amount, jobId, `Refund: ${reason}`);
    instance.account.credits = newCredits;
    logger.info('Credits refunded', { accountId, amount, newCredits, reason });
  }

  async healthCheck(accountId = null) {
    const accountsToCheck = accountId ? [accountId] : Array.from(this.instances.keys());
    const results = [];
    
    for (const id of accountsToCheck) {
      const instance = this.instances.get(id);
      if (!instance || !instance.account.enabled) continue;
      
      try {
        if (!isAccountConnected(id)) {
          throw new Error('Browser not connected');
        }
        
        const page = getAccountPage(id);
        const url = page.url();
        
        // Check if still on Flow or needs re-navigation
        const onFlow = url.includes('labs.google/fx/tools/flow');
        
        if (!onFlow) {
          // Try to navigate back
          const { navigateToFlow } = await import('../browser/navigation.js');
          await navigateToFlow(page);
        }
        
        // Verify account still matches
        const accountEmail = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="user-email"], [aria-label*="account"], .user-email');
          return el?.textContent || el?.getAttribute('aria-label') || '';
        });
        
        const expectedEmail = instance.account.email.toLowerCase();
        const match = accountEmail.toLowerCase().includes(expectedEmail) || expectedEmail.includes(accountEmail.toLowerCase());
        
        if (!match && accountEmail) {
          throw new Error(`Account mismatch: expected ${expectedEmail}, got ${accountEmail}`);
        }
        
        instance.status = 'healthy';
        instance.account.status = 'healthy';
        instance.account.healthFailures = 0;
        AccountDB.updateHealth(id, true);
        
        results.push({ accountId: id, healthy: true, url: url.substring(0, 100) });
      } catch (error) {
        instance.account.healthFailures++;
        instance.status = 'unhealthy';
        instance.account.status = 'unhealthy';
        AccountDB.updateHealth(id, false);
        
        logger.warn('Health check failed', { accountId: id, error: error.message, failures: instance.account.healthFailures });
        
        // Auto-restart if configured
        const maxRestarts = get('health.maxRestarts', 3);
        if (instance.account.healthFailures >= maxRestarts && get('health.autoRestart', true)) {
          logger.info('Attempting auto-restart', { accountId: id });
          try {
            await cleanupAccount(id);
            await this.startAccount(id);
            results.push({ accountId: id, healthy: true, restarted: true });
          } catch (restartError) {
            results.push({ accountId: id, healthy: false, error: restartError.message });
          }
        } else {
          results.push({ accountId: id, healthy: false, error: error.message, failures: instance.account.healthFailures });
        }
      }
    }
    
    return results;
  }

  startHealthChecks() {
    const intervalMs = get('health.intervalMs', 30000);
    
    this.healthCheckInterval = setInterval(async () => {
      await this.healthCheck();
    }, intervalMs);
    
    this.healthCheckInterval.unref(); // Don't prevent exit
    logger.info('Health checks started', { intervalMs });
  }

  stopHealthChecks() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  getStatus() {
    const accounts = [];
    for (const [id, instance] of this.instances.entries()) {
      accounts.push({
        id,
        email: instance.account.email,
        credits: instance.account.credits,
        priority: instance.account.priority,
        status: instance.status,
        healthFailures: instance.account.healthFailures,
        queue: instance.queue.getStatus(),
        lastActivity: instance.lastActivity,
      });
    }
    
    return {
      totalAccounts: this.instances.size,
      healthyAccounts: accounts.filter(a => a.status === 'healthy').length,
      accounts,
    };
  }

  getAccount(accountId) {
    const instance = this.instances.get(accountId);
    if (!instance) return null;
    
    return {
      ...instance.account,
      status: instance.status,
      queue: instance.queue.getStatus(),
      lastActivity: instance.lastActivity,
    };
  }

  async shutdown() {
    logger.info('Shutting down Instance Manager');
    this.stopHealthChecks();
    await cleanupAll();
    this.instances.clear();
  }
}

export const instanceManager = new InstanceManager();
export default InstanceManager;