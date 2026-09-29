import { z } from 'zod';

/**
 * Normalize string: NFC Unicode normalization + trim (Rule 7)
 */
export function normalizeText(val: string): string {
  return val.normalize('NFC').trim();
}

const normalizedString = (min: number, max: number) =>
  z
    .string()
    .transform(normalizeText)
    .pipe(z.string().min(min).max(max));

const optionalNormalizedString = (max: number) =>
  z
    .string()
    .transform(normalizeText)
    .pipe(z.string().max(max))
    .optional()
    .nullable()
    .transform((v) => (v === '' ? null : v ?? null));

/**
 * Kazakhstan 12-digit IIN format & official Modulo-11 checksum validation (Rule 7)
 */
export function validateKzIin(iin: string): boolean {
  if (!/^\d{12}$/.test(iin)) return false;

  const digits = iin.split('').map(Number);

  // Validate YYMMDD date portion and 7th century digit (1..6)
  const yy = digits[0] * 10 + digits[1];
  const mm = digits[2] * 10 + digits[3];
  const dd = digits[4] * 10 + digits[5];
  const centuryCode = digits[6];

  if (centuryCode < 1 || centuryCode > 6) return false;
  let century = 1900;
  if (centuryCode === 1 || centuryCode === 2) century = 1800;
  else if (centuryCode === 3 || centuryCode === 4) century = 1900;
  else if (centuryCode === 5 || centuryCode === 6) century = 2000;

  const fullYear = century + yy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  const dateCheck = new Date(Date.UTC(fullYear, mm - 1, dd));
  if (
    dateCheck.getUTCFullYear() !== fullYear ||
    dateCheck.getUTCMonth() !== mm - 1 ||
    dateCheck.getUTCDate() !== dd
  ) {
    return false;
  }

  // Pass 1 checksum weights: 1..11
  const weights1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  let sum1 = 0;
  for (let i = 0; i < 11; i++) {
    sum1 += digits[i] * weights1[i];
  }
  let control = sum1 % 11;

  // Pass 2 checksum weights if control === 10
  if (control === 10) {
    const weights2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
    let sum2 = 0;
    for (let i = 0; i < 11; i++) {
      sum2 += digits[i] * weights2[i];
    }
    control = sum2 % 11;
  }

  if (control === 10) return false;
  return control === digits[11];
}

/**
 * Helper to generate a valid test/seed KZ IIN from YYMMDD + century + 4 serial digits
 */
export function computeValidKzIin(prefix11: string): string {
  if (!/^\d{11}$/.test(prefix11)) throw new Error('Prefix must be 11 digits');
  const d = prefix11.split('').map(Number);
  const w1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  let c = d.reduce((acc, v, i) => acc + v * w1[i], 0) % 11;
  if (c === 10) {
    const w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
    c = d.reduce((acc, v, i) => acc + v * w2[i], 0) % 11;
  }
  if (c === 10) throw new Error('Prefix cannot form valid IIN');
  return `${prefix11}${c}`;
}

export function isValidIsoDate(dateStr: string, allowFuture = true): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return false;
  }
  if (!allowFuture) {
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    if (dt.getTime() > todayUtc) return false;
  }
  return true;
}

export const UuidSchema = z.string().uuid('Invalid UUID identifier');

export const IinFieldSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, ''))
  .refine((v) => v === '' || validateKzIin(v), {
    message: 'Invalid 12-digit IIN format or checksum',
  })
  .optional()
  .nullable()
  .transform((v) => (!v ? null : v));

export const PhoneFieldSchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v === '' || /^\+?[0-9()\-\s]{7,20}$/.test(v), {
    message: 'Invalid phone number format',
  })
  .optional()
  .nullable()
  .transform((v) => (!v ? null : v));

export const DateOfBirthSchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v === '' || isValidIsoDate(v, false), {
    message: 'Invalid or future date of birth',
  })
  .optional()
  .nullable()
  .transform((v) => (!v ? null : v));

export const IsoDateSchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => isValidIsoDate(v, true), {
    message: 'Invalid calendar date (expected YYYY-MM-DD)',
  });

