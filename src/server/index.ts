import { env } from './config/env.js';
import { initializeDatabase } from './db/pool.js';
import { createApp } from './app.js';

async function main() {
  await initializeDatabase();
  const app = createApp();

  app.listen(env.PORT, () => {
    console.log(
      `[Digital Dental Notebook] Production server running on http://localhost:${env.PORT}`
    );
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
