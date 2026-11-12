import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { openStore } from './store.js';

const store = await openStore();

const webDir = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const app = await buildApp({
  store,
  secureCookies: process.env.NODE_ENV === 'production',
  webDir: existsSync(join(webDir, 'index.html')) ? webDir : undefined,
});
const port = Number(process.env.PORT ?? 3000);
// Alapból csak a helyi gépen figyel; VPS-en a fordított proxy (HTTPS) elé kerül.
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
console.log(`NoteTakerXC szerver: http://localhost:${port} (adatbázis: ${store.engine})`);
