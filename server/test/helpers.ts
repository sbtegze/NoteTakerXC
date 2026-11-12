import { createUser, type User } from '../src/auth.js';
import { createDb, type Db } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://notetaker:notetaker@localhost:5432/notetaker_test';

/** Tiszta sémát épít a tesztadatbázisban. Soha ne mutasson éles adatbázisra. */
export async function freshDb(): Promise<Db> {
  if (!/test/.test(new URL(TEST_URL).pathname)) {
    throw new Error('A TEST_DATABASE_URL adatbázisnevében szerepelnie kell a "test" szónak');
  }
  const db = createDb(TEST_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  return db;
}

export const TEST_PASSWORD = 'helyes-jelszo-123';

export function testUser(db: Db, email = 'teszt@example.com'): Promise<User> {
  return createUser(db, email, 'Teszt Elek', TEST_PASSWORD);
}
