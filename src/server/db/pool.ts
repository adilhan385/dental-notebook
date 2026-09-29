import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { env } from '../config/env.js';
import { hashPasswordArgon2id } from '../security/crypto.js';

export interface DbQueryResult<T = Record<string, any>> {
  rows: T[];
  rowCount: number;
}

export interface DbExecutor {
  query<T = Record<string, any>>(sql: string, params?: any[]): Promise<DbQueryResult<T>>;
}

export interface RlsSessionContext {
  authenticated: boolean;
  clinicId: string;
}

let sqliteDb: DatabaseSync | null = null;
let pgPool: pg.Pool | null = null;
let isInitialized = false;

/**
 * Translates PostgreSQL dialect constructs ($1..$N, ::type casts, NOW(), COUNT(*) FILTER)
 * to SQLite-compatible parameterized queries when running on embedded node:sqlite.
 */
function translatePgSqlToSqlite(
  sql: string,
  params: any[]
): { sqliteSql: string; sqliteParams: any[] } {
  let s = sql;

  // Replace public.<table_name> with main.<table_name>
  s = s.replace(/\bpublic\./g, '');

  // Replace COUNT(x) FILTER (WHERE cond)::int with SUM(CASE WHEN cond THEN 1 ELSE 0 END)
  s = s.replace(
    /COUNT\(([^)]+)\)\s*FILTER\s*\(\s*WHERE\s+([^)]+)\)(?:::int|::text)?/gi,
    'COALESCE(SUM(CASE WHEN $2 THEN 1 ELSE 0 END), 0)'
  );

  // Replace SUM(x) FILTER (WHERE cond) with SUM(CASE WHEN cond THEN x ELSE 0 END)
  s = s.replace(
    /SUM\(([^)]+)\)\s*FILTER\s*\(\s*WHERE\s+([^)]+)\)/gi,
    'SUM(CASE WHEN $2 THEN $1 ELSE 0 END)'
  );

  // Strip PostgreSQL type casts like ::text, ::int, ::float, ::jsonb, ::uuid
  s = s.replace(/::(?:text|int|integer|float|numeric|jsonb|uuid)\b/gi, '');

  // Replace NOW() with current ISO timestamp function
  s = s.replace(/\bNOW\(\)/gi, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");

  // Convert $1, $2, ... positional parameters into ? and expand params array in order of appearance
  const expandedParams: any[] = [];
  const sqliteSql = s.replace(/\$(\d+)/g, (_match, numStr) => {
    const idx = Number(numStr) - 1;
    const val = params[idx];
    if (typeof val === 'boolean') {
      expandedParams.push(val ? 1 : 0);
    } else if (val === undefined) {
      expandedParams.push(null);
    } else {
      expandedParams.push(val);
    }
    return '?';
  });

  return { sqliteSql, sqliteParams: expandedParams };
}

function normalizeRowBooleans(row: Record<string, any>): Record<string, any> {
  if (!row || typeof row !== 'object') return row;
  const out: Record<string, any> = { ...row };
  for (const boolCol of ['email_verified', 'totp_enabled', 'active']) {
    if (boolCol in out && (out[boolCol] === 0 || out[boolCol] === 1)) {
      out[boolCol] = Boolean(out[boolCol]);
    }
  }
  if ('metadata' in out && typeof out.metadata === 'string') {
    try {
      out.metadata = JSON.parse(out.metadata);
    } catch {
      // keep as is
    }
  }
  return out;
}

// Ensure PostgreSQL DATE (OID 1082) returns 'YYYY-MM-DD' string and NUMERIC (OID 1700) returns JS number
pg.types.setTypeParser(1082, (val: string) => val);
pg.types.setTypeParser(1700, (val: string) => Number(val));

function isTestRunActive(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    env.NODE_ENV === 'test' ||
    process.execArgv.includes('--test') ||
    process.argv.some((arg) => arg.includes('.test.'))
  );
}

function shouldUsePostgres(): boolean {
  return Boolean(env.DATABASE_URL) && !isTestRunActive();
}

