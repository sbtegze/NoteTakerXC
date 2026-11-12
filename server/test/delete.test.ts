import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { freshDb, TEST_PASSWORD, testUser, type TestDb } from './helpers.js';

let db: TestDb;
let app: FastifyInstance;
let cookies: { sid: string };

interface Node {
  id: string;
  version: number;
}

beforeAll(async () => {
  db = await freshDb();
  await testUser(db);
  app = await buildApp({ store: db.store });
  const res = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email: 'teszt@example.com', password: TEST_PASSWORD },
  });
  cookies = { sid: res.cookies.find((c) => c.name === 'sid')!.value };
});

afterAll(async () => {
  await app.close();
  await db.end();
});

const create = async (payload: object) =>
  (await app.inject({ method: 'POST', url: '/api/nodes', payload, cookies })).json().node as Node;
const view = async (id: string) => (await app.inject({ url: `/api/nodes/${id}`, cookies })).json();
const del = (n: Node) => app.inject({ method: 'DELETE', url: `/api/nodes/${n.id}?version=${n.version}`, cookies });
const exists = async (id: string) => (await db.rows('nodes')).some((n) => n.id === id);

describe('node törlése', () => {
  it('a csak a szülőjéhez kötött, komment nélküli node végleg törlődik; a napló megőrzi', async () => {
    const parent = await create({ content: 'szülő' });
    const leaf = await create({ content: 'elírt sor', parentId: parent.id });
    expect((await view(leaf.id)).center.deletable).toBe(true);
    expect((await view(parent.id)).below[0].deletable).toBe(true);

    const res = await del(leaf);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ parentId: parent.id });
    expect(await exists(leaf.id)).toBe(false);
    expect((await db.rows('edges')).filter((e) => e.source_id === leaf.id || e.target_id === leaf.id)).toHaveLength(0);
    const log = (await db.rows('change_log')).filter((l) => l.entity === 'node' && l.entity_id === leaf.id);
    expect(log.at(-1)?.action).toBe('remove');
  });

  it('a törölt komment nem akadály, az élő igen', async () => {
    const parent = await create({ content: 'szülő 2' });
    const leaf = await create({ content: 'kommentelt', parentId: parent.id });
    const note = (
      await app.inject({ method: 'POST', url: `/api/nodes/${leaf.id}/notes`, payload: { content: 'megjegyzés' }, cookies })
    ).json().note;
    expect((await view(leaf.id)).center.deletable).toBe(false);
    expect((await del(leaf)).statusCode).toBe(409);

    await app.inject({ method: 'DELETE', url: `/api/notes/${note.id}?version=${note.version}`, cookies });
    expect((await view(leaf.id)).center.deletable).toBe(true);
    expect((await del(leaf)).statusCode).toBe(200);
    expect(await exists(leaf.id)).toBe(false);
  });

  it('nem törölhető, ha más kapcsolata is van: gyereke, említése, vagy őt említik', async () => {
    const parent = await create({ content: 'szülő 3' });
    const withChild = await create({ content: 'van alatta', parentId: parent.id });
    await create({ content: 'gyerek', parentId: withChild.id });
    const mentioning = await create({ content: 'a #4321 kész', parentId: parent.id });
    const target = await create({ content: 'Különleges téma', parentId: parent.id });
    const person = await create({ content: 'Ottó', type: 'person', parentId: parent.id });
    await create({ content: 'Ottó tudja', parentId: parent.id });

    for (const n of [withChild, mentioning, person]) {
      expect((await view(n.id)).center.deletable).toBe(false);
      expect((await del(n)).statusCode).toBe(409);
      expect(await exists(n.id)).toBe(true);
    }
    expect((await view(target.id)).center.deletable).toBe(true);
  });

  it('a kapcsolat nélküli legfelső szintű node is törölhető, ha valami említi, nem', async () => {
    const root = await create({ content: 'üres legfelső' });
    expect((await view(root.id)).center.deletable).toBe(true);
    const res = await del(root);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ parentId: null });
    expect(await exists(root.id)).toBe(false);

    await create({ content: '@Ödön ráér' }); // Ödön legfelső szintű ember, és ez a sor említi
    const odon = (await db.rows('nodes')).find((n) => n.content === 'Ödön') as unknown as Node;
    expect((await view(odon.id)).center.deletable).toBe(false);
    expect((await del(odon)).statusCode).toBe(409);
  });

  it('az elavult verzió és az ismeretlen node', async () => {
    const parent = await create({ content: 'szülő 4' });
    const leaf = await create({ content: 'régi', parentId: parent.id });
    expect((await del({ ...leaf, version: leaf.version + 1 })).statusCode).toBe(409);
    expect((await del({ id: '00000000-0000-4000-8000-000000000000', version: 1 })).statusCode).toBe(404);
  });
});
