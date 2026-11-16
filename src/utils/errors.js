export class VEEosError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VEEosError';
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const ErrorCodes = {
  // Configuration
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  CONFIG_INVALID: 'CONFIG_INVALID',
  
  // Browser/Chrome
  CHROME_NOT_FOUND: 'CHROME_NOT_FOUND',
  CHROME_LAUNCH_FAILED: 'CHROME_LAUNCH_FAILED',
  CDP_CONNECTION_FAILED: 'CDP_CONNECTION_FAILED',
  CDP_PORT_IN_USE: 'CDP_PORT_IN_USE',
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  PROFILE_COPY_FAILED: 'PROFILE_COPY_FAILED',
  
  // Authentication
  OAUTH_REQUIRED: 'OAUTH_REQUIRED',
  ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  
  // Job Queue
  JOB_IN_PROGRESS: 'JOB_IN_PROGRESS',
  JOB_TIMEOUT: 'JOB_TIMEOUT',
  JOB_FAILED: 'JOB_FAILED',
  QUEUE_FULL: 'QUEUE_FULL',
  NO_AVAILABLE_INSTANCE: 'NO_AVAILABLE_INSTANCE',
  
  // Credits
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  CREDIT_CRITICAL: 'CREDIT_CRITICAL',
  ACCOUNT_PAUSED: 'ACCOUNT_PAUSED',
  
  // Google Flow
  FLOW_UI_CHANGED: 'FLOW_UI_CHANGED',
  FLOW_ELEMENT_NOT_FOUND: 'FLOW_ELEMENT_NOT_FOUND',
  FLOW_GENERATION_FAILED: 'FLOW_GENERATION_FAILED',
  FLOW_DOWNLOAD_FAILED: 'FLOW_DOWNLOAD_FAILED',
  FLOW_CAPTCHA: 'FLOW_CAPTCHA',
  FLOW_RATE_LIMITED: 'FLOW_RATE_LIMITED',
  
  // API
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID: 'AUTH_INVALID',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  
  // Database
  DB_ERROR: 'DB_ERROR',
  DB_LOCKED: 'DB_LOCKED',
};

export function isBlockingError(error) {
  if (!(error instanceof VEEosError)) return false;
  const blockingCodes = [
    ErrorCodes.OAUTH_REQUIRED,
    ErrorCodes.ACCOUNT_MISMATCH,
    ErrorCodes.SESSION_EXPIRED,
    ErrorCodes.FLOW_CAPTCHA,
    ErrorCodes.INSUFFICIENT_CREDITS,
    ErrorCodes.CREDIT_CRITICAL,
    ErrorCodes.ACCOUNT_PAUSED,
  ];
  return blockingCodes.includes(error.code);
}

export function isRetryableError(error) {
  if (!(error instanceof VEEosError)) return true;
  const retryableCodes = [
    ErrorCodes.CDP_CONNECTION_FAILED,
    ErrorCodes.JOB_TIMEOUT,
    ErrorCodes.FLOW_GENERATION_FAILED,
    ErrorCodes.FLOW_RATE_LIMITED,
    ErrorCodes.DB_LOCKED,
  ];
  return retryableCodes.includes(error.code);
}