function getPgPool(): pg.Pool {
  if (!pgPool) {
    pgPool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pgPool;
}

function getSqliteInstance(): DatabaseSync {
  if (sqliteDb) return sqliteDb;

  if (isTestRunActive()) {
    sqliteDb = new DatabaseSync(':memory:');
    sqliteDb.exec(`ATTACH DATABASE ':memory:' AS auth_internal;`);
  } else {
    const dir = path.dirname(env.PGLITE_DATA_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const mainFile = path.resolve(dir, 'clinic_public.sqlite');
    const authFile = path.resolve(dir, 'clinic_auth_internal.sqlite');
    sqliteDb = new DatabaseSync(mainFile);
    sqliteDb.exec(`ATTACH DATABASE '${authFile.replace(/'/g, "''")}' AS auth_internal;`);
  }

  sqliteDb.exec('PRAGMA foreign_keys = ON;');

  // Register Unicode-aware lower() so Cyrillic & Kazakh case-insensitive LIKE works identically to Postgres
  sqliteDb.function('lower', { deterministic: true }, (val: unknown) => {
    if (val === null || val === undefined) return null;
    return String(val).toLowerCase();
  });

  return sqliteDb;
}

function executeSqliteRaw<T = Record<string, any>>(
  db: DatabaseSync,
  sql: string,
  params: any[] = []
): DbQueryResult<T> {
  const { sqliteSql, sqliteParams } = translatePgSqlToSqlite(sql, params);
  const trimmed = sqliteSql.trim();
  const isReturningOrSelect =
    /^(?:SELECT|WITH)\b/i.test(trimmed) || /\bRETURNING\b/i.test(trimmed);

  const stmt = db.prepare(sqliteSql);
  if (isReturningOrSelect) {
    const rawRows = stmt.all(...sqliteParams) as Record<string, any>[];
    const rows = rawRows.map(normalizeRowBooleans) as T[];
    return { rows, rowCount: rows.length };
  } else {
    const info = stmt.run(...sqliteParams);
    return { rows: [], rowCount: Number(info.changes ?? 0) };
  }
}

/**
 * Execute privileged internal query (ONLY for schema setup & auth_internal service).
 * Application routes MUST use withClinicRls() instead.
 */
export async function queryInternal<T = Record<string, any>>(
  sql: string,
  params: any[] = []
): Promise<DbQueryResult<T>> {
  if (shouldUsePostgres()) {
    const pool = getPgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      const res = await client.query(sql, params);
      await client.query('COMMIT');
      return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    } finally {
      client.release();
    }
  }

  const db = getSqliteInstance();
  // Temporarily allow internal privileged writes
  db.prepare(
    `UPDATE _rls_context SET bypass_internal = 1`
  ).run();
  try {
    return executeSqliteRaw<T>(db, sql, params);
  } finally {
    db.prepare(
      `UPDATE _rls_context SET bypass_internal = 0`
    ).run();
  }
}

/**
 * Execute queries inside a transaction scoped with Row-Level Security (RLS)
 * enforced via `app.user_authenticated` and `app.clinic_id` (Rule 3, Rule 4, Rule 6, Rule 9).
 */
export async function withClinicRls<R>(
  ctx: RlsSessionContext,
  callback: (db: DbExecutor) => Promise<R>
): Promise<R> {
  if (shouldUsePostgres()) {
    const pool = getPgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.bypass_rls', 'false', true), set_config('app.user_authenticated', $1, true), set_config('app.clinic_id', $2, true)`,
        [ctx.authenticated ? 'true' : 'false', ctx.clinicId || '']
      );

      const executor: DbExecutor = {
        async query<T = Record<string, any>>(sql: string, params: any[] = []) {
          const normalizedSql = sql.trim();

          if (/\bauth_internal\b/i.test(normalizedSql)) {
            throw new Error('permission denied for schema auth_internal');
          }
          if (/^(?:DROP|ALTER|TRUNCATE|ATTACH|DETACH|PRAGMA|CREATE)\b/i.test(normalizedSql)) {
            throw new Error('must be owner of table (DDL forbidden for clinic_app_role)');
          }
          if (/^(?:SELECT|WITH)\b/i.test(normalizedSql)) {
            if (!ctx.authenticated || !ctx.clinicId) {
              return { rows: [], rowCount: 0 };
            }
          }

          const res = await client.query(sql, params);
          return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
        },
      };

      const result = await callback(executor);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    } finally {
      client.release();
    }
  }

  const db = getSqliteInstance();
  db.prepare(
    `UPDATE _rls_context SET authenticated = ?, clinic_id = ?, bypass_internal = 0`
  ).run(ctx.authenticated ? 1 : 0, ctx.clinicId || '');

  try {
    const executor: DbExecutor = {
      async query<T = Record<string, any>>(sql: string, params: any[] = []) {
        const normalizedSql = sql.trim();

        // Rule 9: clinic_app_role is strictly forbidden from accessing auth_internal schema
        if (/\bauth_internal\b/i.test(normalizedSql)) {
          throw new Error('permission denied for schema auth_internal');
        }

        // Rule 6: clinic_app_role is least-privilege (no DROP, ALTER, TRUNCATE, ATTACH, PRAGMA)
        if (/^(?:DROP|ALTER|TRUNCATE|ATTACH|DETACH|PRAGMA|CREATE)\b/i.test(normalizedSql)) {
          throw new Error('must be owner of table (DDL forbidden for clinic_app_role)');
        }

        // Rule 3: Default-deny RLS on SELECT when unauthenticated or missing clinicId
        if (/^(?:SELECT|WITH)\b/i.test(normalizedSql)) {
          if (!ctx.authenticated || !ctx.clinicId) {
            return { rows: [], rowCount: 0 };
          }
        }

        const res = executeSqliteRaw<T>(db, sql, params);

        // Rule 3: Enforce row-level tenant isolation on returned rows if clinic_id column is present
        if (res.rows.length > 0) {
          const filtered = res.rows.filter((r: any) => {
            if (r && typeof r === 'object' && 'clinic_id' in r) {
              return r.clinic_id === ctx.clinicId;
            }
            return true;
          });
          return { rows: filtered, rowCount: filtered.length };
        }

        return res;
      },
    };

    return await callback(executor);
  } finally {
    db.prepare(
      `UPDATE _rls_context SET authenticated = 0, clinic_id = '', bypass_internal = 0`
    ).run();
  }
}

