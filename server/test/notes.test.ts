import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db.js';
import { freshDb, TEST_PASSWORD, testUser } from './helpers.js';

let db: Db;
let app: FastifyInstance;
let cookies: { sid: string };

interface Note {
  id: string;
  node_id: string;
  content: string;
  version: number;
  spans: { kind: string; targetId?: string }[];
}

const get = async (url: string) => (await app.inject({ url, cookies })).json();
const create = async (payload: object) =>
  (await app.inject({ method: 'POST', url: '/api/nodes', payload, cookies })).json().node as { id: string };
const comment = (nodeId: string, content: unknown) =>
  app.inject({ method: 'POST', url: `/api/nodes/${nodeId}/notes`, payload: { content }, cookies });
const edgeCount = async () => (await db.query('SELECT count(*)::int AS n FROM edges')).rows[0].n as number;

let szabi: { id: string }, meeting: { id: string }, entry: { id: string };

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

  szabi = await create({ content: 'Szabi', type: 'person' });
  meeting = await create({ content: 'Heti egyeztetés', type: 'meeting' });
  entry = await create({ content: 'A #1234 csúszik', parentId: meeting.id });
});

afterAll(async () => {
  await app.close();
  await db.end();
});

describe('kommentek', () => {
  it('a komment a node-hoz tartozik, és a nézetben a node-nál látszik', async () => {
    const res = await comment(entry.id, '  Szabi szerint pénteken kész  ');
    expect(res.statusCode).toBe(201);
    expect(res.json().note.content).toBe('Szabi szerint pénteken kész');

    await comment(meeting.id, 'Jövő héten rövidebb lesz');
    const view = await get(`/api/nodes/${meeting.id}`);
    expect(view.center.notes.map((n: Note) => n.content)).toEqual(['Jövő héten rövidebb lesz']);
    expect(view.below[0].notes.map((n: Note) => n.content)).toEqual(['Szabi szerint pénteken kész']);
  });

  it('a felismerés kiemel, de kapcsolatot nem hoz létre', async () => {
    const before = await edgeCount();
    const note = (await comment(entry.id, 'Szabi a #1234 és #9999 miatt kérdezett')).json().note as Note;
    expect(note.spans.map((s) => [s.kind, s.targetId])).toEqual([
      ['person', szabi.id],
      ['ticket', expect.any(String)],
      ['ticket', undefined], // ismeretlen jegyszám: kiemelt, de nem jön létre jegy node
    ]);
    expect(await edgeCount()).toBe(before);
    expect((await db.query('SELECT 1 FROM nodes WHERE ticket_no = 9999')).rowCount).toBe(0);
    // Szabinál nem jelenik meg a komment bejegyzésként.
    expect((await get(`/api/nodes/${szabi.id}`)).below).toEqual([]);
  });

  it('szerkesztés verzióval; elavult verzióra 409', async () => {
    const note = (await comment(entry.id, 'első')).json().note as Note;
    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/notes/${note.id}`,
      payload: { content: 'javított', version: note.version },
      cookies,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().note).toMatchObject({ content: 'javított', version: note.version + 1 });

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/notes/${note.id}`,
      payload: { content: 'más', version: note.version },
      cookies,
    });
    expect(stale.statusCode).toBe(409);
  });

  it('a törölt komment eltűnik, de a naplóban megmarad', async () => {
    const note = (await comment(meeting.id, 'tévedés')).json().note as Note;
    const del = (version: number) =>
      app.inject({ method: 'DELETE', url: `/api/notes/${note.id}?version=${version}`, cookies });
    expect((await del(note.version)).statusCode).toBe(200);
    expect((await del(note.version)).statusCode).toBe(404);

    const view = await get(`/api/nodes/${meeting.id}`);
    expect(view.center.notes.map((n: Note) => n.content)).not.toContain('tévedés');
    const log = await db.query('SELECT action FROM change_log WHERE entity_id = $1 ORDER BY id', [note.id]);
    expect(log.rows.map((r) => r.action)).toEqual(['create', 'delete']);
  });

  it('üres komment, ismeretlen node és hiányzó verzió: hiba', async () => {
    expect((await comment(entry.id, '   ')).statusCode).toBe(400);
    expect((await comment(entry.id, 42)).statusCode).toBe(400);
    expect((await comment('00000000-0000-4000-8000-000000000000', 'x')).statusCode).toBe(404);
    const note = (await comment(entry.id, 'x')).json().note as Note;
    const res = await app.inject({ method: 'PATCH', url: `/api/notes/${note.id}`, payload: { content: 'y' }, cookies });
    expect(res.statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/notes/${note.id}`, cookies })).statusCode).toBe(400);
  });

  it('bejelentkezés nélkül nem írható', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/nodes/${entry.id}/notes`, payload: { content: 'x' } });
    expect(res.statusCode).toBe(401);
  });
});
