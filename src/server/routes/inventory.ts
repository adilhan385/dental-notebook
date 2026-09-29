import { Router } from 'express';
import crypto from 'node:crypto';
import {
  CreateInventoryItemSchema,
  UpdateInventoryItemSchema,
  CreateInventoryTransactionSchema,
  UuidSchema,
} from '../../shared/validation/schemas.js';
import { requireAuth, runWithAuthenticatedRls } from '../middleware/auth.js';

export const inventoryRouter = Router();

inventoryRouter.use(requireAuth);

/**
 * GET /api/inventory
 * Returns all stock items with low-stock warning flags and recent transactions.
 */
inventoryRouter.get('/', async (req, res, next) => {
  try {
    const data = await runWithAuthenticatedRls(req, async (db, auth) => {
      const itemsRes = await db.query(
        `SELECT
           id,
           name,
           category,
           quantity::float AS quantity,
           unit,
           purchase_price,
           minimum_stock::float AS minimum_stock,
           expiration_date::text AS expiration_date,
           created_at,
           updated_at
         FROM public.inventory_items
         WHERE clinic_id = $1
         ORDER BY lower(name) ASC
         LIMIT 250`,
        [auth.clinicId]
      );

      const txRes = await db.query(
        `SELECT
           t.id,
           t.inventory_item_id,
           i.name AS item_name,
           i.unit AS item_unit,
           t.type,
           t.quantity::float AS quantity,
           t.transaction_date::text AS transaction_date,
           t.comment,
           t.created_at
         FROM public.inventory_transactions t
         JOIN public.inventory_items i ON i.id = t.inventory_item_id AND i.clinic_id = t.clinic_id
         WHERE t.clinic_id = $1
         ORDER BY t.transaction_date DESC, t.created_at DESC
         LIMIT 100`,
        [auth.clinicId]
      );

      const items = itemsRes.rows.map((item) => ({
        ...item,
        is_low_stock:
          item.minimum_stock !== null &&
          item.minimum_stock !== undefined &&
          Number(item.quantity) <= Number(item.minimum_stock),
      }));

      return { items, transactions: txRes.rows };
    });

    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/inventory/items
 * Add a new material/item to inventory.
 */
inventoryRouter.post('/items', async (req, res, next) => {
  try {
    const parsed = CreateInventoryItemSchema.parse(req.body);
    const id = crypto.randomUUID();
    const today = new Date().toISOString().slice(0, 10);

    const item = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `INSERT INTO public.inventory_items
         (id, clinic_id, name, category, quantity, unit, purchase_price, minimum_stock, expiration_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, name, category, quantity::float AS quantity, unit, purchase_price,
                   minimum_stock::float AS minimum_stock, expiration_date::text AS expiration_date,
                   created_at, updated_at`,
        [
          id,
          auth.clinicId,
          parsed.name,
          parsed.category ?? null,
          parsed.quantity,
          parsed.unit,
          parsed.purchase_price ?? null,
          parsed.minimum_stock ?? null,
          parsed.expiration_date ?? null,
        ]
      );

      if (parsed.quantity > 0) {
        await db.query(
          `INSERT INTO public.inventory_transactions
           (id, clinic_id, inventory_item_id, type, quantity, transaction_date, comment)
           VALUES ($1, $2, $3, 'incoming', $4, $5, 'Начальный остаток')`,
          [crypto.randomUUID(), auth.clinicId, id, parsed.quantity, today]
        );
      }

      return r.rows[0];
    });

    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/inventory/items/:id
 * Update inventory item metadata (explicit allow-list per Rule 15).
 */
inventoryRouter.patch('/items/:id', async (req, res, next) => {
  try {
    const itemId = UuidSchema.parse(req.params.id);
    const parsed = UpdateInventoryItemSchema.parse(req.body);

    const ALLOWED_COLUMNS = [
      'name',
      'category',
      'unit',
      'purchase_price',
      'minimum_stock',
      'expiration_date',
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
      values.push(itemId, auth.clinicId);
      const idIdx = paramIndex++;
      const clinicIdx = paramIndex++;
      const r = await db.query(
        `UPDATE public.inventory_items
         SET ${setClauses.join(', ')}
         WHERE id = $${idIdx} AND clinic_id = $${clinicIdx}
         RETURNING id, name, category, quantity::float AS quantity, unit, purchase_price,
                   minimum_stock::float AS minimum_stock, expiration_date::text AS expiration_date,
                   created_at, updated_at`,
        values
      );
      return r.rows[0];
    });

    if (!updated) {
      res.status(404).json({ error: 'ITEM_NOT_FOUND' });
      return;
    }

    res.status(200).json({ item: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/inventory/transactions
 * Record incoming ('incoming'), usage ('usage'), or write-off ('write_off') and update stock balance.
 */
inventoryRouter.post('/transactions', async (req, res, next) => {
  try {
    const parsed = CreateInventoryTransactionSchema.parse(req.body);

    const result = await runWithAuthenticatedRls(req, async (db, auth) => {
      const itemRes = await db.query<{ id: string; quantity: string }>(
        `SELECT id, quantity::text AS quantity
         FROM public.inventory_items
         WHERE id = $1 AND clinic_id = $2
         LIMIT 1`,
        [parsed.inventory_item_id, auth.clinicId]
      );
      const item = itemRes.rows[0];
      if (!item) return { error: 'ITEM_NOT_FOUND' as const };

      const currentQty = Number(item.quantity);
      const delta =
        parsed.type === 'incoming' ? parsed.quantity : -Math.abs(parsed.quantity);
      const newQty = Number((currentQty + delta).toFixed(2));

      if (newQty < 0) {
        return { error: 'INSUFFICIENT_STOCK' as const, currentQty };
      }

      const updItem = await db.query(
        `UPDATE public.inventory_items
         SET quantity = $1, updated_at = NOW()
         WHERE id = $2 AND clinic_id = $3
         RETURNING id, name, category, quantity::float AS quantity, unit, purchase_price,
                   minimum_stock::float AS minimum_stock, expiration_date::text AS expiration_date,
                   updated_at`,
        [newQty, parsed.inventory_item_id, auth.clinicId]
      );

      const txInsert = await db.query(
        `INSERT INTO public.inventory_transactions
         (id, clinic_id, inventory_item_id, type, quantity, transaction_date, comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, inventory_item_id, type, quantity::float AS quantity,
                   transaction_date::text AS transaction_date, comment, created_at`,
        [
          crypto.randomUUID(),
          auth.clinicId,
          parsed.inventory_item_id,
          parsed.type,
          parsed.quantity,
          parsed.transaction_date,
          parsed.comment ?? null,
        ]
      );

      return {
        status: 'ok' as const,
        item: updItem.rows[0],
        transaction: txInsert.rows[0],
      };
    });

    if ('error' in result) {
      if (result.error === 'INSUFFICIENT_STOCK') {
        res.status(400).json({
          error: 'INSUFFICIENT_STOCK',
          message: 'Недостаточно материала на складе для списания.',
        });
        return;
      }
      res.status(404).json({ error: 'ITEM_NOT_FOUND' });
      return;
    }

    res.status(201).json({
      item: result.item,
      transaction: result.transaction,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/inventory/items/:id
 */
inventoryRouter.delete('/items/:id', async (req, res, next) => {
  try {
    const itemId = UuidSchema.parse(req.params.id);
    const deleted = await runWithAuthenticatedRls(req, async (db, auth) => {
      const r = await db.query(
        `DELETE FROM public.inventory_items WHERE id = $1 AND clinic_id = $2 RETURNING id`,
        [itemId, auth.clinicId]
      );
      return r.rows[0];
    });
    if (!deleted) {
      res.status(404).json({ error: 'ITEM_NOT_FOUND' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
