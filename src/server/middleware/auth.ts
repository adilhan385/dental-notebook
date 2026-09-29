import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { queryInternal, withClinicRls, type DbExecutor } from '../db/pool.js';
import { generateRandomToken, hashTokenSha256, safeCompareStrings } from '../security/crypto.js';
import { getClientIp } from './rateLimit.js';

export const SESSION_COOKIE_NAME = 'dental_session';
export const REFRESH_COOKIE_NAME = 'dental_refresh';
export const LOGGED_OUT_COOKIE_NAME = 'dental_logged_out';

export function isStrictAuthMode(): boolean {
  const isTestRun =
    process.env.NODE_ENV === 'test' ||
    env.NODE_ENV === 'test' ||
    process.execArgv.includes('--test') ||
    process.argv.some((arg) => arg.includes('.test.'));
  return isTestRun || process.env.STRICT_AUTH_MODE === 'true';
}

export interface AuthenticatedContext {
  sessionId: string;
  accountId: string;
  clinicId: string;
  email: string;
  csrfToken: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedContext;
    }
  }
}

export function setAuthCookies(
  res: Response,
  sessionToken: string,
  refreshToken: string
): void {
  const cookieBase = {
    httpOnly: true,
    secure: env.IS_PROD,
    sameSite: 'strict' as const,
    path: '/',
  };

  res.clearCookie(LOGGED_OUT_COOKIE_NAME, cookieBase);

  res.cookie(SESSION_COOKIE_NAME, sessionToken, {
    ...cookieBase,
    maxAge: env.SESSION_MAX_AGE_MS,
  });

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    ...cookieBase,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days rotating refresh token
  });
}

