import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  CreateAppointmentSchema,
  UpdateAppointmentSchema,
  IsoDateSchema,
  UuidSchema,
} from '../../shared/validation/schemas.js';
import { requireAuth, runWithAuthenticatedRls } from '../middleware/auth.js';

export const appointmentsRouter = Router();

appointmentsRouter.use(requireAuth);

/**
 * GET /api/appointments?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Returns appointments in date range (for Day, Week, Month calendar views & Today's list).
 */
appointmentsRouter.get('/', async (req, res, next) => {
  try {
    const querySchema = z.object({
      from: IsoDateSchema,
      to: IsoDateSchema,
    });
    const { from, to } = querySchema.parse(req.query);

    const appointments = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `SELECT
           a.id,
           a.patient_id,
           p.full_name AS patient_name,
           p.phone AS patient_phone,
           p.allergies AS patient_allergies,
           a.appointment_date::text AS appointment_date,
           a.appointment_time,
           a.service_id,
           a.service_name_snapshot,
           a.estimated_price,
           a.comment,
           a.status,
           a.created_at,
           a.updated_at
         FROM public.appointments a
         JOIN public.patients p ON p.id = a.patient_id AND p.clinic_id = a.clinic_id
         WHERE a.clinic_id = $1
           AND a.appointment_date >= $2
           AND a.appointment_date <= $3
           AND p.archived_at IS NULL
         ORDER BY a.appointment_date ASC, a.appointment_time ASC
         LIMIT 200`,
        [auth.clinicId, from, to]
      );
      return r.rows;
    });

    res.status(200).json({ appointments });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/appointments
 * Create a new calendar appointment.
 */
appointmentsRouter.post('/', async (req, res, next) => {
  try {
    const parsed = CreateAppointmentSchema.parse(req.body);
    const id = crypto.randomUUID();

    const created = await runWithAuthenticatedRls(req, async (db, auth) => {
      const pCheck = await db.query<{ full_name: string; phone: string | null }>(
        `SELECT full_name, phone FROM public.patients WHERE id = $1 AND clinic_id = $2`,
        [parsed.patient_id, auth.clinicId]
      );
      if (!pCheck.rows[0]) return null;

      const r = await db.query(
        `INSERT INTO public.appointments
         (id, clinic_id, patient_id, appointment_date, appointment_time, service_id,
          service_name_snapshot, estimated_price, comment, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'scheduled')
         RETURNING id, patient_id, appointment_date::text AS appointment_date, appointment_time,
                   service_id, service_name_snapshot, estimated_price, comment, status,
                   created_at, updated_at`,
        [
          id,
          auth.clinicId,
          parsed.patient_id,
          parsed.appointment_date,
          parsed.appointment_time,
          parsed.service_id ?? null,
          parsed.service_name_snapshot ?? null,
          parsed.estimated_price ?? null,
          parsed.comment ?? null,
        ]
      );
      return {
        ...r.rows[0],
        patient_name: pCheck.rows[0].full_name,
        patient_phone: pCheck.rows[0].phone,
      };
    });

    if (!created) {
      res.status(404).json({ error: 'PATIENT_NOT_FOUND' });
      return;
    }

    res.status(201).json({ appointment: created });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/appointments/:id
 * Move/reschedule appointment (change date, time, service, comment, or status) with allow-list (Rule 15).
 */
appointmentsRouter.patch('/:id', async (req, res, next) => {
  try {
    const appointmentId = UuidSchema.parse(req.params.id);
    const parsed = UpdateAppointmentSchema.parse(req.body);

    const ALLOWED_COLUMNS = [
      'appointment_date',
      'appointment_time',
      'service_id',
      'service_name_snapshot',
      'estimated_price',
      'comment',
      'status',
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

    const updated = await runWithAuthenticatedRls(req, async (db, auth) => {
      values.push(appointmentId, auth.clinicId);
      const idIdx = paramIndex++;
      const clinicIdx = paramIndex++;

      const r = await db.query(
        `UPDATE public.appointments
         SET ${setClauses.join(', ')}
         WHERE id = $${idIdx} AND clinic_id = $${clinicIdx}
         RETURNING id, patient_id, appointment_date::text AS appointment_date, appointment_time,
                   service_id, service_name_snapshot, estimated_price, comment, status,
                   created_at, updated_at`,
        values
      );
      return r.rows[0];
    });

    if (!updated) {
      res.status(404).json({ error: 'APPOINTMENT_NOT_FOUND' });
      return;
    }

    res.status(200).json({ appointment: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/appointments/:id
 */
appointmentsRouter.delete('/:id', async (req, res, next) => {
  try {
    const appointmentId = UuidSchema.parse(req.params.id);
    const deleted = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `DELETE FROM public.appointments WHERE id = $1 AND clinic_id = $2 RETURNING id`,
        [appointmentId, auth.clinicId]
      );
      return r.rows[0];
    });
    if (!deleted) {
      res.status(404).json({ error: 'APPOINTMENT_NOT_FOUND' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
