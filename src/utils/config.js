import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

let configCache = null;

export function loadConfig(configPath = null) {
  if (configCache) return configCache;
  
  const searchPaths = [
    configPath,
    path.resolve(process.cwd(), 'config/local.yaml'),
    path.resolve(process.cwd(), 'config/veeos.yaml'),
    path.resolve('/etc/veeos/config.yaml'),
  ].filter(Boolean);
  
  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf8');
      configCache = yaml.parse(content);
      // Resolve environment variables
      configCache = resolveEnvVars(configCache);
      return configCache;
    }
  }
  
  throw new Error('No configuration file found. Checked: ' + searchPaths.join(', '));
}

function resolveEnvVars(obj) {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || '');
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = resolveEnvVars(v);
    }
    return result;
  }
  return obj;
}

export function get(key, defaultValue = null) {
  const cfg = loadConfig();
  const keys = key.split('.');
  let value = cfg;
  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k];
    } else {
      return defaultValue;
    }
  }
  return value;
}

export function getConfig() {
  return loadConfig();
}

export function reloadConfig(configPath = null) {
  configCache = null;
  return loadConfig(configPath);
}