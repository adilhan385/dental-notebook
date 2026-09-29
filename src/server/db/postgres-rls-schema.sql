-- =====================================================================
-- Digital Dental Notebook — PostgreSQL Schema & Row-Level Security (RLS)
-- Enforces Rule 3 (RLS Enabled & Forced on every table), Rule 6 (Least Privilege),
-- Rule 9 (Isolated auth_internal schema), and Rule 14 (UUID Primary Keys).
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS auth_internal;
REVOKE ALL ON SCHEMA auth_internal FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app_role') THEN
    CREATE ROLE clinic_app_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

GRANT USAGE ON SCHEMA public TO clinic_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO clinic_app_role;

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
  FOR ALL TO clinic_app_role
  USING (
    current_setting('app.user_authenticated', true) = 'true'
    AND id = NULLIF(current_setting('app.clinic_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('app.user_authenticated', true) = 'true'
    AND id = NULLIF(current_setting('app.clinic_id', true), '')::uuid
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
        FOR ALL TO clinic_app_role
        USING (
          current_setting(''app.user_authenticated'', true) = ''true''
          AND clinic_id = NULLIF(current_setting(''app.clinic_id'', true), '''')::uuid
        )
        WITH CHECK (
          current_setting(''app.user_authenticated'', true) = ''true''
          AND clinic_id = NULLIF(current_setting(''app.clinic_id'', true), '''')::uuid
        );
    ', tbl);
  END LOOP;
END
$$;
