import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { ZodError } from 'zod';

const SENSITIVE_KEYS = new Set([
  'password',
  'currentPassword',
  'newPassword',
  'password_hash',
  'token',
  'csrfToken',
  'totpCode',
  'totp_secret',
  'iin',
  'phone',
  'allergies',
  'diagnosis',
  'treatment',
  'complaints',
  'medical_notes',
]);

/**
 * Recursively masks sensitive fields before writing any object to server logs (Rule 17).
 */
export function maskSensitiveObject(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(maskSensitiveObject);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object') {
      out[k] = maskSensitiveObject(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Masks a 12-digit IIN for safe display (e.g. 880415****18).
 */
export function maskIin(iin: string | null | undefined): string | null {
  if (!iin || iin.length < 12) return iin || null;
  return `${iin.slice(0, 6)}****${iin.slice(10)}`;
}

/**
 * Global server error handler (Rule 17).
 * Never exposes stack traces, SQL, table names, file paths, or raw exception text to the client.
 */
export function globalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Handle strict Zod validation errors cleanly with 400
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: 'One or more fields failed validation.',
      issues: err.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  // Handle oversized payload errors from express.json
  if (
    err &&
    typeof err === 'object' &&
    'type' in err &&
    (err as { type?: string }).type === 'entity.too.large'
  ) {
    res.status(413).json({
      error: 'PAYLOAD_TOO_LARGE',
      message: 'Request body exceeds maximum allowed size.',
    });
    return;
  }

  const refId = `ERR-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  // Log technical error ONLY on server with sensitive fields redacted
  const errName = err instanceof Error ? err.name : 'UnknownError';
  const errMsg = err instanceof Error ? err.message : 'Unexpected failure';
  console.error(
    JSON.stringify({
      level: 'error',
      refId,
      method: req.method,
      path: req.originalUrl,
      errorName: errName,
      // Mask any accidental 12-digit IIN in error message
      errorMessage: errMsg.replace(/\b\d{12}\b/g, '[REDACTED_IIN]'),
      timestamp: new Date().toISOString(),
    })
  );

  res.status(500).json({
    error: 'INTERNAL_SERVER_ERROR',
    refId,
    message:
      'Произошла внутренняя ошибка сервера. Ваши данные в безопасности, попробуйте ещё раз.',
  });
}
