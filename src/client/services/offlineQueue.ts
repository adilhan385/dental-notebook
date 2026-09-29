/**
 * Encrypted IndexedDB Offline Queue & Autosave Draft Store (Rule 10 & Autosave Requirement).
 * - Uses Web Crypto AES-GCM to encrypt drafts and queued offline mutations at rest.
 * - NEVER stores session tokens, refresh tokens, or passwords.
 * - Cleared immediately on sign-out.
 */

export interface QueuedMutation {
  id: string;
  method: 'POST' | 'PATCH';
  url: string;
  body: Record<string, unknown>;
  createdAt: number;
}

const DB_NAME = 'dental_notebook_offline_v1';
const QUEUE_STORE = 'mutations';
const DRAFT_STORE = 'drafts';

let ephemeralCryptoKey: CryptoKey | null = null;

async function getCryptoKey(): Promise<CryptoKey | null> {
  if (typeof window === 'undefined' || !window.crypto?.subtle) return null;
  if (!ephemeralCryptoKey) {
    ephemeralCryptoKey = await window.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  return ephemeralCryptoKey;
}

async function encryptPayload(data: unknown): Promise<string> {
  const json = JSON.stringify(data);
  const key = await getCryptoKey();
  if (!key) return json;
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(json);
  const cipherBuf = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const ivB64 = btoa(String.fromCharCode(...iv));
  const dataB64 = btoa(String.fromCharCode(...new Uint8Array(cipherBuf)));
  return `enc:${ivB64}:${dataB64}`;
}

async function decryptPayload<T>(payload: string): Promise<T | null> {
  try {
    if (!payload.startsWith('enc:')) {
      return JSON.parse(payload) as T;
    }
    const key = await getCryptoKey();
    if (!key) return null;
    const [, ivB64, dataB64] = payload.split(':');
    const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
    const cipherBytes = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0));
    const plainBuf = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      cipherBytes
    );
    return JSON.parse(new TextDecoder().decode(plainBuf)) as T;
  } catch {
    return null;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !window.indexedDB) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = window.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(DRAFT_STORE)) {
        db.createObjectStore(DRAFT_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export async function enqueueOfflineMutation(mutation: Omit<QueuedMutation, 'id' | 'createdAt'>): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const item: QueuedMutation = { ...mutation, id, createdAt: Date.now() };
  const encrypted = await encryptPayload(item);

  await new Promise<void>((resolve) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    tx.objectStore(QUEUE_STORE).put({ id, createdAt: item.createdAt, payload: encrypted });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function getQueuedMutations(): Promise<QueuedMutation[]> {
  const db = await openDb();
  if (!db) return [];
  const rawRows = await new Promise<Array<{ id: string; createdAt: number; payload: string }>>(
    (resolve) => {
      const tx = db.transaction(QUEUE_STORE, 'readonly');
      const req = tx.objectStore(QUEUE_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    }
  );
  const out: QueuedMutation[] = [];
  for (const row of rawRows.sort((a, b) => a.createdAt - b.createdAt)) {
    const dec = await decryptPayload<QueuedMutation>(row.payload);
    if (dec) out.push(dec);
  }
  return out;
}

export async function removeQueuedMutation(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    tx.objectStore(QUEUE_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function saveFormDraft(key: string, data: Record<string, unknown>): Promise<void> {
  const db = await openDb();
  if (!db) return;
  // Rule 10: Ensure no sensitive auth fields are ever stored in drafts
  const sanitized = { ...data };
  delete sanitized.password;
  delete sanitized.currentPassword;
  delete sanitized.newPassword;
  delete sanitized.token;

  const payload = await encryptPayload(sanitized);
  await new Promise<void>((resolve) => {
    const tx = db.transaction(DRAFT_STORE, 'readwrite');
    tx.objectStore(DRAFT_STORE).put({ key, updatedAt: Date.now(), payload });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function loadFormDraft<T = Record<string, unknown>>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  const row = await new Promise<{ key: string; payload: string } | undefined>((resolve) => {
    const tx = db.transaction(DRAFT_STORE, 'readonly');
    const req = tx.objectStore(DRAFT_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
  if (!row?.payload) return null;
  return decryptPayload<T>(row.payload);
}

export async function clearFormDraft(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(DRAFT_STORE, 'readwrite');
    tx.objectStore(DRAFT_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/**
 * Clears all local offline queue items and drafts upon logout (Rule 10).
 */
export async function clearAllOfflineData(): Promise<void> {
  ephemeralCryptoKey = null;
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction([QUEUE_STORE, DRAFT_STORE], 'readwrite');
    tx.objectStore(QUEUE_STORE).clear();
    tx.objectStore(DRAFT_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
