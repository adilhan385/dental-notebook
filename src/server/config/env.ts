import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Server-side environment configuration (Rule 1 & Rule 2).
 * Secrets live strictly on the server and are never exposed to the client.
 */
function loadDotEnvIfPresent() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (process.env[key] === undefined && val !== '') {
      process.env[key] = val;
    }
  }
}

loadDotEnvIfPresent();

const isProd = process.env.NODE_ENV === 'production';
const isVercel = Boolean(process.env.VERCEL);

const defaultDataRoot = isVercel
  ? path.join(os.tmpdir(), 'dental-notebook-data')
  : path.resolve(process.cwd(), 'data');

function getRequiredOrDeterministicSecret(name: string): string {
  const val = process.env[name];
  if (val && val.length >= 32) {
    return val;
  }
  if (isProd && process.env.STRICT_PRODUCTION_SECRETS === 'true') {
    throw new Error(`CRITICAL SECURITY ERROR: Missing or weak ${name} in production environment.`);
  }
  // Derive a consistent 256-bit secret so serverless invocations and restarts share the same key
  const seed = process.env.VERCEL_PROJECT_ID || process.env.VERCEL_URL || 'dental-notebook-local-seed-2026';
  const generated = crypto.createHmac('sha256', seed).update(name).digest('hex');
  process.env[name] = generated;
  return generated;
}

export const env = {
  NODE_ENV: (process.env.NODE_ENV || 'development') as 'development' | 'production' | 'test',
  IS_PROD: isProd,
  IS_VERCEL: isVercel,
  PORT: Number(process.env.PORT || 3001),
  DATABASE_URL: process.env.DATABASE_URL || '',
  PGLITE_DATA_DIR: process.env.PGLITE_DATA_DIR || path.join(defaultDataRoot, 'pgdata'),
  PRIVATE_STORAGE_DIR:
    process.env.PRIVATE_STORAGE_DIR || path.join(defaultDataRoot, 'private_uploads'),
  BACKUP_DIR: process.env.BACKUP_DIR || path.join(defaultDataRoot, 'backups'),
  ALLOWED_ORIGINS: (
    process.env.ALLOWED_ORIGINS ||
    'http://localhost:5173,http://localhost:3001,http://127.0.0.1:5173,http://127.0.0.1:3001'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  SESSION_SECRET: getRequiredOrDeterministicSecret('SESSION_SECRET'),
  SIGNED_URL_SECRET: getRequiredOrDeterministicSecret('SIGNED_URL_SECRET'),
  BACKUP_ENCRYPTION_KEY: getRequiredOrDeterministicSecret('BACKUP_ENCRYPTION_KEY'),
  WEBHOOK_SECRET: getRequiredOrDeterministicSecret('WEBHOOK_SECRET'),
  SESSION_IDLE_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes inactivity timeout (Rule 10)
  SESSION_MAX_AGE_MS: 12 * 60 * 60 * 1000, // 12 hours max session lifetime
};

