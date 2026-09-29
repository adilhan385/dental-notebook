import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

/**
 * Enforces strict HTTP security headers (Rule 8) and HTTPS redirect in production.
 */
export function securityHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  // HTTPS enforcement in production (behind reverse proxy or direct)
  if (
    env.IS_PROD &&
    req.headers['x-forwarded-proto'] &&
    req.headers['x-forwarded-proto'] !== 'https'
  ) {
    const host = req.headers.host || 'localhost';
    res.redirect(301, `https://${host}${req.originalUrl}`);
    return;
  }

  // Strict Content-Security-Policy (Rule 8)
  const cspDirectives = [
    "default-src 'self'",
    env.IS_PROD
      ? "script-src 'self'"
      : "script-src 'self' 'unsafe-inline'", // Vite HMR in dev
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  res.setHeader('Content-Security-Policy', cspDirectives);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Allow camera only for this origin (for taking dental photos on mobile/tablet)
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), microphone=(), geolocation=(), payment=(), usb=()'
  );
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=63072000; includeSubDomains; preload'
  );
  res.removeHeader('X-Powered-By');

  next();
}
