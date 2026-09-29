#!/usr/bin/env node
/**
 * Automated Secret & Credential Scanner (Rule 1 & Rule 2 enforcement)
 * Scans tracked/staged files for accidental secrets, private keys, connection strings,
 * or forbidden NEXT_PUBLIC_ / VITE_ secret exposures.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const FORBIDDEN_FILENAMES = [
  /^\.env$/,
  /^\.env\.(?!example$).+$/,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /service-account.*\.json$/i,
];

const SECRET_PATTERNS = [
  {
    name: 'Private Key Block',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/,
  },
  {
    name: 'Hardcoded Postgres Connection String with Credentials',
    regex: /postgres(?:ql)?:\/\/[^:\s'"]+:[^@\s'"]+@[^/\s'"]+/i,
  },
  {
    name: 'AWS / Cloud Access Key',
    regex: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: 'Frontend Exposed Secret Variable (VITE_ or NEXT_PUBLIC_)',
    regex: /\b(?:VITE|NEXT_PUBLIC)_(?:SECRET|SERVICE_ROLE|PRIVATE|DB_PASSWORD|MASTER_KEY|API_SECRET)\b/i,
  },
  {
    name: 'Supabase Service Role JWT',
    regex: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]*service_role[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/,
  },
];

function getFilesToScan() {
  try {
    const out = execSync('git ls-files --cached --others --exclude-standard', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    // Fallback directory walk if git is not initialized yet
    const results = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', 'data', 'coverage'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else results.push(path.relative(process.cwd(), full).replace(/\\/g, '/'));
      }
    }
    walk(process.cwd());
    return results;
  }
}

let violations = 0;
const files = getFilesToScan();

for (const file of files) {
  const base = path.basename(file);
  for (const forbidden of FORBIDDEN_FILENAMES) {
    if (forbidden.test(base)) {
      console.error(`[SECRET-SCAN FAIL] Forbidden secret file tracked: ${file}`);
      violations++;
    }
  }

  if (
    file === 'scripts/secret-scan.mjs' ||
    file === '.gitleaks.toml' ||
    file.endsWith('.png') ||
    file.endsWith('.jpg') ||
    file.endsWith('.woff2') ||
    file === 'package-lock.json'
  ) {
    continue;
  }

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
  const content = fs.readFileSync(file, 'utf8');

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(content)) {
      console.error(`[SECRET-SCAN FAIL] ${pattern.name} detected in ${file}`);
      violations++;
    }
  }
}

if (violations > 0) {
  console.error(`\nSecret scan failed with ${violations} violation(s). Commit aborted.`);
  process.exit(1);
} else {
  console.log(`[SECRET-SCAN PASS] Scanned ${files.length} files. Zero secrets or forbidden files detected.`);
}
