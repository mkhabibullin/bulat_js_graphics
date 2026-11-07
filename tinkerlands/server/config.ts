import path from 'node:path';

export interface Config {
  env: string;
  host: string;
  port: number;
  dbPath: string;
  publicDir: string;
  /** Allowed WebSocket origins. Empty means same-host only. */
  allowedOrigins: string[];
  /** Trust X-Forwarded-For / X-Forwarded-Proto from the reverse proxy in front. */
  trustProxy: boolean;
  adminToken: string | null;
  metricsToken: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  saveIntervalMs: number;
  roomIdleMs: number;
  maxConnections: number;
  maxConnectionsPerIp: number;
  rate: {
    apiPerMinute: number;
    authPerMinute: number;
    guestsPerHour: number;
  };
  extraBlockedWords: string[];
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got "${raw}"`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = path.resolve(import.meta.dirname, '..');
  const isProd = env.NODE_ENV === 'production';

  const adminToken = env.ADMIN_TOKEN || null;
  if (adminToken !== null && adminToken.length < 24) {
    throw new Error('ADMIN_TOKEN must be at least 24 characters');
  }
  const logLevel = (env.LOG_LEVEL || 'info') as Config['logLevel'];
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(logLevel)) {
    throw new Error(`LOG_LEVEL is invalid: "${logLevel}"`);
  }

  return {
    env: env.NODE_ENV || 'development',
    host: env.HOST || (isProd ? '0.0.0.0' : '127.0.0.1'),
    port: intEnv(env, 'PORT', 8080, 0, 65535),
    dbPath: env.DB_PATH || path.join(root, 'data', 'tinkerlands.db'),
    publicDir: env.PUBLIC_DIR || path.join(root, 'dist', 'public'),
    allowedOrigins: (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: env.TRUST_PROXY === 'true',
    adminToken,
    metricsToken: env.METRICS_TOKEN || null,
    logLevel,
    saveIntervalMs: intEnv(env, 'SAVE_INTERVAL_MS', 30_000, 100, 3_600_000),
    roomIdleMs: intEnv(env, 'ROOM_IDLE_MS', 60_000, 0, 3_600_000),
    maxConnections: intEnv(env, 'MAX_CONNECTIONS', 2000, 1, 1_000_000),
    maxConnectionsPerIp: intEnv(env, 'MAX_CONNECTIONS_PER_IP', 16, 1, 100_000),
    rate: {
      apiPerMinute: intEnv(env, 'RATE_API_PER_MINUTE', 600, 1, 10_000_000),
      authPerMinute: intEnv(env, 'RATE_AUTH_PER_MINUTE', 20, 1, 10_000_000),
      guestsPerHour: intEnv(env, 'RATE_GUESTS_PER_HOUR', 30, 1, 10_000_000),
    },
    extraBlockedWords: (env.BLOCKED_WORDS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
