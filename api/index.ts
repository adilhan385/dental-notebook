import { createApp } from '../src/server/app.js';
import { initializeDatabase } from '../src/server/db/pool.js';

const app = createApp();
let initPromise: Promise<void> | null = null;

export default async function handler(req: any, res: any) {
  if (!initPromise) {
    initPromise = initializeDatabase();
  }
  await initPromise;
  return app(req, res);
}
