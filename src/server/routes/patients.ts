import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CreatePatientSchema,
  UpdatePatientSchema,
  PaginationQuerySchema,
  PermanentDeleteSchema,
  UuidSchema,
} from '../../shared/validation/schemas.js';
import { requireAuth, runWithAuthenticatedRls, logAuditEvent } from '../middleware/auth.js';
import { searchRateLimiter } from '../middleware/rateLimit.js';
import { maskIin } from '../middleware/errorHandler.js';
import { signAttachmentDownloadUrl } from '../security/crypto.js';
import { env } from '../config/env.js';

export const patientsRouter = Router();

// All patient routes require authenticated session (Rule 4 & Rule 11)
patientsRouter.use(requireAuth);

/**
 * GET /api/patients/search?q=...
 * Fast dynamic autocomplete search by full_name, IIN, or phone (Rule 5 & Rule 6).
 */
patientsRouter.get('/search', searchRateLimiter, async (req, res, next) => {
  try {
    const { q, limit } = PaginationQuerySchema.parse(req.query);
    const trimmed = (q || '').trim();
    if (!trimmed) {
      res.status(200).json({ results: [] });
      return;
    }

    const pattern = `%${trimmed.toLowerCase()}%`;
    const safeLimit = Math.min(limit, 20);

    const rows = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `SELECT id, full_name, iin, date_of_birth::text AS date_of_birth, phone, allergies, updated_at
         FROM public.patients
         WHERE clinic_id = $1
           AND archived_at IS NULL
           AND (
             lower(full_name) LIKE $2
             OR COALESCE(iin, '') LIKE $2
             OR COALESCE(lower(phone), '') LIKE $2
           )
         ORDER BY full_name ASC
         LIMIT $3`,
        [auth.clinicId, pattern, safeLimit]
      );
      return r.rows.map((p) => ({
        id: p.id,
        full_name: p.full_name,
        date_of_birth: p.date_of_birth,
        phone: p.phone,
        iin_masked: maskIin(p.iin),
        allergies: p.allergies,
        updated_at: p.updated_at,
      }));
    });

    res.status(200).json({ results: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/patients
 * Paginated list of active patients.
 */
patientsRouter.get('/', async (req, res, next) => {
  try {
    const { q, page, limit } = PaginationQuerySchema.parse(req.query);
    const offset = (page - 1) * limit;
    const pattern = q ? `%${q.toLowerCase()}%` : null;

    const data = await runWithAuthenticatedRls(req, async (db, auth) => {
      const whereSearch = pattern
        ? `AND (lower(p.full_name) LIKE $2 OR COALESCE(p.iin, '') LIKE $2 OR COALESCE(lower(p.phone), '') LIKE $2)`
        : '';
      const params: any[] = pattern
        ? [auth.clinicId, pattern, limit, offset]
        : [auth.clinicId, limit, offset];
      const limitIdx = pattern ? '$3' : '$2';
      const offsetIdx = pattern ? '$4' : '$3';

      const rowsRes = await db.query(
        `SELECT
           p.id,
           p.full_name,
           p.iin,
           p.date_of_birth::text AS date_of_birth,
           p.phone,
           p.allergies,
           p.medical_notes,
           p.additional_info,
           p.created_at,
           p.updated_at,
           COUNT(v.id) FILTER (WHERE v.archived_at IS NULL)::int AS visit_count,
           MAX(v.visit_date)::text AS last_visit_date
         FROM public.patients p
         LEFT JOIN public.visits v ON v.patient_id = p.id AND v.clinic_id = p.clinic_id
         WHERE p.clinic_id = $1 AND p.archived_at IS NULL ${whereSearch}
         GROUP BY p.id
         ORDER BY p.full_name ASC
         LIMIT ${limitIdx} OFFSET ${offsetIdx}`,
        params
      );

      const countRes = await db.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
         FROM public.patients p
         WHERE p.clinic_id = $1 AND p.archived_at IS NULL ${whereSearch}`,
        pattern ? [auth.clinicId, pattern] : [auth.clinicId]
      );

      return {
        patients: rowsRes.rows.map((p) => ({
          ...p,
          iin_masked: maskIin(p.iin),
        })),
        total: Number(countRes.rows[0]?.total || 0),
        page,
        limit,
      };
    });

    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/patients
 * Create a new patient (Rule 7 & Rule 15).
 */
patientsRouter.post('/', async (req, res, next) => {
  try {
    const parsed = CreatePatientSchema.parse(req.body);
    const id = crypto.randomUUID();

    const created = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `INSERT INTO public.patients
         (id, clinic_id, full_name, iin, date_of_birth, phone, allergies, medical_notes, additional_info)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, full_name, iin, date_of_birth::text AS date_of_birth, phone, allergies,
                   medical_notes, additional_info, archived_at, created_at, updated_at`,
        [
          id,
          auth.clinicId,
          parsed.full_name,
          parsed.iin ?? null,
          parsed.date_of_birth ?? null,
          parsed.phone ?? null,
          parsed.allergies ?? null,
          parsed.medical_notes ?? null,
          parsed.additional_info ?? null,
        ]
      );
      const row = r.rows[0];
      return { ...row, iin_masked: maskIin(row.iin) };
    });

    res.status(201).json({ patient: created });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/patients/:id
 * Full Patient Card: header details, summary metrics, treatment history, and signed attachments.
 */
patientsRouter.get('/:id', async (req, res, next) => {
  try {
    const patientId = UuidSchema.parse(req.params.id);

    const card = await runWithAuthenticatedRls(req, async (db, auth) => {
      const pRes = await db.query(
        `SELECT id, full_name, iin, date_of_birth::text AS date_of_birth, phone, allergies,
                medical_notes, additional_info, archived_at, created_at, updated_at
         FROM public.patients
         WHERE id = $1 AND clinic_id = $2
         LIMIT 1`,
        [patientId, auth.clinicId]
      );
      const patient = pRes.rows[0];
      if (!patient) return null;

      const vRes = await db.query(
        `SELECT id, patient_id, visit_date::text AS visit_date, visit_time, service_id,
                service_name_snapshot, price, payment_status, payment_date::text AS payment_date,
                doctor_name, complaints, diagnosis, treatment, recommendations, comments,
                archived_at, created_at, updated_at
         FROM public.visits
         WHERE patient_id = $1 AND clinic_id = $2 AND archived_at IS NULL
         ORDER BY visit_date DESC, COALESCE(visit_time, '00:00') DESC, created_at DESC`,
        [patientId, auth.clinicId]
      );

      const aRes = await db.query(
        `SELECT id, patient_id, visit_id, file_name, file_type, file_size, created_at
         FROM public.attachments
         WHERE patient_id = $1 AND clinic_id = $2
         ORDER BY created_at DESC`,
        [patientId, auth.clinicId]
      );

      const attachments = aRes.rows.map((att) => {
        const signed = signAttachmentDownloadUrl(att.id, auth.clinicId);
        return {
          ...att,
          download_url: signed.url,
          expires_at: signed.expires,
        };
      });

      const visits = vRes.rows;
      let totalServicesAmount = 0;
      let totalPaid = 0;
      let outstandingAmount = 0;
      for (const v of visits) {
        const price = Number(v.price || 0);
        totalServicesAmount += price;
        if (v.payment_status === 'paid') {
          totalPaid += price;
        } else {
          outstandingAmount += price;
        }
      }

      return {
        patient: {
          ...patient,
          iin_masked: maskIin(patient.iin),
        },
        summary: {
          visitCount: visits.length,
          totalServicesAmount,
          totalPaid,
          outstandingAmount,
        },
        visits,
        attachments,
      };
    });

    if (!card) {
      res.status(404).json({
        error: 'PATIENT_NOT_FOUND',
        message: 'Пациент не найден.',
      });
      return;
    }

    res.status(200).json(card);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/patients/:id
 * Update patient fields using an explicit allow-list (Rule 15: No mass assignment)
 * and optimistic concurrency check (`expected_updated_at`).
 */
patientsRouter.patch('/:id', async (req, res, next) => {
  try {
    const patientId = UuidSchema.parse(req.params.id);
    const parsed = UpdatePatientSchema.parse(req.body);

    const ALLOWED_COLUMNS = [
      'full_name',
      'iin',
      'date_of_birth',
      'phone',
      'allergies',
      'medical_notes',
      'additional_info',
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
      res.status(400).json({
        error: 'NO_FIELDS_TO_UPDATE',
        message: 'Не переданы поля для обновления.',
      });
      return;
    }

    setClauses.push(`updated_at = NOW()`);

    const result = await runWithAuthenticatedRls(req, async (db, auth) => {
      const existingRes = await db.query<{ updated_at: string }>(
        `SELECT updated_at::text AS updated_at FROM public.patients WHERE id = $1 AND clinic_id = $2`,
        [patientId, auth.clinicId]
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

      values.push(patientId, auth.clinicId);
      const idIdx = paramIndex++;
      const clinicIdx = paramIndex++;

      const updRes = await db.query(
        `UPDATE public.patients
         SET ${setClauses.join(', ')}
         WHERE id = $${idIdx} AND clinic_id = $${clinicIdx}
         RETURNING id, full_name, iin, date_of_birth::text AS date_of_birth, phone, allergies,
                   medical_notes, additional_info, archived_at, created_at, updated_at`,
        values
      );
      const row = updRes.rows[0];
      return {
        status: 'ok' as const,
        patient: { ...row, iin_masked: maskIin(row.iin) },
      };
    });

    if (result.status === 'not_found') {
      res.status(404).json({ error: 'PATIENT_NOT_FOUND', message: 'Пациент не найден.' });
      return;
    }
    if (result.status === 'conflict') {
      res.status(409).json({
        error: 'CONCURRENT_EDIT_CONFLICT',
        message:
          'Карточка пациента была изменена на другом устройстве. Обновите страницу для синхронизации.',
        serverUpdatedAt: result.serverUpdatedAt,
      });
      return;
    }

    res.status(200).json({ patient: result.patient });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/patients/:id/archive
 * Reversible soft-delete (archive) of a patient.
 */
patientsRouter.post('/:id/archive', async (req, res, next) => {
  try {
    const patientId = UuidSchema.parse(req.params.id);
    const updated = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `UPDATE public.patients
         SET archived_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND clinic_id = $2
         RETURNING id, full_name, archived_at`,
        [patientId, auth.clinicId]
      );
      if (r.rows[0]) {
        await logAuditEvent(db, {
          clinicId: auth.clinicId,
          eventType: 'PATIENT_ARCHIVED',
          entityType: 'patient',
          entityId: patientId,
          req,
        });
      }
      return r.rows[0];
    });

    if (!updated) {
      res.status(404).json({ error: 'PATIENT_NOT_FOUND' });
      return;
    }
    res.status(200).json({ ok: true, patient: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/patients/:id/restore
 * Easy 1-click restore from archive.
 */
patientsRouter.post('/:id/restore', async (req, res, next) => {
  try {
    const patientId = UuidSchema.parse(req.params.id);
    const updated = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `UPDATE public.patients
         SET archived_at = NULL, updated_at = NOW()
         WHERE id = $1 AND clinic_id = $2
         RETURNING id, full_name, archived_at`,
        [patientId, auth.clinicId]
      );
      if (r.rows[0]) {
        await logAuditEvent(db, {
          clinicId: auth.clinicId,
          eventType: 'PATIENT_RESTORED',
          entityType: 'patient',
          entityId: patientId,
          req,
        });
      }
      return r.rows[0];
    });

    if (!updated) {
      res.status(404).json({ error: 'PATIENT_NOT_FOUND' });
      return;
    }
    res.status(200).json({ ok: true, patient: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/patients/:id/permanent
 * Destructive permanent deletion requiring typed confirmation ("УДАЛИТЬ" / "ЖОЮ" / "DELETE").
 */
patientsRouter.delete('/:id/permanent', async (req, res, next) => {
  try {
    const patientId = UuidSchema.parse(req.params.id);
    PermanentDeleteSchema.parse(req.body);

    const deleted = await runWithAuthenticatedRls(req, async (db, auth) => {
      const attRes = await db.query<{ storage_path: string }>(
        `SELECT storage_path FROM public.attachments WHERE patient_id = $1 AND clinic_id = $2`,
        [patientId, auth.clinicId]
      );

      const delRes = await db.query(
        `DELETE FROM public.patients WHERE id = $1 AND clinic_id = $2 RETURNING id`,
        [patientId, auth.clinicId]
      );
      if (!delRes.rows[0]) return null;

      await logAuditEvent(db, {
        clinicId: auth.clinicId,
        eventType: 'PATIENT_PERMANENT_DELETE',
        entityType: 'patient',
        entityId: patientId,
        req,
      });

      return attRes.rows.map((a) => a.storage_path);
    });

    if (!deleted) {
      res.status(404).json({ error: 'PATIENT_NOT_FOUND' });
      return;
    }

    // Remove associated physical files from private storage
    for (const relPath of deleted) {
      const fullPath = path.resolve(env.PRIVATE_STORAGE_DIR, path.basename(relPath));
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // ignore file unlink error
        }
      }
    }

    res.status(200).json({ ok: true, permanentlyDeletedId: patientId });
  } catch (err) {
    next(err);
  }
});
