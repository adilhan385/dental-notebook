import express, { type Request } from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { securityHeadersMiddleware } from './middleware/securityHeaders.js';
import { strictCorsMiddleware } from './middleware/cors.js';
import { globalApiRateLimiter } from './middleware/rateLimit.js';
import { globalErrorHandler } from './middleware/errorHandler.js';
import { verifyWebhookSignature } from './middleware/webhookVerify.js';
import { authRouter } from './routes/auth.js';
import { patientsRouter } from './routes/patients.js';
import { visitsRouter } from './routes/visits.js';
import { appointmentsRouter } from './routes/appointments.js';
import { attachmentsRouter } from './routes/attachments.js';
import { financesRouter } from './routes/finances.js';
import { inventoryRouter } from './routes/inventory.js';
import { archiveRouter } from './routes/archive.js';
import { settingsRouter } from './routes/settings.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  // 1. Security Headers (CSP, HSTS, X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Permissions-Policy)
  app.use(securityHeadersMiddleware);

  // 2. Strict Origin Allow-List CORS (Rule 12: never *)
  app.use(strictCorsMiddleware);

  // 3. Cookie Parser for HttpOnly session/refresh cookies (Rule 10)
  app.use(cookieParser());

  // 4. Request body size limits (Rule 5):
  // - 15MB only for base64 file uploads on /api/attachments/upload
  // - Strict 256KB limit on all other JSON endpoints
  app.use('/api/attachments/upload', express.json({ limit: '15mb' }));
  app.use(
    express.json({
      limit: '256kb',
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        if (req.originalUrl.startsWith('/api/webhooks')) {
          req.rawBody = Buffer.from(buf);
        }
      },
    })
  );

  // 5. Rule 11: Explicitly block any probing of debug / admin / swagger / metrics endpoints
  const forbiddenServicePaths = [
    '/admin',
    '/debug',
    '/api/docs',
    '/swagger',
    '/graphql',
    '/phpinfo',
    '/metrics',
  ];
  app.use(forbiddenServicePaths, (_req, res) => {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authentication required.',
    });
  });

  // 6. Global API Rate Limiter (Rule 5)
  app.use('/api', globalApiRateLimiter);

  // 7. API Routes
  app.use('/api/auth', authRouter);
  app.use('/api/patients', patientsRouter);
  app.use('/api/visits', visitsRouter);
  app.use('/api/appointments', appointmentsRouter);
  app.use('/api/attachments', attachmentsRouter);
  app.use('/api/finances', financesRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api/archive', archiveRouter);
  app.use('/api/settings', settingsRouter);

  // 8. Signature-Verified Webhook Endpoint (Rule 16)
  app.post('/api/webhooks/events', verifyWebhookSignature, (_req, res) => {
    res.status(200).json({ received: true });
  });

  // Unknown /api/* route handler
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'ENDPOINT_NOT_FOUND' });
  });

  // Serve built static frontend in production
  const clientDist = path.resolve(process.cwd(), 'dist', 'client');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*splat', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  // 9. Global Safe Error Handler (Rule 17)
  app.use(globalErrorHandler);

  return app;
}