const SQLITE_SCHEMA_AND_RLS_SQL = `
CREATE TABLE IF NOT EXISTS _rls_context (
  authenticated INTEGER NOT NULL DEFAULT 0,
  clinic_id TEXT NOT NULL DEFAULT '',
  bypass_internal INTEGER NOT NULL DEFAULT 1
);
DELETE FROM _rls_context;
INSERT INTO _rls_context (authenticated, clinic_id, bypass_internal) VALUES (0, '', 1);

CREATE TABLE IF NOT EXISTS clinics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  subtitle TEXT,
  default_language TEXT NOT NULL DEFAULT 'ru' CHECK (default_language IN ('ru', 'kz', 'en')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS auth_internal.clinic_accounts (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,
  totp_secret_encrypted TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  password_changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS auth_internal.sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  clinic_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  last_active_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS auth_internal.security_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_type TEXT NOT NULL CHECK (token_type IN ('email_verify', 'password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS auth_internal.email_outbox (
  id TEXT PRIMARY KEY,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  iin TEXT,
  date_of_birth TEXT,
  phone TEXT,
  allergies TEXT,
  medical_notes TEXT,
  additional_info TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name_ru TEXT NOT NULL,
  name_kz TEXT NOT NULL,
  name_en TEXT NOT NULL,
  reference_price INTEGER CHECK (reference_price IS NULL OR reference_price >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  visit_date TEXT NOT NULL,
  visit_time TEXT,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  service_name_snapshot TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('paid', 'unpaid')),
  payment_date TEXT,
  doctor_name TEXT,
  complaints TEXT,
  diagnosis TEXT,
  treatment TEXT,
  recommendations TEXT,
  comments TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_date TEXT NOT NULL,
  appointment_time TEXT NOT NULL,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  service_name_snapshot TEXT,
  estimated_price INTEGER CHECK (estimated_price IS NULL OR estimated_price >= 0),
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  visit_id TEXT REFERENCES visits(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  storage_path TEXT NOT NULL UNIQUE,
  sha256_checksum TEXT NOT NULL,
  content_base64 TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT,
  quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit TEXT NOT NULL,
  purchase_price INTEGER CHECK (purchase_price IS NULL OR purchase_price >= 0),
  minimum_stock REAL CHECK (minimum_stock IS NULL OR minimum_stock >= 0),
  expiration_date TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  inventory_item_id TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('incoming', 'usage', 'write_off')),
  quantity REAL NOT NULL CHECK (quantity > 0),
  transaction_date TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  ip_address TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_patients_clinic_name ON patients (clinic_id, full_name);
CREATE INDEX IF NOT EXISTS idx_patients_clinic_iin ON patients (clinic_id, iin);
CREATE INDEX IF NOT EXISTS idx_patients_clinic_phone ON patients (clinic_id, phone);
CREATE INDEX IF NOT EXISTS idx_visits_clinic_date ON visits (clinic_id, visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_date ON appointments (clinic_id, appointment_date, appointment_time);
`;

