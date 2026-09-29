import crypto from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2';
import { env } from '../config/env.js';

// OWASP recommended Argon2id parameters (Rule 9)
const ARGON2_MEMORY_KB = env.NODE_ENV === 'test' ? 4096 : 19456;
const ARGON2_ITERATIONS = env.NODE_ENV === 'test' ? 2 : 3;
const ARGON2_PARALLELISM = 1;
const ARGON2_KEY_LEN = 32;

/**
 * Hash a password using Argon2id with a unique 16-byte random salt (Rule 9).
 */
export function hashPasswordArgon2id(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = argon2id(new TextEncoder().encode(password), salt, {
    t: ARGON2_ITERATIONS,
    m: ARGON2_MEMORY_KB,
    p: ARGON2_PARALLELISM,
    dkLen: ARGON2_KEY_LEN,
  });
  const saltB64 = Buffer.from(salt).toString('base64url');
  const hashB64 = Buffer.from(hash).toString('base64url');
  return `$argon2id$v=19$m=${ARGON2_MEMORY_KB},t=${ARGON2_ITERATIONS},p=${ARGON2_PARALLELISM}$${saltB64}$${hashB64}`;
}

/**
 * Verify a password against an Argon2id PHC string using constant-time comparison (Rule 9).
 */
export function verifyPasswordArgon2id(password: string, phcString: string): boolean {
  try {
    const parts = phcString.split('$').filter(Boolean);
    if (parts.length !== 5 || parts[0] !== 'argon2id') return false;
    const paramsStr = parts[2];
    const salt = Buffer.from(parts[3], 'base64url');
    const expectedHash = Buffer.from(parts[4], 'base64url');

    const paramMap: Record<string, number> = {};
    for (const kv of paramsStr.split(',')) {
      const [k, v] = kv.split('=');
      paramMap[k] = Number(v);
    }
    const m = paramMap.m || ARGON2_MEMORY_KB;
    const t = paramMap.t || ARGON2_ITERATIONS;
    const p = paramMap.p || ARGON2_PARALLELISM;

    const computed = argon2id(new TextEncoder().encode(password), salt, {
      t,
      m,
      p,
      dkLen: expectedHash.length,
    });

    const computedBuf = Buffer.from(computed);
    if (computedBuf.length !== expectedHash.length) return false;
    return crypto.timingSafeEqual(computedBuf, expectedHash);
  } catch {
    return false;
  }
}

/**
 * Constant-time string comparison (Rule 9).
 */
export function safeCompareStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still perform a dummy comparison to avoid timing leaks on length
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Generate a cryptographically random hex token.
 */
export function generateRandomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Hash a session or verification token using SHA-256 before storing in DB (Rule 9 & Rule 13).
 */
export function hashTokenSha256(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Generate a short-lived HMAC-SHA256 signed URL signature for private file downloads (Rule 20).
 */
export function signAttachmentDownloadUrl(
  attachmentId: string,
  clinicId: string,
  ttlSeconds = 300
): { expires: number; sig: string; url: string } {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${attachmentId}:${clinicId}:${expires}`;
  const sig = crypto
    .createHmac('sha256', env.SIGNED_URL_SECRET)
    .update(payload)
    .digest('hex');
  return {
    expires,
    sig,
    url: `/api/attachments/${attachmentId}/download?expires=${expires}&sig=${sig}`,
  };
}

/**
 * Verify a signed URL for private file downloads (Rule 20).
 */
export function verifyAttachmentSignature(
  attachmentId: string,
  clinicId: string,
  expires: number,
  sig: string
): boolean {
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(expires) || nowSec > expires) return false;
  const payload = `${attachmentId}:${clinicId}:${expires}`;
  const expected = crypto
    .createHmac('sha256', env.SIGNED_URL_SECRET)
    .update(payload)
    .digest('hex');
  return safeCompareStrings(expected, sig);
}

/**
 * AES-256-GCM encryption for sensitive secrets at rest (e.g., TOTP secret & encrypted backups).
 */
export function encryptAesGcm(plaintext: string, keySeed = env.BACKUP_ENCRYPTION_KEY): string {
  const key = crypto.createHash('sha256').update(keySeed).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptAesGcm(ciphertext: string, keySeed = env.BACKUP_ENCRYPTION_KEY): string {
  const [ivB64, tagB64, dataB64] = ciphertext.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Invalid encrypted payload');
  const key = crypto.createHash('sha256').update(keySeed).digest();
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// =====================================================================
// RFC 6238 TOTP (2FA) Implementation (Rule 13)
// =====================================================================
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(): string {
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += BASE32_ALPHABET[bytes[i] % 32];
  }
  return out;
}

function base32ToBuffer(base32: string): Buffer {
  const clean = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) {
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val >= 0) bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function computeTotpCode(secretBase32: string, counter: number): string {
  const key = base32ToBuffer(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter), 0);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    1_000_000;
  return String(code).padStart(6, '0');
}

export function verifyTotpCode(secretBase32: string, code: string, windowSteps = 1): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const currentStep = Math.floor(Date.now() / 1000 / 30);
  for (let w = -windowSteps; w <= windowSteps; w++) {
    const candidate = computeTotpCode(secretBase32, currentStep + w);
    if (safeCompareStrings(candidate, code)) return true;
  }
  return false;
}
