import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db.js';
import { freshDb, TEST_PASSWORD, testUser } from './helpers.js';

let db: Db;
let app: FastifyInstance;
let cookies: { sid: string };

interface Brief {
  id: string;
  content: string;
  type: string | null;
  version: number;
}

const get = async (url: string) => (await app.inject({ url, cookies })).json();
const create = async (payload: object) =>
  (await app.inject({ method: 'POST', url: '/api/nodes', payload, cookies })).json().node as Brief;
const patch = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/nodes/${id}`, payload, cookies });
const titles = (list: { content: string }[]) => list.map((n) => n.content);

let szabi: Brief, istvan: Brief, meeting: Brief, ticketId: string;

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
  istvan = await create({ content: 'István', type: 'person' });
  meeting = await create({ content: 'Heti egyeztetés 11.10.', type: 'meeting' });
  await create({ content: 'Szabi a #1234-et pénteken beadja', parentId: meeting.id });
  await create({ content: '#1234: Istvánra várunk a specifikáció miatt', parentId: meeting.id });
  await create({ content: 'István jövő héten nincs', parentId: meeting.id });
  ticketId = (await db.query('SELECT id FROM nodes WHERE ticket_no = 1234')).rows[0].id;
});

afterAll(async () => {
  await app.close();
  await db.end();
});

describe('középre állítás', () => {
  it('az ősök a gyökérig, mindegyik a saját szüleivel; a kör nem akasztja meg', async () => {
    const entry = (await get(`/api/nodes/${meeting.id}`)).below.find((n: Brief) => n.content.startsWith('István jövő'));
    const sub = await create({ content: 'Al-bejegyzés', parentId: entry.id });
    const view = await get(`/api/nodes/${sub.id}`);
    const byId = new Map(view.ancestors.map((a: Brief & { parent_ids: string[] }) => [a.id, a]));
    const chain = (id: string): string[] => {
      const a = byId.get(id) as (Brief & { parent_ids: string[] }) | undefined;
      return a ? [a.content, ...a.parent_ids.flatMap(chain)] : [];
    };
    expect(titles(view.parents)).toEqual(['István jövő héten nincs']);
    expect(chain(entry.id)).toEqual(['István jövő héten nincs', 'Heti egyeztetés 11.10.']);

    // Kör: a meeting az al-bejegyzés alá is bekerül.
    const { id: userId } = (await db.query('SELECT id FROM users LIMIT 1')).rows[0];
    await db.query(
      `INSERT INTO edges (source_id, target_id, kind, created_by) VALUES ($1, $2, 'belongs_to', $3)`,
      [sub.id, meeting.id, userId],
    );
    const res = await app.inject({ url: `/api/nodes/${sub.id}`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().ancestors.map((a: Brief) => a.content)).toContain('Al-bejegyzés');
    await db.query(`DELETE FROM edges WHERE source_id = $1 AND target_id = $2`, [sub.id, meeting.id]);
  });

  it('a kezdőlapon a legfelső szintű node-ok, a legújabb elöl; ember és jegy nélkül', async () => {
    const later = await create({ content: 'ERP technikai státusz', type: 'meeting' });
    const { roots } = await get('/api/roots');
    expect(titles(roots).slice(0, 2)).toEqual(['ERP technikai státusz', 'Heti egyeztetés 11.10.']);
    expect(titles(roots)).not.toContain('Szabi');
    expect(titles(roots)).not.toContain('#1234');
    expect(titles(roots)).not.toContain('Szabi a #1234-et pénteken beadja'); // a meeting alatt van
    await db.query('DELETE FROM nodes WHERE id = $1', [later.id]);
  });

  it('a jegynél időrendben látszik minden, ami róla elhangzott, és hogy hol', async () => {
    const view = await get(`/api/nodes/${ticketId}`);
    expect(titles(view.below)).toEqual([
      'Szabi a #1234-et pénteken beadja',
      '#1234: Istvánra várunk a specifikáció miatt',
    ]);
    expect(view.below[0].is_child).toBe(false);
    expect(titles(view.below[0].contexts)).toEqual(['Heti egyeztetés 11.10.']);
    expect(view.below[0].dates).toHaveLength(1);
    // Kik érintettek a jegyben: a legutóbb említett elöl.
    expect(titles(view.connected)).toEqual(['István', 'Szabi']);
  });

  it('az embernél látszik, miben érintett', async () => {
    const view = await get(`/api/nodes/${istvan.id}`);
    expect(titles(view.below)).toEqual(['#1234: Istvánra várunk a specifikáció miatt', 'István jövő héten nincs']);
    expect(titles(view.connected)).toEqual(['#1234']);
    expect(titles(view.parents)).toEqual([]);
  });

  it('a meetingnél az ott rögzített bejegyzések és az érintettek', async () => {
    const view = await get(`/api/nodes/${meeting.id}`);
    expect(view.below).toHaveLength(3);
    expect(view.below.every((b: { is_child: boolean }) => b.is_child)).toBe(true);
    expect(titles(view.connected).sort()).toEqual(['#1234', 'István', 'Szabi']);
  });

  it('a szövegrészek kattintható célt kapnak', async () => {
    const view = await get(`/api/nodes/${meeting.id}`);
    const spans = view.below[0].spans as { kind: string; targetId?: string }[];
    expect(spans.map((s) => [s.kind, s.targetId])).toEqual([
      ['person', szabi.id],
      ['ticket', ticketId],
      ['date', undefined],
    ]);
  });

  it('ismeretlen node 404, hibás azonosító 400', async () => {
    expect((await app.inject({ url: '/api/nodes/00000000-0000-4000-8000-000000000000', cookies })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/nodes/nem-uuid', cookies })).statusCode).toBe(400);
  });
});

describe('típus és becenév', () => {
  it('az @-tal létrejött embert a korábbi szövegekben és a becenevén is felismeri', async () => {
    await create({ content: 'Gézának szólni kell a #1234 miatt', parentId: meeting.id });
    await create({ content: '@Géza is jön', parentId: meeting.id });
    const geza = (await db.query(`SELECT id, version FROM nodes WHERE type = 'person' AND content = 'Géza'`)).rows[0];
    expect(titles((await get(`/api/nodes/${geza.id}`)).below)).toEqual(['Gézának szólni kell a #1234 miatt', '@Géza is jön']);

    const res = await patch(geza.id, { version: geza.version, aliases: ['Gézu'] });
    expect(res.statusCode).toBe(200);
    await create({ content: 'Gézu ráér', parentId: meeting.id });
    expect(titles((await get(`/api/nodes/${geza.id}`)).below)).toEqual([
      'Gézának szólni kell a #1234 miatt',
      '@Géza is jön',
      'Gézu ráér',
    ]);

    // Ha már nem ember, az említések megszűnnek.
    const now = (await get(`/api/nodes/${geza.id}`)).center;
    await patch(geza.id, { version: now.version, type: null });
    expect(titles((await get(`/api/nodes/${geza.id}`)).below)).toEqual([]);
  });

  it('az újraszámolás nem szemeteli tele a naplót', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM change_log')).rows[0].n;
    const view = (await get(`/api/nodes/${szabi.id}`)).center;
    await patch(szabi.id, { version: view.version, aliases: ['Szabolcs'] });
    const after = (await db.query('SELECT count(*)::int AS n FROM change_log')).rows[0].n;
    expect(after - before).toBe(1); // csak a becenév változása
  });

  it('ismeretlen típust nem fogad el', async () => {
    const view = (await get(`/api/nodes/${szabi.id}`)).center;
    expect((await patch(szabi.id, { version: view.version, type: 'akármi' })).statusCode).toBe(400);
  });
});

describe('keresés', () => {
  it('szövegrészre és ragozott alakra is talál, a típusos node-ok elöl', async () => {
    const byPart = (await get('/api/search?q=egyezt')).results;
    expect(titles(byPart)).toEqual(['Heti egyeztetés 11.10.']);
    const byTicket = (await get('/api/search?q=1234')).results;
    expect(byTicket[0].content).toBe('#1234');
    const inflected = (await get(`/api/search?q=${encodeURIComponent('specifikációk')}`)).results;
    expect(titles(inflected)).toEqual(['#1234: Istvánra várunk a specifikáció miatt']);
  });

  it('a % és _ jelek sima karakterek, az üres keresés üres', async () => {
    expect((await get('/api/search?q=%25')).results).toEqual([]);
    expect((await get('/api/search?q=')).results).toEqual([]);
  });
});
