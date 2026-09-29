import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { safeCompareStrings } from '../security/crypto.js';

const processedWebhookIds = new Map<string, number>();
const REPLAY_WINDOW_SECONDS = 300; // 5 minutes max clock skew

/**
 * Verifies HMAC-SHA256 webhook signature over raw body + timestamp and prevents replays (Rule 16).
 */
export function verifyWebhookSignature(
  req: Request & { rawBody?: Buffer },
  res: Response,
  next: NextFunction
): void {
  const signatureHeader = req.headers['x-webhook-signature'];
  const timestampHeader = req.headers['x-webhook-timestamp'];
  const eventIdHeader = req.headers['x-webhook-id'];

  if (
    typeof signatureHeader !== 'string' ||
    typeof timestampHeader !== 'string' ||
    typeof eventIdHeader !== 'string'
  ) {
    res.status(401).json({
      error: 'WEBHOOK_UNSIGNED',
      message: 'Missing required webhook signature headers.',
    });
    return;
  }

  const tsSec = Number(timestampHeader);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tsSec) || Math.abs(nowSec - tsSec) > REPLAY_WINDOW_SECONDS) {
    res.status(401).json({
      error: 'WEBHOOK_TIMESTAMP_EXPIRED',
      message: 'Webhook timestamp outside acceptable replay window.',
    });
    return;
  }

  // Idempotency check
  const existing = processedWebhookIds.get(eventIdHeader);
  if (existing && nowSec - existing < 3600) {
    res.status(200).json({ status: 'duplicate_ignored' });
    return;
  }

  const rawBodyStr = req.rawBody
    ? req.rawBody.toString('utf8')
    : JSON.stringify(req.body || {});
  const signedPayload = `${tsSec}.${rawBodyStr}`;
  const expectedSig = crypto
    .createHmac('sha256', env.WEBHOOK_SECRET)
    .update(signedPayload)
    .digest('hex');

  if (!safeCompareStrings(expectedSig, signatureHeader)) {
    res.status(401).json({
      error: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'Invalid webhook HMAC signature.',
    });
    return;
  }

  processedWebhookIds.set(eventIdHeader, nowSec);
  next();
}
