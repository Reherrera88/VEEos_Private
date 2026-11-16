import { loadConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
import { instanceManager } from './manager/instance-manager.js';
import { startApiServer } from './api/server.js';
import { startMcpServer } from './mcp/server.js';
import { closeDatabase } from './utils/database.js';
import { cleanupAll } from './browser/connect.js';

// Handle graceful shutdown
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  
  logger.info(`Received ${signal}, shutting down...`);
  
  try {
    await instanceManager.shutdown();
    await closeDatabase();
    await cleanupAll();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

async function main() {
  try {
    logger.info('=== VEEos Starting ===');
    
    // Load configuration
    loadConfig();
    logger.info('Configuration loaded');
    
    // Initialize instance manager
    await instanceManager.initialize();
    logger.info('Instance manager initialized');
    
    // Start API server
    await startApiServer();
    logger.info('API server started');
    
    // Start MCP server (if running in MCP mode)
    if (process.env.VEEOS_MCP_MODE === 'true' || process.argv.includes('--mcp')) {
      await startMcpServer();
      logger.info('MCP server started');
    }
    
    logger.info('=== VEEos Ready ===');
    
  } catch (error) {
    logger.error('Failed to start VEEos', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

main();