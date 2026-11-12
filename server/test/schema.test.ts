import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, type User } from '../src/auth.js';
import { withUser, type Db } from '../src/db.js';
import { freshPgDb, TEST_PASSWORD } from './helpers.js';

// A Postgres-séma triggerei és korlátozásai; a JSON-motor megfelelője a json-db.test.ts.

let db: Db;
let user: User;

beforeAll(async () => {
  db = await freshPgDb();
  user = await createUser(db, 'teszt@example.com', 'Teszt Elek', TEST_PASSWORD);
});

afterAll(() => db.end());

const addNode = (content: string) =>
  withUser(db, user.id, async (tx) => {
    const { rows } = await tx.query(
      'INSERT INTO nodes (content, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id',
      [content, user.id],
    );
    return rows[0].id as string;
  });

const logFor = async (id: string) =>
  (await db.query('SELECT action, old_state, new_state, changed_by FROM change_log WHERE entity_id = $1 ORDER BY id', [id]))
    .rows;

describe('séma', () => {
  it('a node szerkesztése növeli a verziót és naplózódik, a változatlan mentés nem', async () => {
    const id = await addNode('első');
    await withUser(db, user.id, (tx) => tx.query('UPDATE nodes SET content = $1 WHERE id = $2', ['második', id]));
    await withUser(db, user.id, (tx) => tx.query('UPDATE nodes SET content = $1 WHERE id = $2', ['második', id]));

    const { rows } = await db.query('SELECT version FROM nodes WHERE id = $1', [id]);
    expect(rows[0].version).toBe(2);

    const log = await logFor(id);
    expect(log.map((l) => l.action)).toEqual(['create', 'update']);
    expect(log[1].old_state.content).toBe('első');
    expect(log[1].new_state.content).toBe('második');
    expect(log[1].changed_by).toBe(user.id);
  });

  it('ütközésnél a verzióra szűrt mentés 0 sort módosít', async () => {
    const id = await addNode('a');
    await withUser(db, user.id, (tx) => tx.query('UPDATE nodes SET content = $1 WHERE id = $2', ['b', id]));
    const stale = await db.query('UPDATE nodes SET content = $1 WHERE id = $2 AND version = 1', ['c', id]);
    expect(stale.rowCount).toBe(0);
  });

  it('a törlés és a visszaállítás külön naplóbejegyzés', async () => {
    const id = await addNode('törlendő');
    await withUser(db, user.id, (tx) => tx.query('UPDATE nodes SET deleted_at = now() WHERE id = $1', [id]));
    await withUser(db, user.id, (tx) => tx.query('UPDATE nodes SET deleted_at = NULL WHERE id = $1', [id]));
    expect((await logFor(id)).map((l) => l.action)).toEqual(['create', 'delete', 'restore']);
  });

  it('a kapcsolat korlátozásai működnek, a változások naplózódnak', async () => {
    const [a, b] = [await addNode('A'), await addNode('B')];
    const edge = (source: string, target: string, kind: string) =>
      withUser(db, user.id, async (tx) => {
        const { rows } = await tx.query(
          'INSERT INTO edges (source_id, target_id, kind, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
          [source, target, kind, user.id],
        );
        return rows[0].id as string;
      });

    const id = await edge(a, b, 'unsorted');
    await expect(edge(a, b, 'unsorted')).rejects.toThrow(/unique/i);
    await expect(edge(a, a, 'mention')).rejects.toThrow(/check/i);
    const [hi, lo] = a > b ? [a, b] : [b, a];
    await expect(edge(hi, lo, 'related')).rejects.toThrow(/check/i);
    await expect(edge(a, b, 'ismeretlen')).rejects.toThrow(/check/i);

    await withUser(db, user.id, (tx) => tx.query("UPDATE edges SET kind = 'belongs_to', role = 'aktív' WHERE id = $1", [id]));
    await withUser(db, user.id, (tx) => tx.query('DELETE FROM edges WHERE id = $1', [id]));
    expect((await logFor(id)).map((l) => l.action)).toEqual(['create', 'update', 'remove']);
  });

  it('a komment alapból publikus, a privát érték fenn van tartva', async () => {
    const node = await addNode('kommentelt');
    const { rows } = await withUser(db, user.id, (tx) =>
      tx.query('INSERT INTO notes (node_id, content, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id, visibility', [
        node,
        'megjegyzés',
        user.id,
      ]),
    );
    expect(rows[0].visibility).toBe('public');
    await db.query("UPDATE notes SET visibility = 'private' WHERE id = $1", [rows[0].id]);
    await expect(db.query("UPDATE notes SET visibility = 'titkos' WHERE id = $1", [rows[0].id])).rejects.toThrow(/check/i);
    expect((await logFor(rows[0].id)).map((l) => l.action)).toEqual(['create', 'update']);
  });

  it('nincs nyitó node: az is_inbox oszlop megszűnt', async () => {
    await expect(db.query('SELECT is_inbox FROM nodes')).rejects.toThrow(/is_inbox/);
  });

  it('a napló nem írható át és nem törölhető', async () => {
    await expect(db.query('UPDATE change_log SET action = $1', ['update'])).rejects.toThrow(/nem módosítható/);
    await expect(db.query('DELETE FROM change_log')).rejects.toThrow(/nem módosítható/);
  });

  it('a dátumtartomány nem végződhet a kezdete előtt', async () => {
    const node = await addNode('dátumos');
    const ins = (from: string, to: string) =>
      db.query('INSERT INTO node_dates (node_id, starts_on, ends_on, source_text) VALUES ($1, $2, $3, $4) RETURNING starts_on', [
        node,
        from,
        to,
        'x',
      ]);
    expect((await ins('2026-12-22', '2027-01-02')).rows[0].starts_on).toBe('2026-12-22');
    await expect(ins('2026-12-22', '2026-12-01')).rejects.toThrow(/check/i);
  });
});
