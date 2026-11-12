import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db.js';
import { freshDb, TEST_PASSWORD, testUser } from './helpers.js';

let db: Db;
let app: FastifyInstance;
let cookies: { sid: string };

beforeAll(async () => {
  db = await freshDb();
  await testUser(db);
  app = await buildApp({ db });
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
  (await app.inject({ method: 'POST', url: '/api/nodes', payload, cookies })).json().node as { id: string };
const move = (id: string, from: string, to: string) =>
  app.inject({ method: 'POST', url: `/api/nodes/${id}/move`, payload: { from, to }, cookies });
const parentsOf = async (id: string) =>
  (
    await db.query(
      `SELECT n.content, e.kind FROM edges e JOIN nodes n ON n.id = e.source_id
       WHERE e.target_id = $1 AND e.kind IN ('unsorted', 'belongs_to') ORDER BY n.content`,
      [id],
    )
  ).rows.map((r) => `${r.kind}:${r.content}`);

describe('áthelyezés húzással', () => {
  it('a bejegyzés a másik bejegyzés alá kerül; a többi szülője (pl. a meeting) megmarad', async () => {
    const topic = await create({ content: 'téma' });
    const meeting = await create({ content: 'meeting', type: 'meeting' });
    const a = await create({ content: 'A', parentId: topic.id, contextId: meeting.id });
    const b = await create({ content: 'B', parentId: topic.id });

    const res = await move(a.id, topic.id, b.id);
    expect(res.statusCode).toBe(200);
    expect(await parentsOf(a.id)).toEqual(['belongs_to:B', 'unsorted:meeting']);
  });

  it('saját maga vagy a saját leszármazottja alá nem kerülhet', async () => {
    const root = await create({ content: 'gyökér' });
    const a = await create({ content: 'A2', parentId: root.id });
    const child = await create({ content: 'A2 gyereke', parentId: a.id });

    expect((await move(a.id, root.id, a.id)).statusCode).toBe(400);
    expect((await move(a.id, root.id, child.id)).statusCode).toBe(400);
    expect(await parentsOf(a.id)).toEqual(['unsorted:gyökér']);
  });

  it('ha nincs ilyen szülői kapcsolat, 409; ismeretlen cél 404', async () => {
    const root = await create({ content: 'gyökér 2' });
    const other = await create({ content: 'másik' });
    const a = await create({ content: 'A3', parentId: root.id });
    expect((await move(a.id, other.id, root.id)).statusCode).toBe(409);
    expect((await move(a.id, root.id, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect(await parentsOf(a.id)).toEqual(['unsorted:gyökér 2']);
  });

  it('ha az új szülő már szülője, csak a régi kapcsolat szűnik meg', async () => {
    const root = await create({ content: 'gyökér 3' });
    const b = await create({ content: 'B4', parentId: root.id });
    const a = await create({ content: 'A4', parentId: root.id, contextId: b.id });
    expect((await move(a.id, root.id, b.id)).statusCode).toBe(200);
    expect(await parentsOf(a.id)).toEqual(['unsorted:B4']);
  });
});
