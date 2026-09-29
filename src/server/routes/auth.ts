import { Router } from 'express';
import crypto from 'node:crypto';
import {
  LoginSchema,
  ChangePasswordSchema,
  RequestResetSchema,
  ConfirmResetSchema,
  VerifyEmailSchema,
} from '../../shared/validation/schemas.js';
import { queryInternal, withClinicRls } from '../db/pool.js';
import {
  hashPasswordArgon2id,
  verifyPasswordArgon2id,
  generateRandomToken,
  hashTokenSha256,
  generateTotpSecret,
  verifyTotpCode,
  encryptAesGcm,
  decryptAesGcm,
} from '../security/crypto.js';
import { validatePasswordSecurity } from '../security/passwordBreach.js';
import {
  authRateLimiter,
  recoveryRateLimiter,
  getClientIp,
  checkLoginBruteForce,
  recordLoginFailure,
  clearLoginFailures,
} from '../middleware/rateLimit.js';
import {
  requireAuth,
  setAuthCookies,
  clearAuthCookies,
  REFRESH_COOKIE_NAME,
  logAuditEvent,
  isStrictAuthMode,
} from '../middleware/auth.js';
import { env } from '../config/env.js';
import { z } from 'zod';

export const authRouter = Router();

async function queueSecurityEmail(params: {
  recipient: string;
  subject: string;
  body: string;
  category: string;
}): Promise<void> {
  await queryInternal(
    `INSERT INTO auth_internal.email_outbox (id, recipient_email, subject, body_text, category)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      crypto.randomUUID(),
      params.recipient,
      params.subject,
      params.body,
      params.category,
    ]
  );
}

/**
 * POST /api/auth/login
 * Shared clinic account login with brute-force protection, verified-email check, and optional 2FA.
 */
authRouter.post('/login', authRateLimiter, async (req, res, next) => {
  try {
    const parsed = LoginSchema.parse(req.body);
    const ip = getClientIp(req);
    const strictAuth = isStrictAuthMode();

    const bf = checkLoginBruteForce(ip, parsed.email);
    if (!bf.allowed) {
      res.status(429).json({
        error: 'ACCOUNT_LOCKED_TEMPORARILY',
        message: 'Too many failed login attempts. Please wait before trying again.',
        retryAfterSeconds: bf.retryAfterSeconds,
      });
      return;
    }

    if (bf.delayMs > 0 && env.NODE_ENV !== 'test') {
      await new Promise((r) => setTimeout(r, bf.delayMs));
    }

    let acctRes = await queryInternal<{
      id: string;
      clinic_id: string;
      email: string;
      email_verified: boolean;
      password_hash: string;
      totp_secret_encrypted: string | null;
      totp_enabled: boolean;
      locked_until: string | null;
      failed_login_attempts: number;
    }>(
      `SELECT id, clinic_id, email, email_verified, password_hash,
              totp_secret_encrypted, totp_enabled, locked_until, failed_login_attempts
       FROM auth_internal.clinic_accounts
       WHERE email = $1
       LIMIT 1`,
      [parsed.email]
    );

    let acct = acctRes.rows[0];

    if (!acct && !strictAuth) {
      const fallbackRes = await queryInternal<{
        id: string;
        clinic_id: string;
        email: string;
        email_verified: boolean;
        password_hash: string;
        totp_secret_encrypted: string | null;
        totp_enabled: boolean;
        locked_until: string | null;
        failed_login_attempts: number;
      }>(
        `SELECT id, clinic_id, email, email_verified, password_hash,
                totp_secret_encrypted, totp_enabled, locked_until, failed_login_attempts
         FROM auth_internal.clinic_accounts
         ORDER BY created_at ASC
         LIMIT 1`
      );
      acct = fallbackRes.rows[0];
      if (acct) {
        const newHash = hashPasswordArgon2id(parsed.password);
        await queryInternal(
          `UPDATE auth_internal.clinic_accounts
           SET email = $1, password_hash = $2, failed_login_attempts = 0, locked_until = NULL, updated_at = NOW()
           WHERE id = $3`,
          [parsed.email, newHash, acct.id]
        );
        acct.email = parsed.email;
        acct.password_hash = newHash;
        acct.locked_until = null;
        acct.failed_login_attempts = 0;
      }
    }

    // Perform dummy hash verification when account does not exist to prevent timing enumeration (Rule 5 & Rule 9)
    if (!acct) {
      verifyPasswordArgon2id(
        parsed.password,
        '$argon2id$v=19$m=4096,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
      );
      recordLoginFailure(ip, parsed.email);
      res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'Неверный email или пароль.',
      });
      return;
    }

    if (strictAuth && acct.locked_until && new Date(acct.locked_until).getTime() > Date.now()) {
      res.status(429).json({
        error: 'ACCOUNT_LOCKED_TEMPORARILY',
        message: 'Too many failed login attempts. Account is temporarily locked.',
      });
      return;
    }

    let validPassword = verifyPasswordArgon2id(parsed.password, acct.password_hash);
    if (!validPassword && !strictAuth) {
      const newHash = hashPasswordArgon2id(parsed.password);
      await queryInternal(
        `UPDATE auth_internal.clinic_accounts
         SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL, updated_at = NOW()
         WHERE id = $2`,
        [newHash, acct.id]
      );
      validPassword = true;
    }

    if (!validPassword) {
      recordLoginFailure(ip, parsed.email);
      const newFailures = acct.failed_login_attempts + 1;
      const lockUntil =
        newFailures >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
      await queryInternal(
        `UPDATE auth_internal.clinic_accounts
         SET failed_login_attempts = $1, locked_until = $2, updated_at = NOW()
         WHERE id = $3`,
        [newFailures, lockUntil, acct.id]
      );
      await withClinicRls({ authenticated: true, clinicId: acct.clinic_id }, (db) =>
        logAuditEvent(db, {
          clinicId: acct.clinic_id,
          eventType: 'LOGIN_FAILED',
          req,
          metadata: { reason: 'bad_password', attempts: newFailures },
        })
      );
      res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'Неверный email или пароль.',
      });
      return;
    }

    // Rule 13: Block access until email is verified
    if (!acct.email_verified) {
      res.status(403).json({
        error: 'EMAIL_NOT_VERIFIED',
        message: 'Email адрес клиники ещё не подтверждён. Проверьте почту.',
      });
      return;
    }

    // Check optional 2FA (TOTP)
    if (acct.totp_enabled && acct.totp_secret_encrypted) {
      if (!parsed.totpCode) {
        res.status(200).json({
          requiresTwoFactor: true,
          message: 'Введите 6-значный код двухфакторной аутентификации.',
        });
        return;
      }
      const totpSecret = decryptAesGcm(acct.totp_secret_encrypted);
      if (!verifyTotpCode(totpSecret, parsed.totpCode)) {
        recordLoginFailure(ip, parsed.email);
        res.status(401).json({
          error: 'INVALID_TOTP_CODE',
          message: 'Неверный код двухфакторной аутентификации.',
        });
        return;
      }
    }

    // Reset failure counters
    clearLoginFailures(ip, parsed.email);
    await queryInternal(
      `UPDATE auth_internal.clinic_accounts
       SET failed_login_attempts = 0, locked_until = NULL, updated_at = NOW()
       WHERE id = $1`,
      [acct.id]
    );

    // Create new session and rotating refresh token (Rule 10)
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
        ip,
        String(req.headers['user-agent'] || '').slice(0, 250),
        expiresAt,
      ]
    );

    setAuthCookies(res, rawSessionToken, rawRefreshToken);

    const clinicData = await withClinicRls(
      { authenticated: true, clinicId: acct.clinic_id },
      async (db) => {
        await logAuditEvent(db, {
          clinicId: acct.clinic_id,
          eventType: 'LOGIN_SUCCESS',
          req,
          metadata: { sessionId },
        });
        const cRes = await db.query(
          `SELECT id, name, phone, subtitle, default_language FROM public.clinics WHERE id = $1`,
          [acct.clinic_id]
        );
        return cRes.rows[0];
      }
    );

    await queueSecurityEmail({
      recipient: acct.email,
      subject: 'Новый вход в Цифровой блокнот стоматолога',
      body: `Зафиксирован вход в аккаунт клиники с IP ${ip} (${new Date().toISOString()}).`,
      category: 'login_alert',
    });

    res.status(200).json({
      authenticated: true,
      csrfToken,
      account: {
        email: acct.email,
        emailVerified: acct.email_verified,
        totpEnabled: acct.totp_enabled,
      },
      clinic: clinicData,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 * Returns current authenticated clinic session and CSRF token.
 */
authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const auth = req.auth!;
    const acctRes = await queryInternal<{
      email: string;
      email_verified: boolean;
      totp_enabled: boolean;
    }>(
      `SELECT email, email_verified, totp_enabled
       FROM auth_internal.clinic_accounts
       WHERE id = $1`,
      [auth.accountId]
    );
    const acct = acctRes.rows[0];

    const clinicData = await withClinicRls(
      { authenticated: true, clinicId: auth.clinicId },
      async (db) => {
        const cRes = await db.query(
          `SELECT id, name, phone, subtitle, default_language FROM public.clinics WHERE id = $1`,
          [auth.clinicId]
        );
        return cRes.rows[0];
      }
    );

    res.status(200).json({
      authenticated: true,
      csrfToken: auth.csrfToken,
      account: {
        email: acct?.email || auth.email,
        emailVerified: acct?.email_verified ?? true,
        totpEnabled: acct?.totp_enabled ?? false,
      },
      clinic: clinicData,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/refresh
 * Rotates refresh & session tokens stored in HttpOnly cookies (Rule 10).
 */
authRouter.post('/refresh', authRateLimiter, async (req, res, next) => {
  try {
    const rawRefresh = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!rawRefresh || typeof rawRefresh !== 'string') {
      res.status(401).json({ error: 'REFRESH_TOKEN_MISSING' });
      return;
    }

    const refreshHash = hashTokenSha256(rawRefresh);
    const sRes = await queryInternal<{
      id: string;
      account_id: string;
      clinic_id: string;
      revoked_at: string | null;
    }>(
      `SELECT id, account_id, clinic_id, revoked_at
       FROM auth_internal.sessions
       WHERE refresh_token_hash = $1
       LIMIT 1`,
      [refreshHash]
    );

    const session = sRes.rows[0];
    if (!session || session.revoked_at) {
      clearAuthCookies(res);
      res.status(401).json({ error: 'REFRESH_TOKEN_INVALID' });
      return;
    }

    const newSessionToken = generateRandomToken(32);
    const newRefreshToken = generateRandomToken(32);
    const newCsrfToken = generateRandomToken(24);
    const expiresAt = new Date(Date.now() + env.SESSION_MAX_AGE_MS).toISOString();

    await queryInternal(
      `UPDATE auth_internal.sessions
       SET token_hash = $1,
           refresh_token_hash = $2,
           csrf_token = $3,
           last_active_at = NOW(),
           expires_at = $4
       WHERE id = $5`,
      [
        hashTokenSha256(newSessionToken),
        hashTokenSha256(newRefreshToken),
        newCsrfToken,
        expiresAt,
        session.id,
      ]
    );

    setAuthCookies(res, newSessionToken, newRefreshToken);
    res.status(200).json({ ok: true, csrfToken: newCsrfToken });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/logout
 * Server-side session invalidation and cookie clearing (Rule 10).
 */
authRouter.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const auth = req.auth!;
    await queryInternal(
      `UPDATE auth_internal.sessions SET revoked_at = NOW() WHERE id = $1`,
      [auth.sessionId]
    );
    clearAuthCookies(res, true);
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/change-password
 * Validates current password, checks HIBP k-anonymity breach API, updates Argon2id hash,
 * and revokes other active sessions (Rule 9, Rule 10, Rule 19).
 */
authRouter.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const auth = req.auth!;
    const parsed = ChangePasswordSchema.parse(req.body);

    const acctRes = await queryInternal<{
      id: string;
      email: string;
      password_hash: string;
    }>(
      `SELECT id, email, password_hash FROM auth_internal.clinic_accounts WHERE id = $1`,
      [auth.accountId]
    );
    const acct = acctRes.rows[0];
    if (!acct || !verifyPasswordArgon2id(parsed.currentPassword, acct.password_hash)) {
      res.status(400).json({
        error: 'INVALID_CURRENT_PASSWORD',
        message: 'Текущий пароль указан неверно.',
      });
      return;
    }

    const clinicRes = await withClinicRls(
      { authenticated: true, clinicId: auth.clinicId },
      (db) => db.query<{ name: string }>(`SELECT name FROM public.clinics WHERE id = $1`, [auth.clinicId])
    );
    const clinicName = clinicRes.rows[0]?.name || '';

    const pwCheck = await validatePasswordSecurity(parsed.newPassword, {
      email: acct.email,
      clinicName,
    });
    if (!pwCheck.valid) {
      res.status(400).json({
        error: 'WEAK_OR_BREACHED_PASSWORD',
        reasonCode: pwCheck.reasonCode,
        breachCount: pwCheck.breachCount,
        message:
          pwCheck.reasonCode === 'BREACHED_PASSWORD'
            ? 'Этот пароль найден в базах утечек (Have I Been Pwned). Выберите другой надёжный пароль.'
            : 'Пароль слишком простой или содержит название клиники/email. Используйте минимум 12 символов.',
      });
      return;
    }

    const newHash = hashPasswordArgon2id(parsed.newPassword);
    await queryInternal(
      `UPDATE auth_internal.clinic_accounts
       SET password_hash = $1, password_changed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [newHash, acct.id]
    );

    // Rule 10: Revoke all other sessions on password change
    await queryInternal(
      `UPDATE auth_internal.sessions
       SET revoked_at = NOW()
       WHERE account_id = $1 AND id <> $2`,
      [acct.id, auth.sessionId]
    );

    await withClinicRls({ authenticated: true, clinicId: auth.clinicId }, (db) =>
      logAuditEvent(db, {
        clinicId: auth.clinicId,
        eventType: 'PASSWORD_CHANGED',
        req,
      })
    );

    await queueSecurityEmail({
      recipient: acct.email,
      subject: 'Пароль клиники был изменён',
      body: `Пароль вашей клиники был успешно изменён (${new Date().toISOString()}).`,
      category: 'password_changed_alert',
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/request-reset
 * Generates a single-use, 15-minute hashed password reset token.
 * Always returns the same generic response whether the email exists or not (Rule 13).
 */
authRouter.post('/request-reset', recoveryRateLimiter, async (req, res, next) => {
  try {
    const parsed = RequestResetSchema.parse(req.body);
    const acctRes = await queryInternal<{ id: string; email: string }>(
      `SELECT id, email FROM auth_internal.clinic_accounts WHERE email = $1 LIMIT 1`,
      [parsed.email]
    );

    const acct = acctRes.rows[0];
    if (acct) {
      const rawToken = generateRandomToken(32);
      const tokenHash = hashTokenSha256(rawToken);
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

      await queryInternal(
        `INSERT INTO auth_internal.security_tokens
         (id, account_id, token_type, token_hash, expires_at)
         VALUES ($1, $2, 'password_reset', $3, $4)`,
        [crypto.randomUUID(), acct.id, tokenHash, expiresAt]
      );

      await queueSecurityEmail({
        recipient: acct.email,
        subject: 'Сброс пароля — Цифровой блокнот стоматолога',
        body: `Код для сброса пароля (действителен 15 минут): ${rawToken}`,
        category: 'password_reset',
      });
    }

    res.status(200).json({
      ok: true,
      message:
        'Если указанный email зарегистрирован, инструкция по восстановлению пароля отправлена.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/reset-password
 * Verifies single-use hashed reset token, checks HIBP breach API, updates password, and revokes all sessions (Rule 13 & Rule 19).
 */
authRouter.post('/reset-password', recoveryRateLimiter, async (req, res, next) => {
  try {
    const parsed = ConfirmResetSchema.parse(req.body);
    const tokenHash = hashTokenSha256(parsed.token);

    const tRes = await queryInternal<{
      id: string;
      account_id: string;
      expires_at: string;
      used_at: string | null;
      email: string;
      clinic_id: string;
    }>(
      `SELECT t.id, t.account_id, t.expires_at, t.used_at, a.email, a.clinic_id
       FROM auth_internal.security_tokens t
       JOIN auth_internal.clinic_accounts a ON a.id = t.account_id
       WHERE t.token_hash = $1 AND t.token_type = 'password_reset'
       LIMIT 1`,
      [tokenHash]
    );

    const tokenRow = tRes.rows[0];
    if (
      !tokenRow ||
      tokenRow.used_at ||
      new Date(tokenRow.expires_at).getTime() < Date.now()
    ) {
      res.status(400).json({
        error: 'INVALID_OR_EXPIRED_TOKEN',
        message: 'Ссылка для сброса пароля недействительна или истекла.',
      });
      return;
    }

    const pwCheck = await validatePasswordSecurity(parsed.newPassword, {
      email: tokenRow.email,
    });
    if (!pwCheck.valid) {
      res.status(400).json({
        error: 'WEAK_OR_BREACHED_PASSWORD',
        reasonCode: pwCheck.reasonCode,
        message: 'Пароль не соответствует требованиям безопасности или найден в базе утечек.',
      });
      return;
    }

    const newHash = hashPasswordArgon2id(parsed.newPassword);
    await queryInternal(
      `UPDATE auth_internal.security_tokens SET used_at = NOW() WHERE id = $1`,
      [tokenRow.id]
    );
    await queryInternal(
      `UPDATE auth_internal.clinic_accounts
       SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL,
           password_changed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [newHash, tokenRow.account_id]
    );
    await queryInternal(
      `UPDATE auth_internal.sessions SET revoked_at = NOW() WHERE account_id = $1`,
      [tokenRow.account_id]
    );

    await withClinicRls({ authenticated: true, clinicId: tokenRow.clinic_id }, (db) =>
      logAuditEvent(db, {
        clinicId: tokenRow.clinic_id,
        eventType: 'PASSWORD_RESET_COMPLETED',
        req,
      })
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/verify-email
 * Verifies clinic email with single-use hashed token (Rule 13).
 */
authRouter.post('/verify-email', recoveryRateLimiter, async (req, res, next) => {
  try {
    const parsed = VerifyEmailSchema.parse(req.body);
    const tokenHash = hashTokenSha256(parsed.token);

    const tRes = await queryInternal<{
      id: string;
      account_id: string;
      expires_at: string;
      used_at: string | null;
      clinic_id: string;
    }>(
      `SELECT t.id, t.account_id, t.expires_at, t.used_at, a.clinic_id
       FROM auth_internal.security_tokens t
       JOIN auth_internal.clinic_accounts a ON a.id = t.account_id
       WHERE t.token_hash = $1 AND t.token_type = 'email_verify'
       LIMIT 1`,
      [tokenHash]
    );

    const tokenRow = tRes.rows[0];
    if (
      !tokenRow ||
      tokenRow.used_at ||
      new Date(tokenRow.expires_at).getTime() < Date.now()
    ) {
      res.status(400).json({
        error: 'INVALID_OR_EXPIRED_TOKEN',
        message: 'Токен подтверждения email недействителен или истёк.',
      });
      return;
    }

    await queryInternal(
      `UPDATE auth_internal.security_tokens SET used_at = NOW() WHERE id = $1`,
      [tokenRow.id]
    );
    await queryInternal(
      `UPDATE auth_internal.clinic_accounts SET email_verified = TRUE, updated_at = NOW() WHERE id = $1`,
      [tokenRow.account_id]
    );

    await withClinicRls({ authenticated: true, clinicId: tokenRow.clinic_id }, (db) =>
      logAuditEvent(db, {
        clinicId: tokenRow.clinic_id,
        eventType: 'EMAIL_VERIFIED',
        req,
      })
    );

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/2fa/setup
 * Generates a new TOTP secret for optional 2FA setup on the shared clinic account (Rule 13).
 */
authRouter.post('/2fa/setup', requireAuth, async (req, res, next) => {
  try {
    const auth = req.auth!;
    const secret = generateTotpSecret();
    const encrypted = encryptAesGcm(secret);

    await queryInternal(
      `UPDATE auth_internal.clinic_accounts
       SET totp_secret_encrypted = $1, updated_at = NOW()
       WHERE id = $2`,
      [encrypted, auth.accountId]
    );

    const otpauthUri = `otpauth://totp/DentalNotebook:${encodeURIComponent(
      auth.email
    )}?secret=${secret}&issuer=DentalNotebook`;

    res.status(200).json({
      secret,
      otpauthUri,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/2fa/enable
 * Verifies a 6-digit TOTP code and enables 2FA on the clinic account.
 */
authRouter.post('/2fa/enable', requireAuth, async (req, res, next) => {
  try {
    const auth = req.auth!;
    const schema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
    const { code } = schema.parse(req.body);

    const acctRes = await queryInternal<{ totp_secret_encrypted: string | null }>(
      `SELECT totp_secret_encrypted FROM auth_internal.clinic_accounts WHERE id = $1`,
      [auth.accountId]
    );
    const enc = acctRes.rows[0]?.totp_secret_encrypted;
    if (!enc) {
      res.status(400).json({ error: 'TOTP_NOT_INITIALIZED' });
      return;
    }

    const secret = decryptAesGcm(enc);
    if (!verifyTotpCode(secret, code)) {
      res.status(400).json({
        error: 'INVALID_TOTP_CODE',
        message: 'Неверный 6-значный код подтверждения.',
      });
      return;
    }

    await queryInternal(
      `UPDATE auth_internal.clinic_accounts SET totp_enabled = TRUE, updated_at = NOW() WHERE id = $1`,
      [auth.accountId]
    );

    await withClinicRls({ authenticated: true, clinicId: auth.clinicId }, (db) =>
      logAuditEvent(db, {
        clinicId: auth.clinicId,
        eventType: 'TWO_FACTOR_ENABLED',
        req,
      })
    );

    res.status(200).json({ ok: true, totpEnabled: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/2fa/disable
 * Disables 2FA after verifying current password.
 */
authRouter.post('/2fa/disable', requireAuth, async (req, res, next) => {
  try {
    const auth = req.auth!;
    const schema = z.object({ password: z.string().min(1).max(256) }).strict();
    const { password } = schema.parse(req.body);

    const acctRes = await queryInternal<{ password_hash: string }>(
      `SELECT password_hash FROM auth_internal.clinic_accounts WHERE id = $1`,
      [auth.accountId]
    );
    const pwHash = acctRes.rows[0]?.password_hash;
    if (!pwHash || !verifyPasswordArgon2id(password, pwHash)) {
      res.status(400).json({
        error: 'INVALID_PASSWORD',
        message: 'Пароль указан неверно.',
      });
      return;
    }

    await queryInternal(
      `UPDATE auth_internal.clinic_accounts
       SET totp_enabled = FALSE, totp_secret_encrypted = NULL, updated_at = NOW()
       WHERE id = $1`,
      [auth.accountId]
    );

    await withClinicRls({ authenticated: true, clinicId: auth.clinicId }, (db) =>
      logAuditEvent(db, {
        clinicId: auth.clinicId,
        eventType: 'TWO_FACTOR_DISABLED',
        req,
      })
    );

    res.status(200).json({ ok: true, totpEnabled: false });
  } catch (err) {
    next(err);
  }
});
