# Digital Dental Notebook (`Цифровой блокнот стоматолога`)

A fast, simple, trilingual (`RU` / `KZ` / `EN`) clinical web application designed to replace a dentist's paper notebook with instant patient search, treatment history, calendar, photo/file attachments, lightweight finances, separate stock inventory, and strict clinical-grade security.

---

## 1. Quick Start (Development)

```bash
# 1. Install dependencies
npm install

# 2. Run secret scan & security test suite
npm run security:scan
npm test

# 3. Start the application (http://localhost:3001)
npm run dev
```

---

## 2. How to Deploy Securely in Production

1. **Copy `.env.example` to `.env`** on your production host (never commit `.env` to Git):
   ```bash
   cp .env.example .env
   ```
2. **Generate 256-bit cryptographic secrets** for `SESSION_SECRET`, `SIGNED_URL_SECRET`, `BACKUP_ENCRYPTION_KEY`, and `WEBHOOK_SECRET`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. **Configure `ALLOWED_ORIGINS`** to your exact HTTPS domain (e.g. `https://notebook.your-dental-clinic.kz`). Never use `*`.
4. **Configure PostgreSQL (`DATABASE_URL`)** with TLS (`?sslmode=require`). On first start, the server automatically provisions the `auth_internal` schema, the least-privilege `clinic_app_role`, and enables + forces PostgreSQL Row-Level Security (RLS) on every table.
5. **Build and start**:
   ```bash
   NODE_ENV=production npm run build
   NODE_ENV=production npm start
   ```

---

## 3. How to Rotate Secrets

1. Generate new 32-byte hex values for `SESSION_SECRET` and `SIGNED_URL_SECRET`.
2. If rotating `BACKUP_ENCRYPTION_KEY`, decrypt existing backup archives with the old key first or archive the old key in your offline vault for historical backup restoration.
3. Restart the application server; all existing browser sessions will cleanly prompt the dentist to sign in again while keeping any unsaved local drafts intact.

---

## 4. How to Create & Restore from Encrypted Backups

- **Create & verify an encrypted backup via CLI**:
  ```bash
  npm run backup:create
  ```
  Or click **"Создать и проверить резервную копию сейчас"** in **Settings → Security**.
- Backups are encrypted with **AES-256-GCM** using `BACKUP_ENCRYPTION_KEY` and stored in `./data/backups/` (store off-site copies in a separate cloud storage account from production credentials).
- **Restore verification**: Every backup creation automatically performs a full AES-256-GCM decryption and record-count verification round-trip before succeeding. To decrypt a `.enc` backup file manually:
  ```bash
  node --import tsx -e "import fs from 'fs'; import { decryptAesGcm } from './src/server/security/crypto.ts'; console.log(decryptAesGcm(fs.readFileSync(process.argv[1], 'utf8')));" ./data/backups/<backup-file>.enc > restored.json
  ```

---

## 5. Dependency Update Routine (Rule 18)

1. Run `npm audit` weekly (automated in `.github/workflows/security.yml` and `.github/dependabot.yml`).
2. Check outdated packages with `npm outdated`.
3. Update minor/patch versions with `npm update`, run `npm test` and `npm run typecheck`, and commit the updated `package-lock.json`.
