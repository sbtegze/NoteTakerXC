import { createUser } from './auth.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';

const [email, displayName, password] = process.argv.slice(2);
if (!email || !displayName || !password) {
  console.error('Használat: npm run create-user -- <e-mail> <megjelenített név> <jelszó>');
  process.exit(1);
}

const db = createDb();
await migrate(db);
const user = await createUser(db, email, displayName, password);
console.log(`Felhasználó kész: ${user.email}`);
await db.end();
