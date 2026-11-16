import pino from 'pino';
import { get } from '../utils/config.js';

let loggerInstance = null;

export function getLogger(name = 'veeos') {
  if (loggerInstance) {
    return loggerInstance.child({ module: name });
  }
  
  const config = get('logging') || {};
  const level = config.level || 'info';
  const pretty = config.pretty !== false;
  
  const transport = pretty
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      })
    : undefined;
  
  loggerInstance = pino({
    level,
    transport,
    base: { service: 'veeos' },
  });
  
  return loggerInstance.child({ module: name });
}

export const logger = getLogger('main');