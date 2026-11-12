import { buildApp } from './app.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';

const db = createDb();
await migrate(db);

const app = await buildApp({ db, secureCookies: process.env.NODE_ENV === 'production' });
const port = Number(process.env.PORT ?? 3000);
// Alapból csak a helyi gépen figyel; VPS-en a fordított proxy (HTTPS) elé kerül.
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
console.log(`NoteTakerXC szerver: http://localhost:${port}`);
