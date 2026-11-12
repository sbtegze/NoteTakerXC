import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.js';
import { createDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import * as nodes from './nodes.js';
import * as notes from './notes.js';

type Tail<F> = F extends (db: Db, ...args: infer A) => infer R ? (...args: A) => R : never;

/**
 * Az adatbázismotor felülete: minden, amit a szerver az adatokkal csinál. Két megvalósítása van:
 * a PostgreSQL (`DB_ENGINE=postgres`) és a JSON-fájl (`DB_ENGINE=json`).
 */
export interface Store {
  engine: 'postgres' | 'json';
  createUser: Tail<typeof auth.createUser>;
  login: Tail<typeof auth.login>;
  userForToken: Tail<typeof auth.userForToken>;
  logout: Tail<typeof auth.logout>;
  createNode: Tail<typeof nodes.createNode>;
  updateNode: Tail<typeof nodes.updateNode>;
  deleteNode: Tail<typeof nodes.deleteNode>;
  moveNode: Tail<typeof nodes.moveNode>;
  listByType: Tail<typeof nodes.listByType>;
  getRoots: Tail<typeof nodes.getRoots>;
  getNeighborhood: Tail<typeof nodes.getNeighborhood>;
  searchNodes: Tail<typeof nodes.searchNodes>;
  createNote: Tail<typeof notes.createNote>;
  updateNote: Tail<typeof notes.updateNote>;
  deleteNote: Tail<typeof notes.deleteNote>;
  close(): Promise<void>;
}

/** A PostgreSQL-motor: a meglévő SQL-es függvények egy kapcsolatkészlethez kötve. */
export function pgStore(db: Db): Store {
  return {
    engine: 'postgres',
    createUser: (...a) => auth.createUser(db, ...a),
    login: (...a) => auth.login(db, ...a),
    userForToken: (...a) => auth.userForToken(db, ...a),
    logout: (...a) => auth.logout(db, ...a),
    createNode: (...a) => nodes.createNode(db, ...a),
    updateNode: (...a) => nodes.updateNode(db, ...a),
    deleteNode: (...a) => nodes.deleteNode(db, ...a),
    moveNode: (...a) => nodes.moveNode(db, ...a),
    listByType: (...a) => nodes.listByType(db, ...a),
    getRoots: () => nodes.getRoots(db),
    getNeighborhood: (...a) => nodes.getNeighborhood(db, ...a),
    searchNodes: (...a) => nodes.searchNodes(db, ...a),
    createNote: (...a) => notes.createNote(db, ...a),
    updateNote: (...a) => notes.updateNote(db, ...a),
    deleteNote: (...a) => notes.deleteNote(db, ...a),
    close: () => db.end(),
  };
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A JSON-adatfájl helye: JSON_DB_FILE, a repó gyökeréhez képest (alapból data/notetaker.json). */
export function jsonFilePath(env = process.env): string {
  return resolve(REPO_ROOT, env.JSON_DB_FILE || 'data/notetaker.json');
}

/** A .env DB_ENGINE értéke szerinti motor megnyitása (alapból postgres). A Postgres sémáját frissíti. */
export async function openStore(env = process.env): Promise<Store> {
  const engine = (env.DB_ENGINE || 'postgres').trim().toLowerCase();
  if (engine === 'json') {
    const { openJsonStore } = await import('./json-store.js');
    return openJsonStore(jsonFilePath(env));
  }
  if (engine !== 'postgres') throw new Error(`Ismeretlen DB_ENGINE: "${engine}" (postgres vagy json lehet)`);
  const db = createDb(env.DATABASE_URL);
  await migrate(db);
  return pgStore(db);
}