export const OptionalIsoDateSchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v === '' || isValidIsoDate(v, true), {
    message: 'Invalid calendar date (expected YYYY-MM-DD)',
  })
  .optional()
  .nullable()
  .transform((v) => (!v ? null : v));

export const TimeFieldSchema = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), {
    message: 'Invalid time format (expected HH:MM)',
  })
  .optional()
  .nullable()
  .transform((v) => (!v ? null : v));

export const PriceSchema = z
  .number()
  .int('Price must be an integer in KZT')
  .min(0, 'Price cannot be negative')
  .max(50_000_000, 'Price exceeds maximum allowed limit');

export const PaymentStatusSchema = z.enum(['paid', 'unpaid']);

// =====================================================================
// AUTH SCHEMAS (Rule 7, Rule 9, Rule 13, Rule 19)
// =====================================================================
export const LoginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(1).max(256),
    totpCode: z
      .string()
      .trim()
      .regex(/^\d{6}$/)
      .optional(),
  })
  .strict();

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z
      .string()
      .min(12, 'Password must be at least 12 characters long')
      .max(256),
  })
  .strict();

export const RequestResetSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();

export const ConfirmResetSchema = z
  .object({
    token: z.string().trim().min(32).max(256),
    newPassword: z.string().min(12).max(256),
  })
  .strict();

export const VerifyEmailSchema = z
  .object({
    token: z.string().trim().min(32).max(256),
  })
  .strict();

// =====================================================================
// PATIENT SCHEMAS (Rule 7, Rule 15: strict allow-list, no gender/email/address/odontogram)
// =====================================================================
export const CreatePatientSchema = z
  .object({
    full_name: normalizedString(2, 160),
    iin: IinFieldSchema,
    date_of_birth: DateOfBirthSchema,
    phone: PhoneFieldSchema,
    allergies: optionalNormalizedString(1000),
    medical_notes: optionalNormalizedString(4000),
    additional_info: optionalNormalizedString(4000),
  })
  .strict();

export const UpdatePatientSchema = z
  .object({
    full_name: normalizedString(2, 160).optional(),
    iin: IinFieldSchema,
    date_of_birth: DateOfBirthSchema,
    phone: PhoneFieldSchema,
    allergies: optionalNormalizedString(1000),
    medical_notes: optionalNormalizedString(4000),
    additional_info: optionalNormalizedString(4000),
    expected_updated_at: z.string().optional(),
  })
  .strict();

// =====================================================================
// VISIT SCHEMAS
// =====================================================================
export const CreateVisitSchema = z
  .object({
    patient_id: UuidSchema,
    visit_date: IsoDateSchema,
    visit_time: TimeFieldSchema,
    service_id: UuidSchema.optional().nullable(),
    service_name_snapshot: normalizedString(1, 250),
    price: PriceSchema,
    payment_status: PaymentStatusSchema,
    payment_date: OptionalIsoDateSchema,
    doctor_name: optionalNormalizedString(120),
    complaints: optionalNormalizedString(4000),
    diagnosis: optionalNormalizedString(4000),
    treatment: optionalNormalizedString(8000),
    recommendations: optionalNormalizedString(4000),
    comments: optionalNormalizedString(4000),
  })
  .strict();

export const UpdateVisitSchema = z
  .object({
    visit_date: IsoDateSchema.optional(),
    visit_time: TimeFieldSchema,
    service_id: UuidSchema.optional().nullable(),
    service_name_snapshot: normalizedString(1, 250).optional(),
    price: PriceSchema.optional(),
    payment_status: PaymentStatusSchema.optional(),
    payment_date: OptionalIsoDateSchema,
    doctor_name: optionalNormalizedString(120),
    complaints: optionalNormalizedString(4000),
    diagnosis: optionalNormalizedString(4000),
    treatment: optionalNormalizedString(8000),
    recommendations: optionalNormalizedString(4000),
    comments: optionalNormalizedString(4000),
    expected_updated_at: z.string().optional(),
  })
  .strict();

