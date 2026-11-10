import { buildApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { redis, redisSub } from './redis.js';
import { startFiscalWorker } from './services/fiscal/worker.js';

const app = await buildApp();
const stopFiscal = startFiscalWorker((m) => app.log.warn(m));
await app.listen({ port: config.PORT, host: config.HOST });

// Mbyllje e rregullt: përfundo kërkesat në proces para se kontejneri të ndalet (update pa humbje).
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} — po mbyllet`);
    stopFiscal();
    await app.close();
    await pool.end();
    redis.disconnect(); redisSub.disconnect();
    process.exit(0);
  });
}