const POSTGRES_SCHEMA_AND_RLS_SQL = `
CREATE SCHEMA IF NOT EXISTS auth_internal;
REVOKE ALL ON SCHEMA auth_internal FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public.clinics (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  subtitle TEXT,
  default_language TEXT NOT NULL DEFAULT 'ru' CHECK (default_language IN ('ru', 'kz', 'en')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_internal.clinic_accounts (
  id UUID PRIMARY KEY,
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash TEXT NOT NULL,
  totp_secret_encrypted TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_internal.sessions (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES auth_internal.clinic_accounts(id) ON DELETE CASCADE,
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_internal.security_tokens (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES auth_internal.clinic_accounts(id) ON DELETE CASCADE,
  token_type TEXT NOT NULL CHECK (token_type IN ('email_verify', 'password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_internal.email_outbox (
  id UUID PRIMARY KEY,
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.patients (
  id UUID PRIMARY KEY,
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  iin TEXT,
  date_of_birth DATE,
  phone TEXT,
  allergies TEXT,
  medical_notes TEXT,
  additional_info TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.services (
  id UUID PRIMARY KEY,
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  name_ru TEXT NOT NULL,
  name_kz TEXT NOT NULL,
  name_en TEXT NOT NULL,
  reference_price INTEGER CHECK (reference_price IS NULL OR reference_price >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.visits (
  id UUID PRIMARY KEY,
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  visit_date DATE NOT NULL,
  visit_time TEXT,
  service_id UUID REFERENCES public.services(id) ON DELETE SET NULL,
  service_name_snapshot TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('paid', 'unpaid')),
  payment_date DATE,
  doctor_name TEXT,
  complaints TEXT,
  diagnosis TEXT,
  treatment TEXT,
  recommendations TEXT,
  comments TEXT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.appointments (
  id UUID PRIMARY KEY,
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  appointment_date DATE NOT NULL,
  appointment_time TEXT NOT NULL,
  service_id UUID REFERENCES public.services(id) ON DELETE SET NULL,
  service_name_snapshot TEXT,
  estimated_price INTEGER CHECK (estimated_price IS NULL OR estimated_price >= 0),
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.attachments (
  id UUID PRIMARY KEY,
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  visit_id UUID REFERENCES public.visits(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  storage_path TEXT NOT NULL UNIQUE,
  sha256_checksum TEXT NOT NULL,
  content_base64 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.attachments ADD COLUMN IF NOT EXISTS content_base64 TEXT;

CREATE TABLE IF NOT EXISTS public.inventory_items (
  id UUID PRIMARY KEY,
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT,
  quantity NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit TEXT NOT NULL,
  purchase_price INTEGER CHECK (purchase_price IS NULL OR purchase_price >= 0),
  minimum_stock NUMERIC(12, 2) CHECK (minimum_stock IS NULL OR minimum_stock >= 0),
  expiration_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.inventory_transactions (
  id UUID PRIMARY KEY,
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('incoming', 'usage', 'write_off')),
  quantity NUMERIC(12, 2) NOT NULL CHECK (quantity > 0),
  transaction_date DATE NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.audit_events (
  id UUID PRIMARY KEY,
  clinic_id UUID NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  entity_type TEXT,
  entity_id UUID,
  ip_address TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patients_clinic_name ON public.patients (clinic_id, lower(full_name));
CREATE INDEX IF NOT EXISTS idx_patients_clinic_iin ON public.patients (clinic_id, iin);
CREATE INDEX IF NOT EXISTS idx_patients_clinic_phone ON public.patients (clinic_id, phone);
CREATE INDEX IF NOT EXISTS idx_visits_clinic_date ON public.visits (clinic_id, visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_date ON public.appointments (clinic_id, appointment_date, appointment_time);

ALTER TABLE public.clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinics FORCE ROW LEVEL SECURITY;
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patients FORCE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services FORCE ROW LEVEL SECURITY;
ALTER TABLE public.visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visits FORCE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS clinic_isolation_policy ON public.clinics;
CREATE POLICY clinic_isolation_policy ON public.clinics
  FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'true'
    OR (
      current_setting('app.user_authenticated', true) = 'true'
      AND id = NULLIF(current_setting('app.clinic_id', true), '')::uuid
    )
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'true'
    OR (
      current_setting('app.user_authenticated', true) = 'true'
      AND id = NULLIF(current_setting('app.clinic_id', true), '')::uuid
    )
  );

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'patients',
    'services',
    'visits',
    'appointments',
    'attachments',
    'inventory_items',
    'inventory_transactions',
    'audit_events'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS clinic_isolation_policy ON public.%I;', tbl);
    EXECUTE format('
      CREATE POLICY clinic_isolation_policy ON public.%I
        FOR ALL
        USING (
          current_setting(''app.bypass_rls'', true) = ''true''
          OR (
            current_setting(''app.user_authenticated'', true) = ''true''
            AND clinic_id = NULLIF(current_setting(''app.clinic_id'', true), '''')::uuid
          )
        )
        WITH CHECK (
          current_setting(''app.bypass_rls'', true) = ''true''
          OR (
            current_setting(''app.user_authenticated'', true) = ''true''
            AND clinic_id = NULLIF(current_setting(''app.clinic_id'', true), '''')::uuid
          )
        );
    ', tbl);
  END LOOP;
END
$$;
`;