// =====================================================================
// APPOINTMENT SCHEMAS
// =====================================================================
export const CreateAppointmentSchema = z
  .object({
    patient_id: UuidSchema,
    appointment_date: IsoDateSchema,
    appointment_time: z
      .string()
      .trim()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM'),
    service_id: UuidSchema.optional().nullable(),
    service_name_snapshot: optionalNormalizedString(250),
    estimated_price: PriceSchema.optional().nullable(),
    comment: optionalNormalizedString(1000),
  })
  .strict();

export const UpdateAppointmentSchema = z
  .object({
    appointment_date: IsoDateSchema.optional(),
    appointment_time: z
      .string()
      .trim()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM')
      .optional(),
    service_id: UuidSchema.optional().nullable(),
    service_name_snapshot: optionalNormalizedString(250),
    estimated_price: PriceSchema.optional().nullable(),
    comment: optionalNormalizedString(1000),
    status: z.enum(['scheduled', 'completed', 'cancelled']).optional(),
    expected_updated_at: z.string().optional(),
  })
  .strict();

// =====================================================================
// SERVICE CATALOG SCHEMAS
// =====================================================================
export const CreateServiceSchema = z
  .object({
    name_ru: normalizedString(1, 200),
    name_kz: normalizedString(1, 200),
    name_en: normalizedString(1, 200),
    reference_price: PriceSchema.optional().nullable(),
    active: z.boolean().optional().default(true),
  })
  .strict();

export const UpdateServiceSchema = z
  .object({
    name_ru: normalizedString(1, 200).optional(),
    name_kz: normalizedString(1, 200).optional(),
    name_en: normalizedString(1, 200).optional(),
    reference_price: PriceSchema.optional().nullable(),
    active: z.boolean().optional(),
  })
  .strict();

// =====================================================================
// INVENTORY SCHEMAS
// =====================================================================
export const CreateInventoryItemSchema = z
  .object({
    name: normalizedString(1, 200),
    category: optionalNormalizedString(100),
    quantity: z.number().min(0).max(1_000_000),
    unit: normalizedString(1, 40),
    purchase_price: PriceSchema.optional().nullable(),
    minimum_stock: z.number().min(0).max(1_000_000).optional().nullable(),
    expiration_date: OptionalIsoDateSchema,
  })
  .strict();

export const UpdateInventoryItemSchema = z
  .object({
    name: normalizedString(1, 200).optional(),
    category: optionalNormalizedString(100),
    unit: normalizedString(1, 40).optional(),
    purchase_price: PriceSchema.optional().nullable(),
    minimum_stock: z.number().min(0).max(1_000_000).optional().nullable(),
    expiration_date: OptionalIsoDateSchema,
  })
  .strict();

export const CreateInventoryTransactionSchema = z
  .object({
    inventory_item_id: UuidSchema,
    type: z.enum(['incoming', 'usage', 'write_off']),
    quantity: z.number().positive('Quantity must be greater than 0').max(1_000_000),
    transaction_date: IsoDateSchema,
    comment: optionalNormalizedString(500),
  })
  .strict();

// =====================================================================
// PERMANENT DELETE CONFIRMATION SCHEMA
// =====================================================================
export const PermanentDeleteSchema = z
  .object({
    confirmationText: z
      .string()
      .trim()
      .refine((v) => ['УДАЛИТЬ', 'ЖОЮ', 'DELETE'].includes(v), {
        message: 'Confirmation word must match УДАЛИТЬ / ЖОЮ / DELETE',
      }),
  })
  .strict();

// =====================================================================
// PAGINATION & QUERY SCHEMAS (Rule 5)
// =====================================================================
export const PaginationQuerySchema = z.object({
  q: z
    .string()
    .max(120)
    .optional()
    .transform((v) => (v ? normalizeText(v) : '')),
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export const ClinicSettingsUpdateSchema = z
  .object({
    name: normalizedString(2, 160).optional(),
    phone: PhoneFieldSchema,
    subtitle: optionalNormalizedString(250),
    default_language: z.enum(['ru', 'kz', 'en']).optional(),
  })
  .strict();
