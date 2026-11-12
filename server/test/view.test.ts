import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { freshDb, TEST_PASSWORD, testUser, type TestDb } from './helpers.js';

let db: TestDb;
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
// A mentéskor a relatív dátumok elé kerülő pontos dátum (a teszt napjától függ) nélkül.
const plain = (content: string) => content.replace(/\d{4}-\d{2}-\d{2}(?:–\d{4}-\d{2}-\d{2})? /g, '');
const titles = (list: { content: string }[]) => list.map((n) => plain(n.content));

let szabi: Brief, istvan: Brief, meeting: Brief, ticketId: string;

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

  szabi = await create({ content: 'Szabi', type: 'person' });
  istvan = await create({ content: 'István', type: 'person' });
  meeting = await create({ content: 'Heti egyeztetés 11.10.', type: 'meeting' });
  await create({ content: 'Szabi a #1234-et pénteken beadja', parentId: meeting.id });
  await create({ content: '#1234: Istvánra várunk a specifikáció miatt', parentId: meeting.id });
  await create({ content: 'István jövő héten nincs', parentId: meeting.id });
  ticketId = (await db.rows('nodes')).find((n) => n.ticket_no === 1234)!.id as string;
});

afterAll(async () => {
  await app.close();
  await db.end();
});

describe('középre állítás', () => {
  it('az ősök a gyökérig, mindegyik a saját szüleivel; a kör nem akasztja meg', async () => {
    const entry = (await get(`/api/nodes/${meeting.id}`)).below.find((n: Brief) => plain(n.content).startsWith('István jövő'));
    const sub = await create({ content: 'Al-bejegyzés', parentId: entry.id });
    const view = await get(`/api/nodes/${sub.id}`);
    const byId = new Map(view.ancestors.map((a: Brief & { parent_ids: string[] }) => [a.id, a]));
    const chain = (id: string): string[] => {
      const a = byId.get(id) as (Brief & { parent_ids: string[] }) | undefined;
      return a ? [plain(a.content), ...a.parent_ids.flatMap(chain)] : [];
    };
    expect(titles(view.parents)).toEqual(['István jövő héten nincs']);
    expect(chain(entry.id)).toEqual(['István jövő héten nincs', 'Heti egyeztetés 11.10.']);

    // Kör: a meeting az al-bejegyzés alá is bekerül.
    const userId = (await db.rows('users'))[0]!.id;
    await db.insert('edges', { source_id: sub.id, target_id: meeting.id, kind: 'belongs_to', created_by: userId });
    const res = await app.inject({ url: `/api/nodes/${sub.id}`, cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().ancestors.map((a: Brief) => a.content)).toContain('Al-bejegyzés');
    await db.remove('edges', (e) => e.source_id === sub.id && e.target_id === meeting.id);
  });

  it('kérésre a bejegyzések alatti szinteket is adja, legfeljebb a kért mélységig', async () => {
    const entry = (await get(`/api/nodes/${meeting.id}`)).below.find((n: Brief) => plain(n.content).startsWith('István jövő'));
    const lvl1 = (await get(`/api/nodes/${entry.id}`)).below.find((n: Brief) => n.content === 'Al-bejegyzés');
    const lvl2 = await create({ content: 'második szint', parentId: lvl1.id });
    await create({ content: 'harmadik szint', parentId: lvl2.id });

    expect((await get(`/api/nodes/${meeting.id}`)).deeper).toEqual([]);
    const view = await get(`/api/nodes/${meeting.id}?melyseg=2`);
    expect(titles(view.deeper)).toEqual(['Al-bejegyzés', 'második szint']);
    expect(view.deeper[0].spans).toBeDefined();
    const pairs = view.deeper_edges.map((e: { parent_id: string; child_id: string }) => [e.parent_id, e.child_id]);
    expect(pairs).toEqual(expect.arrayContaining([[entry.id, lvl1.id], [lvl1.id, lvl2.id]]));
    expect(pairs).toHaveLength(2);
    expect((await app.inject({ url: `/api/nodes/${meeting.id}?melyseg=9`, cookies })).statusCode).toBe(400);
  });

  it('a kezdőlapon a legfelső szintű node-ok, a legújabb elöl; ember és jegy nélkül', async () => {
    const later = await create({ content: 'ERP technikai státusz', type: 'meeting' });
    const { roots } = await get('/api/roots');
    expect(titles(roots).slice(0, 2)).toEqual(['ERP technikai státusz', 'Heti egyeztetés 11.10.']);
    expect(titles(roots)).not.toContain('Szabi');
    expect(titles(roots)).not.toContain('#1234');
    expect(titles(roots)).not.toContain('Szabi a #1234-et pénteken beadja'); // a meeting alatt van
    await db.remove('nodes', (n) => n.id === later.id);
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
    // Kik érintettek a jegyben: a legutóbb említett elöl; utánuk a meeting, ahol elhangzott.
    expect(titles(view.connected)).toEqual(['István', 'Szabi', 'Heti egyeztetés 11.10.']);
    // Hol említik: a meeting az említő bejegyzések szülője.
    expect(view.mention_parent_ids).toEqual([meeting.id]);
    expect(titles(view.ancestors)).toEqual(['Heti egyeztetés 11.10.']);
  });

  it('az embernél látszik, miben érintett', async () => {
    const view = await get(`/api/nodes/${istvan.id}`);
    expect(titles(view.below)).toEqual(['#1234: Istvánra várunk a specifikáció miatt', 'István jövő héten nincs']);
    expect(titles(view.connected)).toEqual(['#1234', 'Heti egyeztetés 11.10.']);
    expect(titles(view.parents)).toEqual([]);
  });

  it('a jegynél az említés útvonala és a felette lévő szintek kapcsolatai is látszanak', async () => {
    const erp = await create({ content: 'ERP státusz', type: 'meeting' });
    const head = await create({ content: '@Ákos', parentId: erp.id });
    await create({ content: '#5589', parentId: head.id });
    const ticket = (await db.rows('nodes')).find((n) => n.ticket_no === 5589)!;

    const view = await get(`/api/nodes/${ticket.id}`);
    expect(view.mention_parent_ids).toEqual([head.id]);
    const byId = new Map(view.ancestors.map((a: Brief & { parent_ids: string[] }) => [a.id, a]));
    expect((byId.get(head.id) as { parent_ids: string[] }).parent_ids).toEqual([erp.id]);
    expect(titles(view.connected)).toEqual(expect.arrayContaining(['Ákos', 'ERP státusz']));
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

  it('a „Kapcsolódik” alatt az alatta lévő meetingek és témák is, három szint mélységig', async () => {
    const root = await create({ content: 'státusz meeting', type: 'meeting' });
    const dev = await create({ content: '@Ödön', parentId: root.id });
    const near = await create({ content: '/meeting FDD workshop', parentId: dev.id });
    const deep1 = await create({ content: 'al: a #4321 és @Kálmán', parentId: near.id }); // 3. szint
    const deep2 = await create({ content: '/téma Mély téma', parentId: deep1.id }); // 4. szint: már nem
    const topic = await create({ content: '/téma Számlázás', parentId: root.id });

    const view = await get(`/api/nodes/${root.id}`);
    const typed = view.connected.filter((n: Brief) => n.type === 'meeting' || n.type === 'topic');
    expect(titles(typed).map((t) => t.replace(/ \d{4}-\d{2}-\d{2}$/, '')).sort()).toEqual(['FDD workshop', 'Számlázás']);
    expect(titles(view.connected)).toContain('Ödön'); // az említett ember továbbra is
    // A mélyebb szinten említett jegy és ember is.
    expect(titles(view.connected)).toEqual(expect.arrayContaining(['#4321', 'Kálmán']));
    for (const n of [deep2, deep1, near, topic, dev, root]) {
      await db.remove('edges', (e) => e.source_id === n.id || e.target_id === n.id);
      await db.remove('nodes', (x) => x.id === n.id);
    }
  });

  it('ismeretlen node 404, hibás azonosító 400', async () => {
    expect((await app.inject({ url: '/api/nodes/00000000-0000-4000-8000-000000000000', cookies })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/nodes/nem-uuid', cookies })).statusCode).toBe(400);
  });
});

describe('típus szerinti lista', () => {
  it('az emberek név szerint, a jegyek szám szerint, a meetingek a legújabb elöl', async () => {
    const list = async (type: string) => titles((await get(`/api/nodes?type=${type}`)).nodes);
    expect(await list('person')).toEqual([...(await list('person'))].sort((a, b) => a.localeCompare(b, 'hu')));
    expect(await list('person')).toEqual(expect.arrayContaining(['István', 'Szabi']));

    await create({ content: '#99 régi jegy' });
    const tickets = await list('ticket');
    expect(tickets.indexOf('#99')).toBeLessThan(tickets.indexOf('#1234'));

    const older = await create({ content: 'régebbi meeting', type: 'meeting' });
    const newer = await create({ content: 'újabb meeting', type: 'meeting' });
    const meetings = await list('meeting');
    expect(meetings.indexOf('újabb meeting')).toBeLessThan(meetings.indexOf('régebbi meeting'));
    for (const n of [older, newer]) await db.remove('nodes', (x) => x.id === n.id);

    expect((await app.inject({ url: '/api/nodes?type=valami', cookies })).statusCode).toBe(400);
  });
});

describe('típus és becenév', () => {
  it('az @-tal létrejött embert a korábbi szövegekben és a becenevén is felismeri', async () => {
    await create({ content: 'Gézának szólni kell a #1234 miatt', parentId: meeting.id });
    await create({ content: '@Géza is jön', parentId: meeting.id });
    const geza = (await db.rows('nodes')).find((n) => n.type === 'person' && n.content === 'Géza') as unknown as Brief;
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
    const before = (await db.rows('change_log')).length;
    const view = (await get(`/api/nodes/${szabi.id}`)).center;
    await patch(szabi.id, { version: view.version, aliases: ['Szabolcs'] });
    const after = (await db.rows('change_log')).length;
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

  it('a ragozásban megnyúlt tőre is talál (Kinga -> Kingával)', async () => {
    await create({ content: 'Kinga teszteli a riportot' });
    const found = (await get(`/api/search?q=${encodeURIComponent('Kingával')}`)).results;
    expect(titles(found)).toEqual(['Kinga teszteli a riportot']);
  });

  it('a % és _ jelek sima karakterek, az üres keresés üres', async () => {
    expect((await get('/api/search?q=%25')).results).toEqual([]);
    expect((await get('/api/search?q=')).results).toEqual([]);
  });
});
