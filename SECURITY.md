# Security Policy & Architecture (`SECURITY.md`)

> **Important Legal Notice**: This application implements technical and organizational security controls for protecting clinical and personal data. However, deploying software alone does not automatically confer legal or regulatory compliance (such as compliance with the Law of the Republic of Kazakhstan "On Personal Data and Their Protection"). Clinic owners must complete operational, physical, contractual, and hosting requirements appropriate for their jurisdiction.

---

## 1. Security Controls Overview (20 Mandatory Rules)

1. **Zero Secrets in Git**: `.gitignore` blocks `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, and `service-account*.json`. Pre-commit hook (`.githooks/pre-commit`) and `scripts/secret-scan.mjs` + `.gitleaks.toml` scan before commits and in CI.
2. **Zero API Keys in Frontend**: Vite is configured with `envPrefix: 'PUBLIC_SAFE_'` and `sourcemap: false`. All secrets (`SESSION_SECRET`, `SIGNED_URL_SECRET`, `BACKUP_ENCRYPTION_KEY`, `WEBHOOK_SECRET`, `DATABASE_URL`) reside strictly on the server (`src/server/config/env.ts`).
3. **PostgreSQL Row-Level Security (RLS)**: Every table in `public` (`clinics`, `patients`, `visits`, `appointments`, `services`, `attachments`, `inventory_items`, `inventory_transactions`, `audit_events`) has `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. Queries execute inside a transaction under the least-privilege role `clinic_app_role` (`NOSUPERUSER`, no `DROP`/`ALTER`) with `app.user_authenticated` and `app.clinic_id` enforced by RLS policies.
4. **Server-Side Authorization**: `requireAuth` (`src/server/middleware/auth.ts`) validates the session token, account verification status, inactivity timeout, and CSRF token on every protected endpoint before entering the RLS transaction.
5. **Rate Limiting & Brute-Force Protection**: Tiered limiters (`globalApiRateLimiter`, `authRateLimiter`, `recoveryRateLimiter`, `searchRateLimiter`, `uploadRateLimiter`) plus progressive delay and temporary 15-minute IP + account lockout after 5 failed login attempts.
6. **Parameterized Queries Only**: 100% of SQL queries use `$1, $2, ...` prepared parameters. Dynamic column sets in `PATCH` handlers use compile-time `ALLOWED_COLUMNS` arrays.
7. **Strict Input Validation**: Every incoming body and query is validated with `zod` `.strict()` schemas (`src/shared/validation/schemas.ts`), including NFC Unicode normalization and Kazakhstan 12-digit IIN Modulo-11 checksum verification (`validateKzIin`).
8. **XSS & Header Hardening**: React renders all user strings as plain text. Print/PDF templates pass every dynamic value through `escapeHtml()` (`src/client/utils/print.ts`). `securityHeadersMiddleware` sets strict `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy: camera=(self)`, and `Strict-Transport-Security`.
9. **Argon2id Password Hashing & Schema Isolation**: Passwords are hashed using Argon2id (`src/server/security/crypto.ts`). Credentials and session hashes live in the `auth_internal` schema, which is completely revoked from `PUBLIC` and `clinic_app_role`.
10. **HttpOnly Cookie Sessions & Encrypted Offline Queue**: Session and refresh tokens use `HttpOnly; Secure; SameSite=Strict` cookies and require `X-CSRF-Token` on state-changing requests. No tokens are stored in `localStorage` or `sessionStorage`. Offline autosave drafts use Web Crypto `AES-GCM` in `IndexedDB` and are wiped on logout.
11. **Zero Unauthenticated Service/Admin Routes**: Probing `/admin`, `/debug`, `/swagger`, `/graphql`, `/metrics`, or `/api/docs` returns `401 Unauthorized`.
12. **Strict CORS Allow-List**: `strictCorsMiddleware` (`src/server/middleware/cors.ts`) checks `ALLOWED_ORIGINS` and blocks foreign origins with `403 Forbidden`.
13. **Verified Email, Recovery & Optional 2FA (TOTP)**: Unverified clinic accounts are blocked (`403 EMAIL_NOT_VERIFIED`). Single-use SHA-256 hashed tokens with 15-minute expiry handle email verification and password reset. Optional RFC 6238 TOTP 2FA is built in.
14. **UUID v4 Identifiers**: All primary keys and private storage filenames use `crypto.randomUUID()`.
15. **Mass Assignment Prevention**: Every `POST`/`PATCH` uses `.strict()` Zod validation plus explicit `ALLOWED_COLUMNS` field picking and optimistic concurrency (`expected_updated_at`).
16. **Authenticated Webhooks**: `/api/webhooks/events` verifies `X-Webhook-Signature` (HMAC-SHA256 over `timestamp.rawBody`), enforces a 5-minute replay window, and deduplicates `X-Webhook-Id`.
17. **Safe Error Handling & Log Redaction**: `globalErrorHandler` (`src/server/middleware/errorHandler.ts`) returns a short reference ID (`ERR-XXXXXX`) without stack traces or SQL errors, and redacts sensitive fields (`password`, `iin`, `phone`, `allergies`, `diagnosis`) in logs.
18. **Dependency Hygiene**: Locked dependencies (`package-lock.json`), `npm audit --audit-level=high` in CI, and `.github/dependabot.yml`.
19. **Have I Been Pwned (k-Anonymity) Breach Check**: `validatePasswordSecurity` (`src/server/security/passwordBreach.ts`) sends only the first 5 hex characters of the SHA-1 hash to `api.pwnedpasswords.com/range/` and falls back to a local blocklist if offline.
20. **Hardened File Uploads**: `validateAndSanitizeUploadedFile` (`src/server/security/fileValidator.ts`) checks extension allow-lists and binary magic bytes (`JPEG`, `PNG`, `WebP`, `HEIC`, `PDF`), rejects scripts/SVG/HTML/JS-in-PDF/EICAR, strips EXIF/GPS metadata from JPEG/PNG buffers, renames to random UUIDs in `PRIVATE_STORAGE_DIR`, and serves files only via short-lived HMAC-signed URLs with `nosniff` and `Content-Security-Policy: sandbox`.

---

## 2. Email Domain Security (SPF, DKIM, DMARC)

Before sending verification, password recovery, or login alert emails in production, configure these DNS records on your clinic's sending domain:

1. **SPF (`TXT` record on `@`)**:
   ```text
   v=spf1 include:_spf.your-mail-provider.example -all
   ```
2. **DKIM (`TXT` record on `<selector>._domainkey`)**:
   Enable 2048-bit RSA DKIM signing in your transactional email provider and publish the public key.
3. **DMARC (`TXT` record on `_dmarc`)**:
   ```text
   v=DMARC1; p=quarantine; rua=mailto:security@your-clinic-domain.kz; adkim=s; aspf=s
   ```

---

## 3. Secret Rotation & Incident Response

If any secret (`SESSION_SECRET`, `SIGNED_URL_SECRET`, `BACKUP_ENCRYPTION_KEY`, `WEBHOOK_SECRET`, or `DATABASE_URL`) is suspected of compromise:
1. Generate new 256-bit secrets:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Update the environment variables in your production secret manager.
3. Revoke all active sessions in PostgreSQL:
   ```sql
   UPDATE auth_internal.sessions SET revoked_at = NOW() WHERE revoked_at IS NULL;
   ```
4. Restart the server process.
