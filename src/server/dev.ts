import { createServer as createViteServer } from 'vite';
import { env } from './config/env.js';
import { initializeDatabase } from './db/pool.js';
import { createApp } from './app.js';
import { globalErrorHandler } from './middleware/errorHandler.js';

async function startDevServer() {
  await initializeDatabase();
  const app = createApp();

  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });

  app.use(vite.middlewares);
  app.use(globalErrorHandler);

  app.listen(env.PORT, () => {
    console.log(
      `\n=====================================================================`
    );
    console.log(
      `  Digital Dental Notebook running at: http://localhost:${env.PORT}`
    );
    console.log(`  Environment: ${env.NODE_ENV} (PostgreSQL RLS Enabled & Forced)`);
    console.log(
      `=====================================================================\n`
    );
  });
}

startDevServer().catch((err) => {
  console.error('Failed to start dev server:', err);
  process.exit(1);
});
