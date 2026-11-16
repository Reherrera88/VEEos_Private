import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { VEEosError, ErrorCodes } from '../utils/errors.js';
import { get } from '../utils/config.js';

const JOB_TIMEOUT = get('jobTimeoutMs', 300000);

export class JobQueue {
  constructor(accountId) {
    this.accountId = accountId;
    this.currentJob = null;
    this.jobs = new Map();
    this.listeners = new Map();
    this.paused = false;
  }

  generateId() {
    return crypto.randomUUID().slice(0, 8);
  }

  createJob(type, params = {}, options = {}) {
    if (this.currentJob && this.currentJob.status === 'running') {
      throw new VEEosError(
        ErrorCodes.JOB_IN_PROGRESS,
        `Account ${this.accountId} already has a running job: ${this.currentJob.id} (${this.currentJob.type})`,
        { currentJobId: this.currentJob.id, currentJobType: this.currentJob.type }
      );
    }

    if (this.paused) {
      throw new VEEosError(ErrorCodes.ACCOUNT_PAUSED, `Account ${this.accountId} is paused`);
    }

    const id = this.generateId();
    const job = {
      id,
      accountId: this.accountId,
      type,
      params,
      status: 'queued',
      priority: options.priority || 'normal',
      creditsCost: options.creditsCost || 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      progress: 0,
    };

    this.jobs.set(id, job);
    this.currentJob = job;
    this.emit('created', job);
    logger.info('Job created', { accountId: this.accountId, jobId: id, type });

    return job;
  }

  startJob(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    if (job.status !== 'queued') throw new Error(`Job ${id} is not queued (status: ${job.status})`);
    
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    this.currentJob = job;
    this.emit('start', job);
    logger.info('Job started', { accountId: this.accountId, jobId: id, type: job.type });
    return job;
  }

  completeJob(id, result) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.result = result;
    job.progress = 100;
    this.currentJob = null;
    this.emit('complete', job);
    logger.info('Job completed', { accountId: this.accountId, jobId: id, type: job.type });
    return job;
  }

  failJob(id, error) {
    const job = this.jobs.get(id);
    if (!job) {
      logger.error('Cannot fail unknown job', { accountId: this.accountId, jobId: id });
      return null;
    }
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = error instanceof Error ? { message: error.message, code: error.code, stack: error.stack } : { message: String(error) };
    this.currentJob = null;
    this.emit('failed', job);
    logger.error('Job failed', { accountId: this.accountId, jobId: id, type: job.type, error: job.error.message });
    return job;
  }

  setManualAction(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = 'manual_action_required';
    this.emit('manual', job);
  }

  updateProgress(id, progress) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.progress = Math.min(100, Math.max(0, progress));
    this.emit('progress', job);
  }

  getJob(id) {
    return this.jobs.get(id);
  }

  getCurrentJob() {
    return this.currentJob;
  }

  getStatus() {
    return {
      accountId: this.accountId,
      hasActiveJob: this.currentJob?.status === 'running' || this.currentJob?.status === 'queued',
      currentJob: this.currentJob ? {
        id: this.currentJob.id,
        type: this.currentJob.type,
        status: this.currentJob.status,
        progress: this.currentJob.progress,
        createdAt: this.currentJob.createdAt,
      } : null,
      totalJobs: this.jobs.size,
      paused: this.paused,
    };
  }

  getHistory(limit = 20) {
    return Array.from(this.jobs.values())
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, limit);
  }

  pause() {
    this.paused = true;
    this.emit('paused', { accountId: this.accountId });
  }

  resume() {
    this.paused = false;
    this.emit('resumed', { accountId: this.accountId });
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  off(event, callback) {
    if (!this.listeners.has(event)) return;
    const callbacks = this.listeners.get(event);
    const idx = callbacks.indexOf(callback);
    if (idx >= 0) callbacks.splice(idx, 1);
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event) || [];
    for (const cb of callbacks) {
      try { cb(data); } catch (err) { logger.error('Job queue listener error', { event, error: err.message }); }
    }
  }
}

export default JobQueue;