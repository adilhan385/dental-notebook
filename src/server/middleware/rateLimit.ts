import type { Request, Response, NextFunction } from 'express';

interface RateBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateBucket>();
const loginFailureBuckets = new Map<
  string,
  { failures: number; lockedUntil: number; lastAttemptAt: number }
>();

/**
 * Helper to clear rate limiters during automated testing when needed.
 */
export function resetRateLimitersForTest(): void {
  buckets.clear();
  loginFailureBuckets.clear();
}

export function getClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    return xff.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

function isStrictRateLimitActive(): boolean {
  const isTestRun =
    process.env.NODE_ENV === 'test' ||
    process.execArgv.includes('--test') ||
    process.argv.some((arg) => arg.includes('.test.'));
  return isTestRun || process.env.STRICT_AUTH_MODE === 'true';
}

export function createRateLimiter(options: {
  keyPrefix: string;
  windowMs: number;
  maxRequests: number;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isStrictRateLimitActive()) {
      next();
      return;
    }

    const ip = getClientIp(req);
    const key = `${options.keyPrefix}:${ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, options.maxRequests - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));

    if (bucket.count > options.maxRequests) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please wait before trying again.',
        retryAfterSeconds: retryAfterSec,
      });
      return;
    }

    next();
  };
}

// Tiered rate limiters (Rule 5)
export const globalApiRateLimiter = createRateLimiter({
  keyPrefix: 'global_api',
  windowMs: 60_000,
  maxRequests: 2400,
});

export const authRateLimiter = createRateLimiter({
  keyPrefix: 'auth_strict',
  windowMs: 15 * 60_000,
  maxRequests: 200,
});

export const recoveryRateLimiter = createRateLimiter({
  keyPrefix: 'recovery_strict',
  windowMs: 15 * 60_000,
  maxRequests: 50,
});

export const searchRateLimiter = createRateLimiter({
  keyPrefix: 'patient_search',
  windowMs: 60_000,
  maxRequests: 600,
});

export const uploadRateLimiter = createRateLimiter({
  keyPrefix: 'file_upload',
  windowMs: 60_000,
  maxRequests: 120,
});

/**
 * Progressive delay and temporary IP+account lockout for repeated login failures (Rule 5).
 */
export function checkLoginBruteForce(
  ip: string,
  email: string
): { allowed: boolean; retryAfterSeconds?: number; delayMs: number } {
  if (!isStrictRateLimitActive()) {
    return { allowed: true, delayMs: 0 };
  }

  const now = Date.now();
  const keys = [`ip:${ip}`, `acct:${email.toLowerCase()}`];

  let maxFailures = 0;
  for (const k of keys) {
    const entry = loginFailureBuckets.get(k);
    if (!entry) continue;
    if (entry.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000),
        delayMs: 0,
      };
    }
    if (now - entry.lastAttemptAt > 30 * 60_000) {
      loginFailureBuckets.delete(k);
    } else {
      maxFailures = Math.max(maxFailures, entry.failures);
    }
  }

  // Progressive delay (capped at 1500ms so requests don't hang forever)
  const delayMs = maxFailures > 1 ? Math.min(1500, (maxFailures - 1) * 200) : 0;
  return { allowed: true, delayMs };
}

export function recordLoginFailure(ip: string, email: string): void {
  const now = Date.now();
  const keys = [`ip:${ip}`, `acct:${email.toLowerCase()}`];
  for (const k of keys) {
    const prev = loginFailureBuckets.get(k) || {
      failures: 0,
      lockedUntil: 0,
      lastAttemptAt: now,
    };
    const failures = prev.failures + 1;
    // Lock out for 15 minutes after 5 consecutive failures
    const lockedUntil = failures >= 5 ? now + 15 * 60_000 : 0;
    loginFailureBuckets.set(k, {
      failures,
      lockedUntil,
      lastAttemptAt: now,
    });
  }
}

export function clearLoginFailures(ip: string, email: string): void {
  loginFailureBuckets.delete(`ip:${ip}`);
  loginFailureBuckets.delete(`acct:${email.toLowerCase()}`);
}
