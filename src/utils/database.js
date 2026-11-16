import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { get } from '../utils/config.js';
import { logger } from '../utils/logger.js';

let dbInstance = null;

export function getDatabase() {
  if (dbInstance) return dbInstance;
  
  const dbPath = get('database.path', '/data/veeos.db');
  const dir = path.dirname(dbPath);
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');
  
  initSchema(dbInstance);
  
  logger.info('Database initialized', { path: dbPath });
  return dbInstance;
}

function initSchema(db) {
  // Accounts table
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      chrome_profile TEXT NOT NULL,
      host_user_data_dir TEXT NOT NULL,
      cdp_port INTEGER UNIQUE NOT NULL,
      credits INTEGER DEFAULT 150,
      initial_credits INTEGER DEFAULT 150,
      priority TEXT DEFAULT 'normal',
      enabled INTEGER DEFAULT 1,
      status TEXT DEFAULT 'initializing',
      last_health_check TEXT,
      health_failures INTEGER DEFAULT 0,
      total_jobs INTEGER DEFAULT 0,
      successful_jobs INTEGER DEFAULT 0,
      failed_jobs INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Jobs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      type TEXT NOT NULL,
      params TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT DEFAULT 'normal',
      credits_cost INTEGER DEFAULT 0,
      result TEXT,
      error TEXT,
      progress INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    )
  `);
  
  // Job queue table (for persistence across restarts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_queue (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE,
      position INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES jobs(id)
    )
  `);
  
  // Credit transactions (audit log)
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      job_id TEXT,
      amount INTEGER NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      balance_after INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (job_id) REFERENCES jobs(id)
    )
  `);
  
  // Indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_account ON jobs(account_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_account ON credit_transactions(account_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_position ON job_queue(position)`);
}

// Account operations
export const AccountDB = {
  create(account) {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO accounts (id, email, chrome_profile, host_user_data_dir, cdp_port, credits, initial_credits, priority, enabled)
      VALUES (@id, @email, @chrome_profile, @host_user_data_dir, @cdp_port, @credits, @initial_credits, @priority, @enabled)
    `);
    return stmt.run(account);
  },
  
  getAll() {
    const db = getDatabase();
    return db.prepare('SELECT * FROM accounts WHERE enabled = 1 ORDER BY priority DESC, credits DESC').all();
  },
  
  getById(id) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  },
  
  getByEmail(email) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM accounts WHERE email = ?').get(email);
  },
  
  update(id, updates) {
    const db = getDatabase();
    const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
    const stmt = db.prepare(`UPDATE accounts SET ${fields}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`);
    return stmt.run({ ...updates, id });
  },
  
  updateCredits(id, delta, jobId = null, description = '') {
    const db = getDatabase();
    return db.transaction(() => {
      const account = db.prepare('SELECT credits FROM accounts WHERE id = ?').get(id);
      if (!account) throw new Error(`Account not found: ${id}`);
      
      const newCredits = account.credits + delta;
      if (newCredits < 0) throw new Error(`Insufficient credits: ${account.credits} + ${delta} < 0`);
      
      db.prepare('UPDATE accounts SET credits = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newCredits, id);
      
      // Log transaction
      const txId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO credit_transactions (id, account_id, job_id, amount, type, description, balance_after)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(txId, id, jobId, delta, delta < 0 ? 'debit' : 'credit', description, newCredits);
      
      return newCredits;
    })();
  },
  
  incrementStats(id, success = true) {
    const db = getDatabase();
    const field = success ? 'successful_jobs' : 'failed_jobs';
    db.prepare(`
      UPDATE accounts SET total_jobs = total_jobs + 1, ${field} = ${field} + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(id);
  },
  
  updateHealth(id, success = true) {
    const db = getDatabase();
    if (success) {
      db.prepare(`
        UPDATE accounts SET last_health_check = CURRENT_TIMESTAMP, health_failures = 0, status = 'healthy', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(id);
    } else {
      db.prepare(`
        UPDATE accounts SET last_health_check = CURRENT_TIMESTAMP, health_failures = health_failures + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(id);
    }
  },
};

// Job operations
export const JobDB = {
  create(job) {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO jobs (id, account_id, type, params, status, priority, credits_cost)
      VALUES (@id, @account_id, @type, @params, @status, @priority, @credits_cost)
    `);
    return stmt.run(job);
  },
  
  get(id) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  },
  
  getByAccount(accountId, limit = 50) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?').all(accountId, limit);
  },
  
  getRecent(limit = 20) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  },
  
  updateStatus(id, status, updates = {}) {
    const db = getDatabase();
    const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
    const extra = fields ? ', ' + fields : '';
    const stmt = db.prepare(`UPDATE jobs SET status = @status ${extra} WHERE id = @id`);
    return stmt.run({ id, status, ...updates });
  },
  
  start(id) {
    const db = getDatabase();
    return db.prepare('UPDATE jobs SET status = "running", started_at = CURRENT_TIMESTAMP, progress = 0 WHERE id = ?').run(id);
  },
  
  complete(id, result) {
    const db = getDatabase();
    return db.prepare('UPDATE jobs SET status = "completed", completed_at = CURRENT_TIMESTAMP, result = @result, progress = 100 WHERE id = @id').run({ id, result: JSON.stringify(result) });
  },
  
  fail(id, error) {
    const db = getDatabase();
    return db.prepare('UPDATE jobs SET status = "failed", completed_at = CURRENT_TIMESTAMP, error = @error WHERE id = @id').run({ id, error: JSON.stringify(error) });
  },
  
  updateProgress(id, progress) {
    const db = getDatabase();
    return db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(progress, id);
  },
};

// Queue operations
export const QueueDB = {
  add(jobId, position) {
    const db = getDatabase();
    return db.prepare('INSERT INTO job_queue (id, job_id, position) VALUES (?, ?, ?)').run(crypto.randomUUID(), jobId, position);
  },
  
  remove(jobId) {
    const db = getDatabase();
    return db.prepare('DELETE FROM job_queue WHERE job_id = ?').run(jobId);
  },
  
  getNext() {
    const db = getDatabase();
    return db.prepare('SELECT jq.*, j.* FROM job_queue jq JOIN jobs j ON jq.job_id = j.id WHERE j.status = "queued" ORDER BY jq.position ASC LIMIT 1').get();
  },
  
  getAll() {
    const db = getDatabase();
    return db.prepare('SELECT jq.*, j.* FROM job_queue jq JOIN jobs j ON jq.job_id = j.id ORDER BY jq.position ASC').all();
  },
  
  reindex() {
    const db = getDatabase();
    const items = db.prepare('SELECT job_id FROM job_queue ORDER BY position ASC').all();
    const stmt = db.prepare('UPDATE job_queue SET position = ? WHERE job_id = ?');
    const tx = db.transaction((items) => {
      items.forEach((item, idx) => stmt.run(idx + 1, item.job_id));
    });
    tx(items);
  },
};

// Credit transactions
export const CreditDB = {
  getHistory(accountId, limit = 100) {
    const db = getDatabase();
    return db.prepare('SELECT * FROM credit_transactions WHERE account_id = ? ORDER BY created_at DESC LIMIT ?').all(accountId, limit);
  },
  
  getBalance(accountId) {
    const db = getDatabase();
    const row = db.prepare('SELECT credits FROM accounts WHERE id = ?').get(accountId);
    return row ? row.credits : 0;
  },
};

export function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}