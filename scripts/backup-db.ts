import fs from 'node:fs';
import path from 'node:path';
import { env } from '../src/server/config/env.js';
import { initializeDatabase, queryInternal } from '../src/server/db/pool.js';
import { encryptAesGcm, decryptAesGcm } from '../src/server/security/crypto.js';

async function runBackupAndVerifyRestore() {
  await initializeDatabase();

  const [clinics, patients, visits, appointments, services, inventory, transactions] =
    await Promise.all([
      queryInternal('SELECT * FROM public.clinics'),
      queryInternal('SELECT * FROM public.patients'),
      queryInternal('SELECT * FROM public.visits'),
      queryInternal('SELECT * FROM public.appointments'),
      queryInternal('SELECT * FROM public.services'),
      queryInternal('SELECT * FROM public.inventory_items'),
      queryInternal('SELECT * FROM public.inventory_transactions'),
    ]);

  const snapshot = {
    version: 1,
    createdAt: new Date().toISOString(),
    data: {
      clinics: clinics.rows,
      patients: patients.rows,
      visits: visits.rows,
      appointments: appointments.rows,
      services: services.rows,
      inventoryItems: inventory.rows,
      inventoryTransactions: transactions.rows,
    },
  };

  const encrypted = encryptAesGcm(JSON.stringify(snapshot));
  fs.mkdirSync(env.BACKUP_DIR, { recursive: true });
  const filePath = path.resolve(env.BACKUP_DIR, `full-backup-${Date.now()}.enc`);
  fs.writeFileSync(filePath, encrypted, { mode: 0o600 });

  // Test restore decryption round-trip
  const diskData = fs.readFileSync(filePath, 'utf8');
  const restoredJson = JSON.parse(decryptAesGcm(diskData));

  if (restoredJson.data.patients.length !== patients.rows.length) {
    throw new Error('Backup restore verification count mismatch!');
  }

  console.log(
    `[BACKUP SUCCESS] Encrypted AES-256-GCM backup written to ${filePath} and restore verified (${patients.rows.length} patients, ${visits.rows.length} visits).`
  );
}

runBackupAndVerifyRestore().catch((err) => {
  console.error('Backup failed:', err);
  process.exit(1);
});
