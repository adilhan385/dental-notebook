import {
  enqueueOfflineMutation,
  getQueuedMutations,
  removeQueuedMutation,
  clearAllOfflineData,
} from './offlineQueue';

/**
 * In-memory CSRF token (Rule 10: NEVER stored in localStorage or sessionStorage).
 * Session & refresh tokens live exclusively in HttpOnly + Secure + SameSite=Strict cookies.
 */
let csrfTokenMemory = '';

export function setCsrfToken(token: string): void {
  csrfTokenMemory = token;
}

export function getCsrfToken(): string {
  return csrfTokenMemory;
}

export class ApiError extends Error {
  status: number;
  code: string;
  refId?: string;
  queuedOffline?: boolean;

  constructor(
    message: string,
    status: number,
    code = 'API_ERROR',
    refId?: string,
    queuedOffline = false
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.refId = refId;
    this.queuedOffline = queuedOffline;
  }
}

export async function apiFetch<T = any>(
  url: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: Record<string, any>;
    allowOfflineQueue?: boolean;
  } = {}
): Promise<T> {
  const method = options.method || 'GET';
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (method !== 'GET' && csrfTokenMemory) {
    headers['X-CSRF-Token'] = csrfTokenMemory;
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (res.status === 401 && url !== '/api/auth/login' && url !== '/api/auth/me') {
      // Attempt silent token rotation via HttpOnly refresh cookie
      const refreshRes = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });
      if (refreshRes.ok) {
        const refreshData = await refreshRes.json();
        if (refreshData.csrfToken) {
          csrfTokenMemory = refreshData.csrfToken;
          headers['X-CSRF-Token'] = csrfTokenMemory;
        }
        const retryRes = await fetch(url, {
          method,
          headers,
          credentials: 'include',
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });
        if (retryRes.ok) {
          return (await retryRes.json()) as T;
        }
      }
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(
        data.message || 'Ошибка при выполнении запроса.',
        res.status,
        data.error || 'REQUEST_FAILED',
        data.refId
      );
    }
    return data as T;
  } catch (err) {
    if (err instanceof ApiError) {
      throw err;
    }

    // Network drop: queue safe patient/visit/appointment edits in encrypted IndexedDB (Autosave requirement)
    if (
      options.allowOfflineQueue &&
      (method === 'POST' || method === 'PATCH') &&
      options.body
    ) {
      await enqueueOfflineMutation({
        method,
        url,
        body: options.body,
      });
      throw new ApiError(
        'Не удалось сохранить изменения. Мы сохранили их локально и попробуем синхронизировать автоматически.',
        0,
        'OFFLINE_QUEUED',
        undefined,
        true
      );
    }

    throw new ApiError(
      'Нет соединения с сервером. Проверьте подключение к интернету.',
      0,
      'NETWORK_ERROR'
    );
  }
}

/**
 * Flushes any queued offline edits when internet connection returns.
 */
export async function syncOfflineMutations(): Promise<number> {
  const queue = await getQueuedMutations();
  let syncedCount = 0;
  for (const item of queue) {
    try {
      await apiFetch(item.url, {
        method: item.method,
        body: item.body,
        allowOfflineQueue: false,
      });
      await removeQueuedMutation(item.id);
      syncedCount++;
    } catch {
      break;
    }
  }
  return syncedCount;
}

export async function performLogout(): Promise<void> {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // ignore
  }
  csrfTokenMemory = '';
  await clearAllOfflineData();
}
