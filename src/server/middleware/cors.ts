import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

/**
 * Strict Origin Allow-List CORS Middleware (Rule 12).
 * NEVER sets Access-Control-Allow-Origin: *
 * Rejects cross-origin requests from unauthorized origins with 403.
 */
export function strictCorsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  // Same-origin requests (no Origin header) proceed normally
  if (!origin) {
    next();
    return;
  }

  const host = req.headers.host;
  const isSameHost =
    Boolean(host) && (origin === `https://${host}` || origin === `http://${host}`);

  const isAllowed = isSameHost || env.ALLOWED_ORIGINS.includes(origin);
  if (!isAllowed) {
    res.status(403).json({
      error: 'CORS_ORIGIN_FORBIDDEN',
      message: 'Cross-origin request blocked by strict origin policy.',
    });
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-CSRF-Token, X-Requested-With'
  );
  res.setHeader('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
}
