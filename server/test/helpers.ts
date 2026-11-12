import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '../src/auth.js';
import { createDb, type Db } from '../src/db.js';
import type { Row, Table } from '../src/json-db.js';
import { openJsonStore } from '../src/json-store.js';
import { migrate } from '../src/migrate.js';
import { pgStore, type Store } from '../src/store.js';

/** A vitest projekt választja (vitest.config.ts): json vagy postgres. */
export const ENGINE = (process.env.TEST_DB_ENGINE ?? 'json') as 'json' | 'postgres';

const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgres://notetaker:notetaker@localhost:5432/notetaker_test';

/**
 * Motorfüggetlen tesztadatbázis: a szerver a `store`-on át éri el, a teszt a táblákat közvetlenül is
 * olvashatja és átírhatja (a szűrés JavaScriptben, így mindkét motoron ugyanaz).
 */
export interface TestDb {
  store: Store;
  rows(table: Table): Promise<Row[]>;
  insert(table: Table, row: Row): Promise<void>;
  update(table: Table, where: (r: Row) => boolean, set: Row): Promise<void>;
  remove(table: Table, where: (r: Row) => boolean): Promise<void>;
  end(): Promise<void>;
}

const ORDER: Partial<Record<Table, string>> = { change_log: 'id', sessions: 'created_at', node_dates: 'starts_on' };

/** Tiszta tesztadatbázis. Soha ne mutasson éles adatbázisra. */
export async function freshDb(): Promise<TestDb> {
  return ENGINE === 'json' ? freshJson() : freshPg();
}

let counter = 0;

/** Az ideiglenes JSON-fájl helye: minden tesztfájl sajátot kap. */
export function tempJsonFile(): string {
  return join(tmpdir(), `notetaker-test-${process.pid}-${Date.now()}-${counter++}.json`);
}

async function freshJson(): Promise<TestDb> {
  const file = tempJsonFile();
  const store = openJsonStore(file);
  const db = () => store.db;
  const keys = (r: Row) => String(r.id ?? r.token_hash);
  return {
    store,
    rows: async (table) => db().read((tx) => [...tx.rows(table)]),
    insert: async (table, row) => {
      await db().write(null, (tx) => tx.insert(table, row));
    },
    update: async (table, where, set) => {
      await db().write(null, (tx) => [...tx.rows(table)].filter(where).forEach((r) => tx.update(table, keys(r), set)));
    },
    remove: async (table, where) => {
      await db().write(null, (tx) => [...tx.rows(table)].filter(where).forEach((r) => tx.remove(table, keys(r))));
    },
    end: async () => {
      await store.close();
      rmSync(file, { force: true });
    },
  };
}

/** Tiszta séma a Postgres-tesztadatbázisban (a séma triggereit közvetlenül tesztelőknek). */
export async function freshPgDb(): Promise<Db> {
  if (!/test/.test(new URL(TEST_URL).pathname)) {
    throw new Error('A TEST_DATABASE_URL adatbázisnevében szerepelnie kell a "test" szónak');
  }
  const db = createDb(TEST_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  return db;
}

async function freshPg(): Promise<TestDb> {
  const db = await freshPgDb();
  const ids = async (table: Table, where: (r: Row) => boolean) =>
    (await db.query(`SELECT * FROM ${table}`)).rows.filter(where).map((r) => r.id);
  return {
    store: pgStore(db),
    rows: async (table) => (await db.query(`SELECT * FROM ${table} ORDER BY ${ORDER[table] ?? 'created_at'}`)).rows,
    insert: async (table, row) => {
      const cols = Object.keys(row);
      await db.query(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    },
    update: async (table, where, set) => {
      const cols = Object.keys(set);
      await db.query(
        `UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = ANY($1::uuid[])`,
        [await ids(table, where), ...Object.values(set)],
      );
    },
    remove: async (table, where) => {
      await db.query(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [await ids(table, where)]);
    },
    end: () => db.end(),
  };
}

export const TEST_PASSWORD = 'helyes-jelszo-123';

export function testUser(db: TestDb, email = 'teszt@example.com'): Promise<User> {
  return db.store.createUser(email, 'Teszt Elek', TEST_PASSWORD);
}

/** A node-ok id szerint, a kapcsolatok kiírásához. */
export async function nodeMap(db: TestDb): Promise<Map<string, Row>> {
  return new Map((await db.rows('nodes')).map((n) => [n.id as string, n]));
}
