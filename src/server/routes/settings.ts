import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CreateServiceSchema,
  UpdateServiceSchema,
  ClinicSettingsUpdateSchema,
  UuidSchema,
} from '../../shared/validation/schemas.js';
import { requireAuth, runWithAuthenticatedRls, logAuditEvent } from '../middleware/auth.js';
import { encryptAesGcm, decryptAesGcm } from '../security/crypto.js';
import { env } from '../config/env.js';

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

/**
 * GET /api/settings/services
 * Returns all clinic services (standard service price reference).
 */
settingsRouter.get('/services', async (req, res, next) => {
  try {
    const services = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `SELECT id, name_ru, name_kz, name_en, reference_price, active, created_at, updated_at
         FROM public.services
         WHERE clinic_id = $1
         ORDER BY active DESC, lower(name_ru) ASC
         LIMIT 200`,
        [auth.clinicId]
      );
      return r.rows;
    });
    res.status(200).json({ services });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/settings/services
 * Add a service to the standard price reference catalog.
 */
settingsRouter.post('/services', async (req, res, next) => {
  try {
    const parsed = CreateServiceSchema.parse(req.body);
    const id = crypto.randomUUID();

    const service = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `INSERT INTO public.services
         (id, clinic_id, name_ru, name_kz, name_en, reference_price, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name_ru, name_kz, name_en, reference_price, active, created_at, updated_at`,
        [
          id,
          auth.clinicId,
          parsed.name_ru,
          parsed.name_kz,
          parsed.name_en,
          parsed.reference_price ?? null,
          parsed.active,
        ]
      );
      return r.rows[0];
    });

    res.status(201).json({ service });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/settings/services/:id
 * Update service name or standard reference price (explicit allow-list per Rule 15).
 */
settingsRouter.patch('/services/:id', async (req, res, next) => {
  try {
    const serviceId = UuidSchema.parse(req.params.id);
    const parsed = UpdateServiceSchema.parse(req.body);

    const ALLOWED_COLUMNS = [
      'name_ru',
      'name_kz',
      'name_en',
      'reference_price',
      'active',
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

    const service = await runWithAuthenticatedRls(req, async (db, auth) => {
      values.push(serviceId, auth.clinicId);
      const idIdx = paramIndex++;
      const clinicIdx = paramIndex++;
      const r = await db.query(
        `UPDATE public.services
         SET ${setClauses.join(', ')}
         WHERE id = $${idIdx} AND clinic_id = $${clinicIdx}
         RETURNING id, name_ru, name_kz, name_en, reference_price, active, created_at, updated_at`,
        values
      );
      return r.rows[0];
    });

    if (!service) {
      res.status(404).json({ error: 'SERVICE_NOT_FOUND' });
      return;
    }
    res.status(200).json({ service });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/settings/clinic
 * Update clinic basic info (name, phone, subtitle, default_language).
 */
settingsRouter.patch('/clinic', async (req, res, next) => {
  try {
    const parsed = ClinicSettingsUpdateSchema.parse(req.body);
    const ALLOWED_COLUMNS = ['name', 'phone', 'subtitle', 'default_language'] as const;

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

    const clinic = await runWithAuthenticatedRls(req, async (db, auth) => {
      values.push(auth.clinicId);
      const idIdx = paramIndex++;
      const r = await db.query(
        `UPDATE public.clinics
         SET ${setClauses.join(', ')}
         WHERE id = $${idIdx}
         RETURNING id, name, phone, subtitle, default_language, updated_at`,
        values
      );
      return r.rows[0];
    });

    res.status(200).json({ clinic });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/settings/audit-logs
 * View recent clinic security & destructive action audit events.
 */
settingsRouter.get('/audit-logs', async (req, res, next) => {
  try {
    const events = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `SELECT id, event_type, entity_type, entity_id, ip_address, metadata, created_at
         FROM public.audit_events
         WHERE clinic_id = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [auth.clinicId]
      );
      return r.rows;
    });
    res.status(200).json({ events });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/settings/audit-print
 * Logs print / PDF export actions to the audit log (Additional Security Baseline).
 */
settingsRouter.post('/audit-print', async (req, res, next) => {
  try {
    const schema = z
      .object({
        documentType: z.enum(['patient_card', 'visit_detail', 'finance_summary']),
        entityId: UuidSchema.optional().nullable(),
      })
      .strict();
    const parsed = schema.parse(req.body);

    await runWithAuthenticatedRls(req, async (db, auth) => {
      await logAuditEvent(db, {
        clinicId: auth.clinicId,
        eventType: 'DATA_EXPORT_PRINT',
        entityType: parsed.documentType,
        entityId: parsed.entityId || null,
        req,
      });
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/settings/backup
 * Creates an AES-256-GCM encrypted backup snapshot of all clinic data and verifies round-trip decryption.
 */
settingsRouter.post('/backup', async (req, res, next) => {
  try {
    const backupMeta = await runWithAuthenticatedRls(req, async (db, auth) => {
      const [clinics, patients, visits, appointments, services, inventory, transactions] =
        await Promise.all([
          db.query(`SELECT * FROM public.clinics WHERE id = $1`, [auth.clinicId]),
          db.query(`SELECT * FROM public.patients WHERE clinic_id = $1`, [auth.clinicId]),
          db.query(`SELECT * FROM public.visits WHERE clinic_id = $1`, [auth.clinicId]),
          db.query(`SELECT * FROM public.appointments WHERE clinic_id = $1`, [auth.clinicId]),
          db.query(`SELECT * FROM public.services WHERE clinic_id = $1`, [auth.clinicId]),
          db.query(`SELECT * FROM public.inventory_items WHERE clinic_id = $1`, [auth.clinicId]),
          db.query(`SELECT * FROM public.inventory_transactions WHERE clinic_id = $1`, [
            auth.clinicId,
          ]),
        ]);

      const payload = JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        clinicId: auth.clinicId,
        data: {
          clinic: clinics.rows[0],
          patients: patients.rows,
          visits: visits.rows,
          appointments: appointments.rows,
          services: services.rows,
          inventoryItems: inventory.rows,
          inventoryTransactions: transactions.rows,
        },
      });

      const encrypted = encryptAesGcm(payload);
      // Verify round-trip decryptability immediately (Additional Security Baseline: restore tested)
      const verifiedPlain = decryptAesGcm(encrypted);
      const parsedVerify = JSON.parse(verifiedPlain);
      if (parsedVerify.clinicId !== auth.clinicId) {
        throw new Error('BACKUP_VERIFICATION_FAILED');
      }

      fs.mkdirSync(env.BACKUP_DIR, { recursive: true });
      const fileName = `backup-${auth.clinicId}-${Date.now()}.enc`;
      const fullPath = path.resolve(env.BACKUP_DIR, fileName);
      fs.writeFileSync(fullPath, encrypted, { mode: 0o600 });

      await logAuditEvent(db, {
        clinicId: auth.clinicId,
        eventType: 'ENCRYPTED_BACKUP_CREATED',
        req,
        metadata: {
          fileName,
          patientsCount: patients.rows.length,
          visitsCount: visits.rows.length,
          restoreVerified: true,
        },
      });

      return {
        fileName,
        createdAt: parsedVerify.createdAt,
        counts: {
          patients: patients.rows.length,
          visits: visits.rows.length,
          appointments: appointments.rows.length,
          inventoryItems: inventory.rows.length,
        },
        restoreVerified: true,
      };
    });

    res.status(201).json({ backup: backupMeta });
  } catch (err) {
    next(err);
  }
});
