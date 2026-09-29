import { Router } from 'express';
import crypto from 'node:crypto';
import {
  CreateVisitSchema,
  UpdateVisitSchema,
  PermanentDeleteSchema,
  UuidSchema,
} from '../../shared/validation/schemas.js';
import { requireAuth, runWithAuthenticatedRls, logAuditEvent } from '../middleware/auth.js';
import { signAttachmentDownloadUrl } from '../security/crypto.js';

export const visitsRouter = Router();

visitsRouter.use(requireAuth);

/**
 * POST /api/visits
 * Create a new treatment visit for a patient.
 */
visitsRouter.post('/', async (req, res, next) => {
  try {
    const parsed = CreateVisitSchema.parse(req.body);
    const id = crypto.randomUUID();
    const paymentDate =
      parsed.payment_status === 'paid'
        ? parsed.payment_date || parsed.visit_date
        : parsed.payment_date || null;

    const visit = await runWithAuthenticatedRls(req, async (db, auth) => {
      // Verify patient belongs to this clinic (IDOR prevention)
      const pCheck = await db.query(
        `SELECT id FROM public.patients WHERE id = $1 AND clinic_id = $2`,
        [parsed.patient_id, auth.clinicId]
      );
      if (!pCheck.rows[0]) return null;

      const r = await db.query(
        `INSERT INTO public.visits
         (id, clinic_id, patient_id, visit_date, visit_time, service_id, service_name_snapshot,
          price, payment_status, payment_date, doctor_name, complaints, diagnosis, treatment,
          recommendations, comments)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id, patient_id, visit_date::text AS visit_date, visit_time, service_id,
                   service_name_snapshot, price, payment_status, payment_date::text AS payment_date,
                   doctor_name, complaints, diagnosis, treatment, recommendations, comments,
                   archived_at, created_at, updated_at`,
        [
          id,
          auth.clinicId,
          parsed.patient_id,
          parsed.visit_date,
          parsed.visit_time ?? null,
          parsed.service_id ?? null,
          parsed.service_name_snapshot,
          parsed.price,
          parsed.payment_status,
          paymentDate,
          parsed.doctor_name ?? null,
          parsed.complaints ?? null,
          parsed.diagnosis ?? null,
          parsed.treatment ?? null,
          parsed.recommendations ?? null,
          parsed.comments ?? null,
        ]
      );
      return r.rows[0];
    });

    if (!visit) {
      res.status(404).json({ error: 'PATIENT_NOT_FOUND', message: 'Пациент не найден.' });
      return;
    }

    res.status(201).json({ visit });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/visits/:id
 * Detailed visit view with attached photos and files.
 */
visitsRouter.get('/:id', async (req, res, next) => {
  try {
    const visitId = UuidSchema.parse(req.params.id);

    const detail = await runWithAuthenticatedRls(req, async (db, auth) => {
      const vRes = await db.query(
        `SELECT v.id, v.patient_id, p.full_name AS patient_name,
                v.visit_date::text AS visit_date, v.visit_time, v.service_id,
                v.service_name_snapshot, v.price, v.payment_status,
                v.payment_date::text AS payment_date, v.doctor_name,
                v.complaints, v.diagnosis, v.treatment, v.recommendations, v.comments,
                v.archived_at, v.created_at, v.updated_at
         FROM public.visits v
         JOIN public.patients p ON p.id = v.patient_id AND p.clinic_id = v.clinic_id
         WHERE v.id = $1 AND v.clinic_id = $2
         LIMIT 1`,
        [visitId, auth.clinicId]
      );
      const visit = vRes.rows[0];
      if (!visit) return null;

      const aRes = await db.query(
        `SELECT id, patient_id, visit_id, file_name, file_type, file_size, created_at
         FROM public.attachments
         WHERE visit_id = $1 AND clinic_id = $2
         ORDER BY created_at DESC`,
        [visitId, auth.clinicId]
      );

      const attachments = aRes.rows.map((att) => ({
        ...att,
        download_url: signAttachmentDownloadUrl(att.id, auth.clinicId).url,
      }));

      return { visit, attachments };
    });

    if (!detail) {
      res.status(404).json({ error: 'VISIT_NOT_FOUND', message: 'Визит не найден.' });
      return;
    }

    res.status(200).json(detail);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/visits/:id
 * Update visit (including old visits) with explicit field allow-list (Rule 15) and conflict check.
 */
visitsRouter.patch('/:id', async (req, res, next) => {
  try {
    const visitId = UuidSchema.parse(req.params.id);
    const parsed = UpdateVisitSchema.parse(req.body);

    const ALLOWED_COLUMNS = [
      'visit_date',
      'visit_time',
      'service_id',
      'service_name_snapshot',
      'price',
      'payment_status',
      'payment_date',
      'doctor_name',
      'complaints',
      'diagnosis',
      'treatment',
      'recommendations',
      'comments',
    ] as const;

    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    for (const col of ALLOWED_COLUMNS) {
      if (col in parsed && parsed[col] !== undefined) {
        setClauses.push(`${col} = $${paramIndex++}`);
        values.push(parsed[col]);
      }
    }

    if (setClauses.length === 0) {
      res.status(400).json({ error: 'NO_FIELDS_TO_UPDATE' });
      return;
    }

    setClauses.push(`updated_at = NOW()`);

    const result = await runWithAuthenticatedRls(req, async (db, auth) => {
      const existingRes = await db.query<{ updated_at: string }>(
        `SELECT updated_at::text AS updated_at FROM public.visits WHERE id = $1 AND clinic_id = $2`,
        [visitId, auth.clinicId]
      );
      const existing = existingRes.rows[0];
      if (!existing) return { status: 'not_found' as const };

      if (
        parsed.expected_updated_at &&
        new Date(existing.updated_at).getTime() !==
          new Date(parsed.expected_updated_at).getTime()
      ) {
        return { status: 'conflict' as const, serverUpdatedAt: existing.updated_at };
      }

      values.push(visitId, auth.clinicId);
      const idIdx = paramIndex++;
      const clinicIdx = paramIndex++;

      const updRes = await db.query(
        `UPDATE public.visits
         SET ${setClauses.join(', ')}
         WHERE id = $${idIdx} AND clinic_id = $${clinicIdx}
         RETURNING id, patient_id, visit_date::text AS visit_date, visit_time, service_id,
                   service_name_snapshot, price, payment_status, payment_date::text AS payment_date,
                   doctor_name, complaints, diagnosis, treatment, recommendations, comments,
                   archived_at, created_at, updated_at`,
        values
      );
      return { status: 'ok' as const, visit: updRes.rows[0] };
    });

    if (result.status === 'not_found') {
      res.status(404).json({ error: 'VISIT_NOT_FOUND' });
      return;
    }
    if (result.status === 'conflict') {
      res.status(409).json({
        error: 'CONCURRENT_EDIT_CONFLICT',
        message: 'Запись о визите была изменена на другом устройстве.',
        serverUpdatedAt: result.serverUpdatedAt,
      });
      return;
    }

    res.status(200).json({ visit: result.visit });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/visits/:id/archive
 */
visitsRouter.post('/:id/archive', async (req, res, next) => {
  try {
    const visitId = UuidSchema.parse(req.params.id);
    const updated = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `UPDATE public.visits SET archived_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND clinic_id = $2 RETURNING id, archived_at`,
        [visitId, auth.clinicId]
      );
      return r.rows[0];
    });
    if (!updated) {
      res.status(404).json({ error: 'VISIT_NOT_FOUND' });
      return;
    }
    res.status(200).json({ ok: true, visit: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/visits/:id/restore
 */
visitsRouter.post('/:id/restore', async (req, res, next) => {
  try {
    const visitId = UuidSchema.parse(req.params.id);
    const updated = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `UPDATE public.visits SET archived_at = NULL, updated_at = NOW()
         WHERE id = $1 AND clinic_id = $2 RETURNING id, archived_at`,
        [visitId, auth.clinicId]
      );
      return r.rows[0];
    });
    if (!updated) {
      res.status(404).json({ error: 'VISIT_NOT_FOUND' });
      return;
    }
    res.status(200).json({ ok: true, visit: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/visits/:id/permanent
 */
visitsRouter.delete('/:id/permanent', async (req, res, next) => {
  try {
    const visitId = UuidSchema.parse(req.params.id);
    PermanentDeleteSchema.parse(req.body);

    const deleted = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `DELETE FROM public.visits WHERE id = $1 AND clinic_id = $2 RETURNING id`,
        [visitId, auth.clinicId]
      );
      if (r.rows[0]) {
        await logAuditEvent(db, {
          clinicId: auth.clinicId,
          eventType: 'VISIT_PERMANENT_DELETE',
          entityType: 'visit',
          entityId: visitId,
          req,
        });
      }
      return r.rows[0];
    });

    if (!deleted) {
      res.status(404).json({ error: 'VISIT_NOT_FOUND' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
