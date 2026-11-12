import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createDb } from './db.js';
import { FORMAT, JsonDb, TABLES, type FileData, type Row } from './json-db.js';
import { migrate } from './migrate.js';
import { jsonFilePath } from './store.js';

/**
 * A PostgreSQL-adatbázis (DATABASE_URL) teljes tartalmának átírása a JSON-adatfájlba (JSON_DB_FILE),
 * a naplóval és a munkamenetekkel együtt. Meglévő fájlt csak --force kapcsolóval ír felül.
 */
const ORDER: Record<string, string> = { change_log: 'id', node_dates: 'node_id, starts_on', sessions: 'created_at' };

const plain = (value: unknown): unknown => (value instanceof Date ? value.toISOString() : value);

const file = jsonFilePath();
if (existsSync(file) && !process.argv.includes('--force')) {
  console.error(`Hiba: ${file} már létezik. Felülírás: npm run export-json -- --force`);
  process.exit(1);
}

const db = createDb();
try {
  await migrate(db);
  const tables = {} as FileData['tables'];
  for (const t of TABLES) {
    const { rows } = await db.query(`SELECT * FROM ${t} ORDER BY ${ORDER[t] ?? 'created_at'}`);
    tables[t] = rows.map((r: Row) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])));
  }
  // A napló azonosítói és tranzakciószámai a Postgresben bigint (szövegként jönnek).
  tables.change_log = tables.change_log.map((l) => ({ ...l, id: Number(l.id), tx_id: Number(l.tx_id) }));
  const max = (col: string) => Math.max(0, ...tables.change_log.map((l) => l[col] as number));
  const data: FileData = { format: FORMAT, next_log_id: max('id') + 1, next_tx_id: max('tx_id') + 1, tables };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 1));

  JsonDb.open(file); // ellenőrzés: a motor be tudja olvasni
  console.log(`Kész: ${file}`);
  for (const t of TABLES) console.log(`  ${t}: ${tables[t].length} sor`);
} finally {
  await db.end();
}
