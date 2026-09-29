import { Router } from 'express';
import { PaginationQuerySchema } from '../../shared/validation/schemas.js';
import { requireAuth, runWithAuthenticatedRls } from '../middleware/auth.js';
import { maskIin } from '../middleware/errorHandler.js';

export const archiveRouter = Router();

archiveRouter.use(requireAuth);

/**
 * GET /api/archive?q=...
 * Returns archived patients and archived visits for search, restoration, or permanent deletion.
 */
archiveRouter.get('/', async (req, res, next) => {
  try {
    const { q, limit } = PaginationQuerySchema.parse(req.query);
    const pattern = q ? `%${q.toLowerCase()}%` : null;

    const data = await runWithAuthenticatedRls(req, async (db, auth) => {
      const pWhere = pattern
        ? `AND (lower(full_name) LIKE $2 OR COALESCE(iin, '') LIKE $2 OR COALESCE(lower(phone), '') LIKE $2)`
        : '';
      const pParams: any[] = pattern ? [auth.clinicId, pattern, limit] : [auth.clinicId, limit];
      const pLimitIdx = pattern ? '$3' : '$2';

      const patientsRes = await db.query(
        `SELECT id, full_name, iin, date_of_birth::text AS date_of_birth, phone,
                archived_at, created_at
         FROM public.patients
         WHERE clinic_id = $1 AND archived_at IS NOT NULL ${pWhere}
         ORDER BY archived_at DESC
         LIMIT ${pLimitIdx}`,
        pParams
      );

      const vWhere = pattern
        ? `AND (lower(p.full_name) LIKE $2 OR lower(v.service_name_snapshot) LIKE $2)`
        : '';

      const visitsRes = await db.query(
        `SELECT v.id, v.patient_id, p.full_name AS patient_name,
                v.visit_date::text AS visit_date, v.service_name_snapshot,
                v.price, v.payment_status, v.archived_at
         FROM public.visits v
         JOIN public.patients p ON p.id = v.patient_id AND p.clinic_id = v.clinic_id
         WHERE v.clinic_id = $1 AND v.archived_at IS NOT NULL ${vWhere}
         ORDER BY v.archived_at DESC
         LIMIT ${pLimitIdx}`,
        pParams
      );

      return {
        archivedPatients: patientsRes.rows.map((p) => ({
          ...p,
          iin_masked: maskIin(p.iin),
        })),
        archivedVisits: visitsRes.rows,
      };
    });

    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
});
