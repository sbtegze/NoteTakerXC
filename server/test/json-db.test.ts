import { readFileSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JsonDb, type Row } from '../src/json-db.js';
import { openJsonStore } from '../src/json-store.js';
import { tempJsonFile, TEST_PASSWORD } from './helpers.js';

// A JSON-motor „sémája”: a Postgres-triggerek és -korlátozások megfelelője (vö. schema.test.ts),
// és a fájlba mentés.

const file = tempJsonFile();
let db: JsonDb;
let userId: string;

beforeAll(async () => {
  db = JsonDb.open(file);
  userId = (await db.write(null, (tx) => tx.insert('users', { email: 'a@b.hu', display_name: 'A', password_hash: 'x' })))
    .id as string;
});

afterAll(() => rmSync(file, { force: true }));

const addNode = async (content: string) =>
  (await db.write(userId, (tx) => tx.insert('nodes', { content, created_by: userId, updated_by: userId }))).id as string;
const setNode = (id: string, changes: Row) => db.write(userId, (tx) => tx.update('nodes', id, changes));
const logFor = (id: string) => db.read((tx) => [...tx.rows('change_log')].filter((l) => l.entity_id === id));

describe('JSON-motor', () => {
  it('a node szerkesztése növeli a verziót és naplózódik, a változatlan mentés nem', async () => {
    const id = await addNode('első');
    await setNode(id, { content: 'második' });
    await setNode(id, { content: 'második', updated_by: userId });
    expect(db.read((tx) => tx.get('nodes', id)!.version)).toBe(2);

    const log = logFor(id);
    expect(log.map((l) => l.action)).toEqual(['create', 'update']);
    expect((log[1]!.old_state as Row).content).toBe('első');
    expect((log[1]!.new_state as Row).content).toBe('második');
    expect(log[1]!.changed_by).toBe(userId);
  });

  it('a törlés és a visszaállítás külön naplóbejegyzés', async () => {
    const id = await addNode('törlendő');
    await setNode(id, { deleted_at: new Date().toISOString() });
    await setNode(id, { deleted_at: null });
    expect(logFor(id).map((l) => l.action)).toEqual(['create', 'delete', 'restore']);
  });

  it('a kapcsolat korlátozásai működnek, a változások naplózódnak', async () => {
    const [a, b] = [await addNode('A'), await addNode('B')];
    const edge = async (source: string, target: string, kind: string) =>
      (await db.write(userId, (tx) => tx.insert('edges', { source_id: source, target_id: target, kind, created_by: userId })))
        .id as string;

    const id = await edge(a, b, 'unsorted');
    await expect(edge(a, b, 'unsorted')).rejects.toThrow(/unique/i);
    await expect(edge(a, a, 'mention')).rejects.toThrow(/check/i);
    const [hi, lo] = a > b ? [a, b] : [b, a];
    await expect(edge(hi, lo, 'related')).rejects.toThrow(/check/i);
    await expect(edge(a, b, 'ismeretlen')).rejects.toThrow(/check/i);
    await expect(edge(a, '00000000-0000-4000-8000-000000000000', 'unsorted')).rejects.toThrow(/foreign key/i);
    await expect(db.write(userId, (tx) => tx.remove('nodes', a))).rejects.toThrow(/foreign key/i);

    await db.write(userId, (tx) => tx.update('edges', id, { kind: 'belongs_to', role: 'aktív' }));
    await db.write(userId, (tx) => tx.remove('edges', id));
    expect(logFor(id).map((l) => l.action)).toEqual(['create', 'update', 'remove']);
  });

  it('a komment alapból publikus, a privát érték fenn van tartva', async () => {
    const node = await addNode('kommentelt');
    const note = await db.write(userId, (tx) =>
      tx.insert('notes', { node_id: node, content: 'megjegyzés', created_by: userId, updated_by: userId }),
    );
    expect(note.visibility).toBe('public');
    await db.write(userId, (tx) => tx.update('notes', note.id as string, { visibility: 'private' }));
    await expect(db.write(userId, (tx) => tx.update('notes', note.id as string, { visibility: 'titkos' }))).rejects.toThrow(
      /check/i,
    );
    expect(logFor(note.id as string).map((l) => l.action)).toEqual(['create', 'update']);
  });

  it('a napló nem írható át és nem törölhető', async () => {
    await expect(db.write(null, (tx) => tx.update('change_log', '1', { action: 'update' }))).rejects.toThrow(/nem módosítható/);
    await expect(db.write(null, (tx) => tx.remove('change_log', '1'))).rejects.toThrow(/nem módosítható/);
  });

  it('a dátumtartomány nem végződhet a kezdete előtt; a node törlésével a dátumai is mennek', async () => {
    const node = await addNode('dátumos');
    const ins = (from: string, to: string) =>
      db.write(null, (tx) => tx.insert('node_dates', { node_id: node, starts_on: from, ends_on: to, source_text: 'x' }));
    expect((await ins('2026-12-22', '2027-01-02')).starts_on).toBe('2026-12-22');
    await expect(ins('2026-12-22', '2026-12-01')).rejects.toThrow(/check/i);
    await db.write(userId, (tx) => tx.remove('nodes', node));
    expect(db.read((tx) => [...tx.rows('node_dates')].filter((d) => d.node_id === node))).toEqual([]);
  });

  it('hibás művelet után semmi sem marad belőle, a fájl sem változik', async () => {
    const before = readFileSync(file, 'utf8');
    await expect(
      db.write(userId, (tx) => {
        tx.insert('nodes', { content: 'félkész', created_by: userId, updated_by: userId });
        throw new Error('megszakadt');
      }),
    ).rejects.toThrow('megszakadt');
    expect(db.read((tx) => [...tx.rows('nodes')].some((n) => n.content === 'félkész'))).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('a fájlba ment, újranyitva minden megvan; a napló sorszáma folytatódik', async () => {
    const id = await addNode('tartós');
    const reopened = JsonDb.open(file);
    expect(reopened.read((tx) => tx.get('nodes', id)?.content)).toBe('tartós');
    const lastLog = Math.max(...reopened.read((tx) => [...tx.rows('change_log')].map((l) => l.id as number)));
    const other = await reopened.write(userId, (tx) =>
      tx.insert('nodes', { content: 'másik példányból', created_by: userId, updated_by: userId }),
    );
    expect(logFor(other.id as string)[0]?.id).toBe(lastLog + 1); // az első példány újraolvasta a fájlt
  });

  it('a store a kívülről (pl. create-user) létrehozott felhasználóval is beléptet, újraindítás nélkül', async () => {
    const storeFile = tempJsonFile();
    const store = openJsonStore(storeFile);
    try {
      await openJsonStore(storeFile).createUser('uj@example.com', 'Új', TEST_PASSWORD);
      expect(await store.login('uj@example.com', TEST_PASSWORD)).not.toBeNull();
    } finally {
      await store.close();
      rmSync(storeFile, { force: true });
    }
  });
});
