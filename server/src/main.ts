import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';

const db = createDb();
await migrate(db);

const webDir = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const app = await buildApp({
  db,
  secureCookies: process.env.NODE_ENV === 'production',
  webDir: existsSync(join(webDir, 'index.html')) ? webDir : undefined,
});
const port = Number(process.env.PORT ?? 3000);
// Alapból csak a helyi gépen figyel; VPS-en a fordított proxy (HTTPS) elé kerül.
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
console.log(`NoteTakerXC szerver: http://localhost:${port}`);