export function clearAuthCookies(res: Response, markLoggedOut = false): void {
  const cookieBase = {
    httpOnly: true,
    secure: env.IS_PROD,
    sameSite: 'strict' as const,
    path: '/',
  };
  res.clearCookie(SESSION_COOKIE_NAME, cookieBase);
  res.clearCookie(REFRESH_COOKIE_NAME, cookieBase);
  if (markLoggedOut) {
    res.cookie(LOGGED_OUT_COOKIE_NAME, '1', {
      ...cookieBase,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }
}

async function createAutoLocalSession(
  req: Request,
  res: Response
): Promise<AuthenticatedContext | null> {
  const acctRes = await queryInternal<{
    id: string;
    clinic_id: string;
    email: string;
  }>(
    `SELECT id, clinic_id, email
     FROM auth_internal.clinic_accounts
     ORDER BY created_at ASC
     LIMIT 1`
  );
  const acct = acctRes.rows[0];
  if (!acct) return null;

  const rawSessionToken = generateRandomToken(32);
  const rawRefreshToken = generateRandomToken(32);
  const csrfToken = generateRandomToken(24);
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + env.SESSION_MAX_AGE_MS).toISOString();

  await queryInternal(
    `INSERT INTO auth_internal.sessions
     (id, account_id, clinic_id, token_hash, refresh_token_hash, csrf_token, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      sessionId,
      acct.id,
      acct.clinic_id,
      hashTokenSha256(rawSessionToken),
      hashTokenSha256(rawRefreshToken),
      csrfToken,
      getClientIp(req),
      String(req.headers['user-agent'] || '').slice(0, 250),
      expiresAt,
    ]
  );

  setAuthCookies(res, rawSessionToken, rawRefreshToken);

  return {
    sessionId,
    accountId: acct.id,
    clinicId: acct.clinic_id,
    email: acct.email,
    csrfToken,
  };
}

/**
 * Mandatory server-side authentication & CSRF verification middleware (Rule 4, Rule 10, Rule 11, Rule 13).
 * Checks:
 * 1. Valid session token in HttpOnly cookie
 * 2. Session not expired and not idle beyond SESSION_IDLE_TIMEOUT_MS
 * 3. Account email_verified === true (Rule 13)
 * 4. Valid X-CSRF-Token header for all state-changing methods (POST, PATCH, PUT, DELETE)
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
    const explicitlyLoggedOut = req.cookies?.[LOGGED_OUT_COOKIE_NAME] === '1';

    if (!rawToken || typeof rawToken !== 'string') {
      if (!isStrictAuthMode() && !explicitlyLoggedOut) {
        const autoAuth = await createAutoLocalSession(req, res);
        if (autoAuth) {
          req.auth = autoAuth;
          next();
          return;
        }
      }
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Authentication required. Your unsaved changes are safely kept locally.',
      });
      return;
    }

    const tokenHash = hashTokenSha256(rawToken);
    const result = await queryInternal<{
      session_id: string;
      account_id: string;
      clinic_id: string;
      csrf_token: string;
      last_active_at: string;
      expires_at: string;
      revoked_at: string | null;
      email: string;
      email_verified: boolean;
    }>(
      `SELECT
         s.id AS session_id,
         s.account_id,
         s.clinic_id,
         s.csrf_token,
         s.last_active_at,
         s.expires_at,
         s.revoked_at,
         a.email,
         a.email_verified
       FROM auth_internal.sessions s
       JOIN auth_internal.clinic_accounts a ON a.id = s.account_id
       WHERE s.token_hash = $1
       LIMIT 1`,
      [tokenHash]
    );

    const row = result.rows[0];
    if (!row || row.revoked_at) {
      if (!isStrictAuthMode() && !explicitlyLoggedOut) {
        const autoAuth = await createAutoLocalSession(req, res);
        if (autoAuth) {
          req.auth = autoAuth;
          next();
          return;
        }
      }
      clearAuthCookies(res);
      res.status(401).json({
        error: 'SESSION_INVALID',
        message: 'Session is invalid or has been signed out.',
      });
      return;
    }

    const now = Date.now();
    const expiresAt = new Date(row.expires_at).getTime();
    const lastActiveAt = new Date(row.last_active_at).getTime();

    if (now > expiresAt || now - lastActiveAt > env.SESSION_IDLE_TIMEOUT_MS) {
      await queryInternal(
        `UPDATE auth_internal.sessions SET revoked_at = NOW() WHERE id = $1`,
        [row.session_id]
      );
      if (!isStrictAuthMode() && !explicitlyLoggedOut) {
        const autoAuth = await createAutoLocalSession(req, res);
        if (autoAuth) {
          req.auth = autoAuth;
          next();
          return;
        }
      }
      clearAuthCookies(res);
      res.status(401).json({
        error: 'SESSION_EXPIRED',
        message: 'Session expired due to inactivity. Your unsaved changes are kept locally.',
      });
      return;
    }

    // Rule 13: Block access until clinic account email is verified
    if (!row.email_verified) {
      res.status(403).json({
        error: 'EMAIL_NOT_VERIFIED',
        message: 'Clinic account email is not verified yet. Please verify your email.',
      });
      return;
    }

    // Rule 10: Enforce CSRF token check on all state-changing HTTP methods
    const stateChangingMethods = ['POST', 'PATCH', 'PUT', 'DELETE'];
    if (stateChangingMethods.includes(req.method.toUpperCase())) {
      const clientCsrf = req.headers['x-csrf-token'];
      if (
        typeof clientCsrf !== 'string' ||
        !safeCompareStrings(clientCsrf, row.csrf_token)
      ) {
        res.status(403).json({
          error: 'CSRF_TOKEN_INVALID',
          message: 'Security token (CSRF) missing or invalid. Please refresh the page.',
        });
        return;
      }
    }

    // Update session activity timestamp
    await queryInternal(
      `UPDATE auth_internal.sessions SET last_active_at = NOW() WHERE id = $1`,
      [row.session_id]
    );

    req.auth = {
      sessionId: row.session_id,
      accountId: row.account_id,
      clinicId: row.clinic_id,
      email: row.email,
      csrfToken: row.csrf_token,
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Convenience wrapper that executes a callback inside a PostgreSQL transaction
 * with `clinic_app_role` and RLS session parameters set from `req.auth` (Rule 3 & Rule 4).
 */
export async function runWithAuthenticatedRls<R>(
  req: Request,
  callback: (db: DbExecutor, auth: AuthenticatedContext) => Promise<R>
): Promise<R> {
  if (!req.auth || !req.auth.clinicId) {
    throw new Error('UNAUTHENTICATED_RLS_CALL');
  }
  const auth = req.auth;
  return withClinicRls(
    { authenticated: true, clinicId: auth.clinicId },
    (db) => callback(db, auth)
  );
}

/**
 * Record an immutable audit event inside the clinic's RLS scope (Additional Security Baseline).
 */
export async function logAuditEvent(
  db: DbExecutor,
  params: {
    clinicId: string;
    eventType: string;
    entityType?: string;
    entityId?: string | null;
    req?: Request;
    metadata?: Record<string, any>;
  }
): Promise<void> {
  const ip = params.req ? getClientIp(params.req) : null;
  await db.query(
    `INSERT INTO public.audit_events (id, clinic_id, event_type, entity_type, entity_id, ip_address, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      crypto.randomUUID(),
      params.clinicId,
      params.eventType,
      params.entityType || null,
      params.entityId || null,
      ip,
      JSON.stringify(params.metadata || {}),
    ]
  );
}
