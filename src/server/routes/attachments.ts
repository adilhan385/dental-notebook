import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { UuidSchema, normalizeText } from '../../shared/validation/schemas.js';
import { requireAuth, runWithAuthenticatedRls, logAuditEvent } from '../middleware/auth.js';
import { uploadRateLimiter } from '../middleware/rateLimit.js';
import {
  validateAndSanitizeUploadedFile,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_PATIENT,
} from '../security/fileValidator.js';
import {
  signAttachmentDownloadUrl,
  verifyAttachmentSignature,
} from '../security/crypto.js';
import { env } from '../config/env.js';

export const attachmentsRouter = Router();

attachmentsRouter.use(requireAuth);

const UploadPayloadSchema = z
  .object({
    patient_id: UuidSchema,
    visit_id: UuidSchema.optional().nullable(),
    file_name: z.string().min(1).max(255),
    mime_type: z.string().max(100).optional(),
    content_base64: z.string().min(1),
  })
  .strict();

/**
 * POST /api/attachments/upload
 * Validates magic bytes, strips EXIF/GPS metadata, scans for malware/scripts,
 * renames to a random UUID, and stores in a private directory outside the web root (Rule 20).
 */
attachmentsRouter.post('/upload', uploadRateLimiter, async (req, res, next) => {
  try {
    const parsed = UploadPayloadSchema.parse(req.body);

    // Strip optional data URI prefix if present (e.g. data:image/jpeg;base64,...)
    const base64Clean = parsed.content_base64.includes(',')
      ? parsed.content_base64.split(',')[1]
      : parsed.content_base64;

    const rawBuffer = Buffer.from(base64Clean, 'base64');
    if (rawBuffer.length > MAX_FILE_SIZE_BYTES) {
      res.status(413).json({
        error: 'FILE_TOO_LARGE',
        message: 'Файл превышает максимальный допустимый размер (10 МБ).',
      });
      return;
    }

    const validation = validateAndSanitizeUploadedFile({
      originalFilename: parsed.file_name,
      declaredMime: parsed.mime_type,
      buffer: rawBuffer,
    });

    if (!validation.ok || !validation.sanitizedBuffer || !validation.storageFileName) {
      res.status(400).json({
        error: validation.error || 'INVALID_FILE_UPLOAD',
        message:
          'Файл отклонён проверкой безопасности. Разрешены только проверенные изображения (JPG, PNG, WebP, HEIC) и PDF без скриптов.',
      });
      return;
    }

    const attachmentId = crypto.randomUUID();

    const saved = await runWithAuthenticatedRls(req, async (db, auth) => {
      // Verify patient belongs to this clinic
      const pCheck = await db.query(
        `SELECT id FROM public.patients WHERE id = $1 AND clinic_id = $2`,
        [parsed.patient_id, auth.clinicId]
      );
      if (!pCheck.rows[0]) return { error: 'PATIENT_NOT_FOUND' as const };

      // Verify visit belongs to this patient & clinic if visit_id is provided
      if (parsed.visit_id) {
        const vCheck = await db.query(
          `SELECT id FROM public.visits WHERE id = $1 AND patient_id = $2 AND clinic_id = $3`,
          [parsed.visit_id, parsed.patient_id, auth.clinicId]
        );
        if (!vCheck.rows[0]) return { error: 'VISIT_NOT_FOUND' as const };
      }

      // Enforce maximum files per patient (Rule 20)
      const countRes = await db.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM public.attachments WHERE patient_id = $1 AND clinic_id = $2`,
        [parsed.patient_id, auth.clinicId]
      );
      if (Number(countRes.rows[0]?.cnt || 0) >= MAX_FILES_PER_PATIENT) {
        return { error: 'MAX_FILES_EXCEEDED' as const };
      }

      // Write sanitized buffer to private clinic bucket using random UUID filename
      const relativeStoragePath = `${auth.clinicId}/${validation.storageFileName}`;
      try {
        const clinicDir = path.resolve(env.PRIVATE_STORAGE_DIR, auth.clinicId);
        fs.mkdirSync(clinicDir, { recursive: true });
        const fullDiskPath = path.resolve(clinicDir, validation.storageFileName!);
        if (fullDiskPath.startsWith(path.resolve(env.PRIVATE_STORAGE_DIR))) {
          fs.writeFileSync(fullDiskPath, validation.sanitizedBuffer!, { mode: 0o600 });
        }
      } catch {
        // On read-only/serverless environments, database content_base64 is primary
      }

      const sanitizedBase64 = validation.sanitizedBuffer!.toString('base64');

      const insRes = await db.query(
        `INSERT INTO public.attachments
         (id, clinic_id, patient_id, visit_id, file_name, file_type, file_size, storage_path, sha256_checksum, content_base64)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, patient_id, visit_id, file_name, file_type, file_size, created_at`,
        [
          attachmentId,
          auth.clinicId,
          parsed.patient_id,
          parsed.visit_id ?? null,
          validation.safeOriginalName,
          validation.detectedMime,
          validation.sanitizedBuffer!.length,
          relativeStoragePath,
          validation.sha256,
          sanitizedBase64,
        ]
      );

      const row = insRes.rows[0];
      const signed = signAttachmentDownloadUrl(row.id, auth.clinicId);
      return {
        status: 'ok' as const,
        attachment: {
          ...row,
          download_url: signed.url,
          expires_at: signed.expires,
        },
      };
    });

    if ('error' in saved) {
      const code = saved.error === 'MAX_FILES_EXCEEDED' ? 400 : 404;
      res.status(code).json({ error: saved.error });
      return;
    }

    res.status(201).json({ attachment: saved.attachment });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/attachments/:id/download?expires=...&sig=...
 * Serves private files ONLY via short-lived HMAC-signed URLs after verifying clinic session & RLS (Rule 20).
 */
attachmentsRouter.get('/:id/download', async (req, res, next) => {
  try {
    const attachmentId = UuidSchema.parse(req.params.id);
    const expires = Number(req.query.expires);
    const sig = String(req.query.sig || '');
    const auth = req.auth!;

    if (!verifyAttachmentSignature(attachmentId, auth.clinicId, expires, sig)) {
      res.status(403).json({
        error: 'SIGNED_URL_INVALID_OR_EXPIRED',
        message: 'Ссылка на файл недействительна или истекла.',
      });
      return;
    }

    const att = await runWithAuthenticatedRls(req, async (db, a) => {
      const r = await db.query<{
        id: string;
        file_name: string;
        file_type: string;
        storage_path: string;
        content_base64: string | null;
      }>(
        `SELECT id, file_name, file_type, storage_path, content_base64
         FROM public.attachments
         WHERE id = $1 AND clinic_id = $2
         LIMIT 1`,
        [attachmentId, a.clinicId]
      );
      return r.rows[0];
    });

    if (!att) {
      res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
      return;
    }

    let fileBuffer: Buffer | null = null;
    const baseRoot = path.resolve(env.PRIVATE_STORAGE_DIR);
    const fullDiskPath = path.resolve(baseRoot, att.storage_path);
    if (fullDiskPath.startsWith(baseRoot) && fs.existsSync(fullDiskPath)) {
      fileBuffer = fs.readFileSync(fullDiskPath);
    } else if (att.content_base64) {
      fileBuffer = Buffer.from(att.content_base64, 'base64');
    }

    if (!fileBuffer) {
      res.status(404).json({ error: 'ATTACHMENT_FILE_MISSING' });
      return;
    }
    const safeName = att.file_name.replace(/["\\\r\n]/g, '_');

    // Rule 20: Serve with strict nosniff, sandbox CSP, and Content-Disposition
    res.setHeader('Content-Type', att.file_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(safeName)}"`
    );
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.status(200).send(fileBuffer);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/attachments/:id
 * Edit attachment display name metadata (Rule 15: strict allow-list).
 */
attachmentsRouter.patch('/:id', async (req, res, next) => {
  try {
    const attachmentId = UuidSchema.parse(req.params.id);
    const schema = z
      .object({
        file_name: z.string().transform(normalizeText).pipe(z.string().min(1).max(120)),
      })
      .strict();
    const { file_name } = schema.parse(req.body);

    const updated = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `UPDATE public.attachments
         SET file_name = $1
         WHERE id = $2 AND clinic_id = $3
         RETURNING id, patient_id, visit_id, file_name, file_type, file_size, created_at`,
        [file_name, attachmentId, auth.clinicId]
      );
      return r.rows[0];
    });

    if (!updated) {
      res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
      return;
    }
    res.status(200).json({ attachment: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/attachments/:id
 */
attachmentsRouter.delete('/:id', async (req, res, next) => {
  try {
    const attachmentId = UuidSchema.parse(req.params.id);
    const deleted = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query<{ id: string; storage_path: string }>(
        `DELETE FROM public.attachments WHERE id = $1 AND clinic_id = $2 RETURNING id, storage_path`,
        [attachmentId, auth.clinicId]
      );
      if (r.rows[0]) {
        await logAuditEvent(db, {
          clinicId: auth.clinicId,
          eventType: 'ATTACHMENT_DELETED',
          entityType: 'attachment',
          entityId: attachmentId,
          req,
        });
      }
      return r.rows[0];
    });

    if (!deleted) {
      res.status(404).json({ error: 'ATTACHMENT_NOT_FOUND' });
      return;
    }

    const baseRoot = path.resolve(env.PRIVATE_STORAGE_DIR);
    const fullDiskPath = path.resolve(baseRoot, deleted.storage_path);
    if (fullDiskPath.startsWith(baseRoot) && fs.existsSync(fullDiskPath)) {
      try {
        fs.unlinkSync(fullDiskPath);
      } catch {
        // ignore
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
