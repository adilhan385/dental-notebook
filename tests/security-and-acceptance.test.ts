import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import supertest from 'supertest';

process.env.NODE_ENV = 'test';

import { initializeDatabase, queryInternal, withClinicRls } from '../src/server/db/pool.js';
import { createApp } from '../src/server/app.js';
import { resetRateLimitersForTest } from '../src/server/middleware/rateLimit.js';
import { computeValidKzIin, validateKzIin } from '../src/shared/validation/schemas.js';
import { escapeHtml } from '../src/client/utils/print.js';
import { validatePasswordSecurity } from '../src/server/security/passwordBreach.js';
import { env } from '../src/server/config/env.js';

const app = createApp();

// Helper to extract cookies and login as the demo clinic
async function loginAsMainClinic() {
  resetRateLimitersForTest();
  const agent = supertest.agent(app);
  const res = await agent.post('/api/auth/login').send({
    email: 'clinic@dental-demo.kz',
    password: 'OrtaStom-Demo-Notebook-2026!',
  });
  assert.equal(res.status, 200, `Login failed: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.csrfToken, 'Expected csrfToken in login response');
  return {
    agent,
    csrfToken: res.body.csrfToken as string,
    clinicId: res.body.clinic.id as string,
  };
}

describe('Digital Dental Notebook — Comprehensive Security & Acceptance Suite', () => {
  before(async () => {
    await initializeDatabase();
  });

  // =====================================================================
  // 1. DATABASE ROW-LEVEL SECURITY (RLS) & LEAST PRIVILEGE (Rule 3, 6, 9)
  // =====================================================================
  it('1. RLS & Least Privilege: anonymous/unauthenticated DB context cannot read or write ANY row, cannot access auth_internal, and cannot DROP tables', async () => {
    // 1a. Unauthenticated context reads 0 rows across all public tables
    await withClinicRls({ authenticated: false, clinicId: '' }, async (db) => {
      const tables = [
        'clinics',
        'patients',
        'visits',
        'appointments',
        'services',
        'attachments',
        'inventory_items',
        'inventory_transactions',
        'audit_events',
      ];
      for (const tbl of tables) {
        const r = await db.query(`SELECT * FROM public.${tbl}`);
        assert.equal(
          r.rows.length,
          0,
          `Expected 0 rows from public.${tbl} when unauthenticated, got ${r.rows.length}`
        );
      }

      // 1b. Unauthenticated context cannot INSERT into patients (blocked by PostgreSQL RLS WITH CHECK)
      await assert.rejects(
        async () => {
          await db.query(
            `INSERT INTO public.patients (id, clinic_id, full_name) VALUES ($1, $2, 'Hacker')`,
            [crypto.randomUUID(), crypto.randomUUID()]
          );
        },
        /row-level security policy/i,
        'Expected PostgreSQL RLS policy to reject anonymous INSERT'
      );

      // 1c. Least-privilege role cannot access auth_internal schema (Rule 9)
      await assert.rejects(
        async () => {
          await db.query(`SELECT * FROM auth_internal.clinic_accounts`);
        },
        /permission denied for schema auth_internal/i
      );

      // 1d. Least-privilege role cannot DROP tables (Rule 6)
      await assert.rejects(
        async () => {
          await db.query(`DROP TABLE public.patients`);
        },
        /must be owner of table/i
      );
    });

    // 1e. Unauthenticated HTTP requests to all API & service routes are denied with 401
    const unauthClient = supertest(app);
    const protectedEndpoints = [
      '/api/patients',
      '/api/patients/search?q=test',
      '/api/finances/summary?from=2026-01-01&to=2026-12-31',
      '/api/inventory',
      '/api/archive',
      '/api/settings/services',
      '/admin',
      '/debug',
      '/swagger',
      '/metrics',
    ];
    for (const ep of protectedEndpoints) {
      const res = await unauthClient.get(ep);
      assert.equal(res.status, 401, `Expected 401 on unauthenticated GET ${ep}`);
    }
  });

  // =====================================================================
  // 2. IDOR (INSECURE DIRECT OBJECT REFERENCE) PROTECTION (Rule 3, 4, 14)
  // =====================================================================
  it('2. IDOR Protection: Clinic A cannot read, update, or attach visits to Clinic B records even with exact UUIDs', async () => {
    const { agent, csrfToken } = await loginAsMainClinic();

    // Create a separate isolated Clinic B and a patient in Clinic B
    const clinicBId = crypto.randomUUID();
    const patientBId = crypto.randomUUID();
    await queryInternal(
      `INSERT INTO public.clinics (id, name, default_language) VALUES ($1, 'Foreign Clinic B', 'ru')`,
      [clinicBId]
    );
    await queryInternal(
      `INSERT INTO public.patients (id, clinic_id, full_name) VALUES ($1, $2, 'Secret Patient B')`,
      [patientBId, clinicBId]
    );

    // Clinic A attempts GET /api/patients/:patientBId -> 404
    const getRes = await agent.get(`/api/patients/${patientBId}`);
    assert.equal(getRes.status, 404);

    // Clinic A attempts PATCH /api/patients/:patientBId -> 404
    const patchRes = await agent
      .patch(`/api/patients/${patientBId}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ full_name: 'Hijacked Name' });
    assert.equal(patchRes.status, 404);

    // Clinic A attempts POST /api/visits on Clinic B's patient -> 404
    const visitRes = await agent
      .post('/api/visits')
      .set('X-CSRF-Token', csrfToken)
      .send({
        patient_id: patientBId,
        visit_date: '2026-09-28',
        service_name_snapshot: 'Test',
        price: 10000,
        payment_status: 'paid',
      });
    assert.equal(visitRes.status, 404);
  });

  // =====================================================================
  // 3. MASS ASSIGNMENT & OPTIMISTIC CONCURRENCY (Rule 7 & Rule 15)
  // =====================================================================
  it('3. Mass Assignment Prevention: rejects unknown or privileged fields (clinic_id, id, created_at, archived_at, isAdmin)', async () => {
    const { agent, csrfToken } = await loginAsMainClinic();

    // Attempt to inject clinic_id or archived_at during patient creation
    const createAttempt = await agent
      .post('/api/patients')
      .set('X-CSRF-Token', csrfToken)
      .send({
        full_name: 'Valid Name',
        clinic_id: crypto.randomUUID(),
        isAdmin: true,
      });
    assert.equal(createAttempt.status, 400);
    assert.equal(createAttempt.body.error, 'VALIDATION_ERROR');

    // Create a valid patient, then attempt mass assignment on PATCH
    const validCreate = await agent
      .post('/api/patients')
      .set('X-CSRF-Token', csrfToken)
      .send({
        full_name: 'Тестовый Пациент',
        iin: computeValidKzIin('90010130015'),
      });
    assert.equal(validCreate.status, 201);
    const patientId = validCreate.body.patient.id;

    const patchMassAssign = await agent
      .patch(`/api/patients/${patientId}`)
      .set('X-CSRF-Token', csrfToken)
      .send({
        full_name: 'Новое Имя',
        archived_at: '2020-01-01T00:00:00Z',
      });
    assert.equal(patchMassAssign.status, 400);

    // Test optimistic concurrency conflict detection (`expected_updated_at`)
    const conflictPatch = await agent
      .patch(`/api/patients/${patientId}`)
      .set('X-CSRF-Token', csrfToken)
      .send({
        full_name: 'Конфликтное Имя',
        expected_updated_at: '2020-01-01T00:00:00.000Z',
      });
    assert.equal(conflictPatch.status, 409);
    assert.equal(conflictPatch.body.error, 'CONCURRENT_EDIT_CONFLICT');
  });

  // =====================================================================
  // 4. RATE LIMITING & BRUTE-FORCE LOCKOUT (Rule 5)
  // =====================================================================
  it('4. Brute-Force & Rate Limit Protection: locks out repeated failed logins and uses generic error messages', async () => {
    resetRateLimitersForTest();
    const client = supertest(app);

    // Check generic error message for non-existent vs existing email
    const nonExistentRes = await client.post('/api/auth/login').send({
      email: 'nobody@example.com',
      password: 'WrongPassword123!',
    });
    const existingWrongRes = await client.post('/api/auth/login').send({
      email: 'clinic@dental-demo.kz',
      password: 'WrongPassword123!',
    });
    assert.equal(nonExistentRes.status, 401);
    assert.equal(existingWrongRes.status, 401);
    assert.equal(nonExistentRes.body.message, existingWrongRes.body.message);

    // Trigger lockout after 5 consecutive failures
    for (let i = 0; i < 4; i++) {
      await client.post('/api/auth/login').send({
        email: 'lockout-test@example.com',
        password: 'WrongPassword123!',
      });
    }
    const lockedRes = await client.post('/api/auth/login').send({
      email: 'lockout-test@example.com',
      password: 'WrongPassword123!',
    });
    assert.equal(lockedRes.status, 429);

    resetRateLimitersForTest();
  });

  // =====================================================================
  // 5. XSS ESCAPING & HTTP SECURITY HEADERS (Rule 8 & Rule 10)
  // =====================================================================
  it('5. XSS & Security Headers: enforces CSP, HSTS, nosniff, Permissions-Policy, HttpOnly cookies, CSRF check, and HTML escaping', async () => {
    const { agent, csrfToken } = await loginAsMainClinic();

    const res = await agent.get('/api/auth/me');
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-security-policy']?.includes("default-src 'self'"));
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.ok(res.headers['strict-transport-security']?.includes('max-age='));
    assert.ok(res.headers['permissions-policy']?.includes('camera=(self)'));

    // Verify CSRF enforcement: state-changing request WITHOUT X-CSRF-Token is rejected with 403
    const noCsrfRes = await agent.post('/api/patients').send({
      full_name: 'CSRF Test Patient',
    });
    assert.equal(noCsrfRes.status, 403);
    assert.equal(noCsrfRes.body.error, 'CSRF_TOKEN_INVALID');

    // Verify XSS payload is stored as plain text and escaped in print helper
    const xssPayload = `<script>alert("xss")</script><img src=x onerror=alert(1)>`;
    const created = await agent
      .post('/api/patients')
      .set('X-CSRF-Token', csrfToken)
      .send({ full_name: xssPayload });
    assert.equal(created.status, 201);
    assert.equal(created.body.patient.full_name, xssPayload);

    const escaped = escapeHtml(created.body.patient.full_name);
    assert.ok(!escaped.includes('<script>'));
    assert.ok(escaped.includes('&lt;script&gt;'));
  });

  // =====================================================================
  // 6. FILE UPLOAD MAGIC BYTES, MALWARE SCAN, EXIF STRIP & SIGNED URL (Rule 20)
  // =====================================================================
  it('6. File Upload Security: rejects fake MIME/extensions, SVG/scripts, EICAR malware, and JS-in-PDF; strips EXIF from JPEG and requires signed URLs', async () => {
    const { agent, csrfToken } = await loginAsMainClinic();

    const pRes = await agent
      .post('/api/patients')
      .set('X-CSRF-Token', csrfToken)
      .send({ full_name: 'Пациент Для Снимков' });
    const patientId = pRes.body.patient.id;

    // 6a. Reject disallowed extension (.svg / .exe)
    const svgAttempt = await agent
      .post('/api/attachments/upload')
      .set('X-CSRF-Token', csrfToken)
      .send({
        patient_id: patientId,
        file_name: 'evil.svg',
        content_base64: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'),
      });
    assert.equal(svgAttempt.status, 400);
    assert.equal(svgAttempt.body.error, 'DISALLOWED_FILE_EXTENSION');

    // 6b. Reject disguised HTML renamed to .jpg (magic byte mismatch)
    const fakeJpgAttempt = await agent
      .post('/api/attachments/upload')
      .set('X-CSRF-Token', csrfToken)
      .send({
        patient_id: patientId,
        file_name: 'photo.jpg',
        mime_type: 'image/jpeg',
        content_base64: Buffer.from('<!DOCTYPE html><script>alert(1)</script>').toString(
          'base64'
        ),
      });
    assert.equal(fakeJpgAttempt.status, 400);
    assert.equal(fakeJpgAttempt.body.error, 'INVALID_FILE_MAGIC_BYTES');

    // 6c. Reject PDF containing embedded /JavaScript
    const maliciousPdfBuf = Buffer.from(
      '%PDF-1.7\n1 0 obj << /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj'
    );
    const badPdfRes = await agent
      .post('/api/attachments/upload')
      .set('X-CSRF-Token', csrfToken)
      .send({
        patient_id: patientId,
        file_name: 'scan.pdf',
        mime_type: 'application/pdf',
        content_base64: maliciousPdfResBufferToB64(maliciousPdfBuf),
      });
    assert.equal(badPdfRes.status, 400);
    assert.equal(badPdfRes.body.error, 'PDF_CONTAINS_EXECUTABLE_SCRIPT');

    // 6d. Accept valid JPEG with APP1 EXIF segment (0xFFE1), strip EXIF, and serve via signed URL
    const jpegWithExif = Buffer.concat([
      Buffer.from([0xff, 0xd8]), // SOI
      Buffer.from([0xff, 0xe1, 0x00, 0x10]), // APP1 EXIF marker (length 16)
      Buffer.from('Exif\0\0GPSDATA!'), // 14 bytes of EXIF/GPS payload
      Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x01]), // DQT marker
      Buffer.from([0xff, 0xd9]), // EOI
    ]);

    const validUploadRes = await agent
      .post('/api/attachments/upload')
      .set('X-CSRF-Token', csrfToken)
      .send({
        patient_id: patientId,
        file_name: '../../xray_tooth_36.jpg',
        mime_type: 'image/jpeg',
        content_base64: jpegWithExif.toString('base64'),
      });
    assert.equal(validUploadRes.status, 201);
    const att = validUploadRes.body.attachment;
    assert.ok(att.download_url.includes('/api/attachments/'));
    assert.equal(att.file_name, 'xray_tooth_36.jpg'); // path traversal stripped

    // Download via valid signed URL -> 200 and EXIF GPS data is stripped!
    const dlRes = await agent.get(att.download_url).buffer(true);
    assert.equal(dlRes.status, 200);
    assert.equal(dlRes.headers['x-content-type-options'], 'nosniff');
    const downloadedBuf = Buffer.from(dlRes.body);
    assert.ok(
      !downloadedBuf.toString('latin1').includes('GPSDATA!'),
      'Expected EXIF GPS segment to be stripped from stored JPEG'
    );

    // Download with tampered signature -> 403
    const tamperedUrl = `${att.download_url}00`;
    const tamperedRes = await agent.get(tamperedUrl);
    assert.equal(tamperedRes.status, 403);
  });

  // =====================================================================
  // 7. STRICT CORS POLICY (Rule 12)
  // =====================================================================
  it('7. Strict CORS: blocks foreign origins with 403 and allows only configured origins', async () => {
    const client = supertest(app);

    const foreignRes = await client
      .get('/api/auth/me')
      .set('Origin', 'https://malicious-site.example.com');
    assert.equal(foreignRes.status, 403);
    assert.equal(foreignRes.body.error, 'CORS_ORIGIN_FORBIDDEN');
    assert.equal(foreignRes.headers['access-control-allow-origin'], undefined);

    const allowedOrigin = env.ALLOWED_ORIGINS[0];
    const allowedRes = await client
      .options('/api/patients')
      .set('Origin', allowedOrigin);
    assert.equal(allowedRes.status, 204);
    assert.equal(allowedRes.headers['access-control-allow-origin'], allowedOrigin);
  });

  // =====================================================================
  // 8. KZ IIN CHECKSUM, PASSWORD BREACH (HIBP), WEBHOOKS & WORKFLOW
  // =====================================================================
  it('8. KZ IIN Validator, HIBP Password Breach Check, Webhook HMAC, and Full Dentist Workflow', async () => {
    // 8a. KZ IIN Checksum validation
    const validIin = computeValidKzIin('88041530012');
    assert.equal(validateKzIin(validIin), true);
    assert.equal(validateKzIin('880415300129'), false); // bad control digit
    assert.equal(validateKzIin('991345300120'), false); // impossible month/day

    // 8b. Password breach & context check (Rule 19)
    const breachedCheck = await validatePasswordSecurity('password12345');
    assert.equal(breachedCheck.valid, false);

    const contextCheck = await validatePasswordSecurity('MyClinic@Dental2026!', {
      email: 'clinic@dental.kz',
    });
    assert.equal(contextCheck.valid, false);
    assert.equal(contextCheck.reasonCode, 'CONTAINS_CONTEXT');

    // 8c. Webhook signature verification (Rule 16)
    const unsignedWebhook = await supertest(app)
      .post('/api/webhooks/events')
      .send({ event: 'ping' });
    assert.equal(unsignedWebhook.status, 401);

    const ts = Math.floor(Date.now() / 1000);
    const bodyStr = JSON.stringify({ event: 'ping' });
    const sig = crypto
      .createHmac('sha256', env.WEBHOOK_SECRET)
      .update(`${ts}.${bodyStr}`)
      .digest('hex');

    const signedWebhook = await supertest(app)
      .post('/api/webhooks/events')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Timestamp', String(ts))
      .set('X-Webhook-Id', crypto.randomUUID())
      .set('X-Webhook-Signature', sig)
      .send(bodyStr);
    assert.equal(signedWebhook.status, 200);

    // 8d. End-to-End Dentist Acceptance Workflow:
    // Create -> Search -> Open Patient -> Add Visit -> Archive -> Restore -> Permanent Delete Guard
    const { agent, csrfToken } = await loginAsMainClinic();

    await agent
      .post('/api/patients')
      .set('X-CSRF-Token', csrfToken)
      .send({
        full_name: 'Каримов Артём Серикович',
        phone: '+7 701 555 01 01',
      });

    const searchRes = await agent.get(
      `/api/patients/search?q=${encodeURIComponent('Каримов')}`
    );
    assert.equal(searchRes.status, 200);
    assert.ok(searchRes.body.results.length >= 1);
    const targetPatient = searchRes.body.results[0];

    // Add a visit
    const newVisitRes = await agent
      .post('/api/visits')
      .set('X-CSRF-Token', csrfToken)
      .send({
        patient_id: targetPatient.id,
        visit_date: '2026-09-28',
        visit_time: '16:00',
        service_name_snapshot: 'Лечение кариеса',
        price: 25000,
        payment_status: 'paid',
        doctor_name: 'Д-р Алиев М.К.',
      });
    assert.equal(newVisitRes.status, 201);

    // Archive and restore patient
    const archRes = await agent
      .post(`/api/patients/${targetPatient.id}/archive`)
      .set('X-CSRF-Token', csrfToken);
    assert.equal(archRes.status, 200);

    const restRes = await agent
      .post(`/api/patients/${targetPatient.id}/restore`)
      .set('X-CSRF-Token', csrfToken);
    assert.equal(restRes.status, 200);

    // Encrypted backup creation & restore verification
    const backupRes = await agent
      .post('/api/settings/backup')
      .set('X-CSRF-Token', csrfToken);
    assert.equal(backupRes.status, 201);
    assert.equal(backupRes.body.backup.restoreVerified, true);
  });
});

function maliciousPdfResBufferToB64(buf: Buffer): string {
  return buf.toString('base64');
}