function createSqliteRlsTriggers(db: DatabaseSync): void {
  const clinicScopedTables = [
    'patients',
    'services',
    'visits',
    'appointments',
    'attachments',
    'inventory_items',
    'inventory_transactions',
    'audit_events',
  ];

  for (const tbl of clinicScopedTables) {
    db.exec(`
      DROP TRIGGER IF EXISTS rls_insert_${tbl};
      CREATE TRIGGER rls_insert_${tbl} BEFORE INSERT ON ${tbl}
      WHEN (SELECT bypass_internal FROM _rls_context LIMIT 1) = 0
        AND (
          (SELECT authenticated FROM _rls_context LIMIT 1) != 1
          OR NEW.clinic_id != (SELECT clinic_id FROM _rls_context LIMIT 1)
        )
      BEGIN
        SELECT RAISE(ABORT, 'new row violates row-level security policy for table ${tbl}');
      END;

      DROP TRIGGER IF EXISTS rls_update_${tbl};
      CREATE TRIGGER rls_update_${tbl} BEFORE UPDATE ON ${tbl}
      WHEN (SELECT bypass_internal FROM _rls_context LIMIT 1) = 0
        AND (
          (SELECT authenticated FROM _rls_context LIMIT 1) != 1
          OR OLD.clinic_id != (SELECT clinic_id FROM _rls_context LIMIT 1)
          OR NEW.clinic_id != (SELECT clinic_id FROM _rls_context LIMIT 1)
        )
      BEGIN
        SELECT RAISE(ABORT, 'row violates row-level security policy for table ${tbl}');
      END;

      DROP TRIGGER IF EXISTS rls_delete_${tbl};
      CREATE TRIGGER rls_delete_${tbl} BEFORE DELETE ON ${tbl}
      WHEN (SELECT bypass_internal FROM _rls_context LIMIT 1) = 0
        AND (
          (SELECT authenticated FROM _rls_context LIMIT 1) != 1
          OR OLD.clinic_id != (SELECT clinic_id FROM _rls_context LIMIT 1)
        )
      BEGIN
        SELECT RAISE(ABORT, 'delete violates row-level security policy for table ${tbl}');
      END;
    `);
  }
}

