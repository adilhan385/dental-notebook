import { Router } from 'express';
import { z } from 'zod';
import { IsoDateSchema } from '../../shared/validation/schemas.js';
import { requireAuth, runWithAuthenticatedRls } from '../middleware/auth.js';

export const financesRouter = Router();

financesRouter.use(requireAuth);

/**
 * GET /api/finances/summary?from=YYYY-MM-DD&to=YYYY-MM-DD&status=all|paid|unpaid
 * Lightweight period financial metrics and visit breakdown.
 */
financesRouter.get('/summary', async (req, res, next) => {
  try {
    const querySchema = z.object({
      from: IsoDateSchema,
      to: IsoDateSchema,
      status: z.enum(['all', 'paid', 'unpaid']).optional().default('all'),
    });
    const { from, to, status } = querySchema.parse(req.query);

    const data = await runWithAuthenticatedRls(req, async (db, auth) => {
      const metricsRes = await db.query<{
        visit_count: number;
        total_services: string;
        total_paid: string;
        total_unpaid: string;
      }>(
        `SELECT
           COUNT(*)::int AS visit_count,
           COALESCE(SUM(price), 0)::text AS total_services,
           COALESCE(SUM(price) FILTER (WHERE payment_status = 'paid'), 0)::text AS total_paid,
           COALESCE(SUM(price) FILTER (WHERE payment_status = 'unpaid'), 0)::text AS total_unpaid
         FROM public.visits
         WHERE clinic_id = $1
           AND archived_at IS NULL
           AND visit_date >= $2
           AND visit_date <= $3`,
        [auth.clinicId, from, to]
      );

      const m = metricsRes.rows[0];
      const statusClause =
        status === 'paid'
          ? `AND v.payment_status = 'paid'`
          : status === 'unpaid'
          ? `AND v.payment_status = 'unpaid'`
          : '';

      const visitsRes = await db.query(
        `SELECT
           v.id,
           v.patient_id,
           p.full_name AS patient_name,
           v.visit_date::text AS visit_date,
           v.visit_time,
           v.service_name_snapshot,
           v.price,
           v.payment_status,
           v.payment_date::text AS payment_date,
           v.doctor_name
         FROM public.visits v
         JOIN public.patients p ON p.id = v.patient_id AND p.clinic_id = v.clinic_id
         WHERE v.clinic_id = $1
           AND v.archived_at IS NULL
           AND p.archived_at IS NULL
           AND v.visit_date >= $2
           AND v.visit_date <= $3
           ${statusClause}
         ORDER BY v.visit_date DESC, COALESCE(v.visit_time, '00:00') DESC
         LIMIT 200`,
        [auth.clinicId, from, to]
      );

      return {
        period: { from, to },
        summary: {
          visitCount: Number(m?.visit_count || 0),
          totalServicesAmount: Number(m?.total_services || 0),
          totalPaid: Number(m?.total_paid || 0),
          unpaidAmount: Number(m?.total_unpaid || 0),
        },
        visits: visitsRes.rows,
      };
    });

    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
});