export async function initializeDatabase(): Promise<void> {
  if (isInitialized) return;

  if (shouldUsePostgres()) {
    const pool = getPgPool();
    await pool.query(POSTGRES_SCHEMA_AND_RLS_SQL);
  } else {
    const db = getSqliteInstance();
    db.exec(SQLITE_SCHEMA_AND_RLS_SQL);
    createSqliteRlsTriggers(db);
    db.prepare(`UPDATE _rls_context SET bypass_internal = 0`).run();
  }

  const existingClinics = await queryInternal<{ count: string }>(
    'SELECT COUNT(*) AS count FROM public.clinics'
  );
  const count = Number(existingClinics.rows[0]?.count || 0);

  if (count === 0) {
    await seedInitialClinicAndServices();
  }

  isInitialized = true;
}

async function seedInitialClinicAndServices(): Promise<void> {
  const clinicId = crypto.randomUUID();
  const demoEmail = (process.env.INITIAL_CLINIC_EMAIL || 'clinic@dental-demo.kz').toLowerCase();
  const demoPassphrase =
    process.env.INITIAL_CLINIC_PASSWORD || 'OrtaStom-Demo-Notebook-2026!';

  await queryInternal(
    `INSERT INTO public.clinics (id, name, phone, subtitle, default_language)
     VALUES ($1, $2, $3, $4, 'ru')`,
    [
      clinicId,
      'Стоматологический кабинет «Дентал Практик»',
      '+7 (777) 000-11-22',
      'Терапевтическая и ортопедическая стоматология',
    ]
  );

  const passwordHash = hashPasswordArgon2id(demoPassphrase);
  await queryInternal(
    `INSERT INTO auth_internal.clinic_accounts (id, clinic_id, email, email_verified, password_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [crypto.randomUUID(), clinicId, demoEmail, true, passwordHash]
  );

  const servicesData = [
    {
      id: crypto.randomUUID(),
      ru: 'Лечение кариеса',
      kz: 'Тіс жегісін емдеу (кариес)',
      en: 'Caries treatment',
      price: 30000,
    },
    {
      id: crypto.randomUUID(),
      ru: 'Профессиональная чистка',
      kz: 'Кәсіби тазалау',
      en: 'Professional dental cleaning',
      price: 25000,
    },
    {
      id: crypto.randomUUID(),
      ru: 'Консультация и осмотр',
      kz: 'Кеңес беру және тексеру',
      en: 'Consultation & examination',
      price: 10000,
    },
    {
      id: crypto.randomUUID(),
      ru: 'Лечение пульпита (эндодонтия)',
      kz: 'Пульпитті емдеу (эндодонтия)',
      en: 'Pulpitis root canal treatment',
      price: 55000,
    },
    {
      id: crypto.randomUUID(),
      ru: 'Удаление зуба',
      kz: 'Тіс жұлу',
      en: 'Tooth extraction',
      price: 20000,
    },
    {
      id: crypto.randomUUID(),
      ru: 'Установка коронки (цирконий)',
      kz: 'Цирконий коронкасын орнату',
      en: 'Zirconia crown placement',
      price: 95000,
    },
    {
      id: crypto.randomUUID(),
      ru: 'Прицельный рентген-снимок',
      kz: 'Рентген суреті',
      en: 'Targeted X-ray scan',
      price: 5000,
    },
  ];

  for (const s of servicesData) {
    await queryInternal(
      `INSERT INTO public.services (id, clinic_id, name_ru, name_kz, name_en, reference_price, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [s.id, clinicId, s.ru, s.kz, s.en, s.price, true]
    );
  }
}
