import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db.js';
import { localDate } from '../src/nodes.js';
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

const post = (payload: object) => app.inject({ method: 'POST', url: '/api/nodes', payload, cookies });
const patch = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/nodes/${id}`, payload, cookies });
const create = async (payload: object) => (await post(payload)).json().node as { id: string; version: number };

const edgesFrom = async (id: string) =>
  (
    await db.query(
      `SELECT e.kind, n.content FROM edges e JOIN nodes n ON n.id = e.target_id WHERE e.source_id = $1 ORDER BY n.content`,
      [id],
    )
  ).rows.map((r) => `${r.kind}:${r.content}`);
const parentsOf = async (id: string) =>
  (
    await db.query(
      `SELECT n.content FROM edges e JOIN nodes n ON n.id = e.source_id WHERE e.target_id = $1 AND e.kind = 'unsorted' ORDER BY n.content`,
      [id],
    )
  ).rows.map((r) => r.content);
const datesOf = async (id: string) =>
  (await db.query('SELECT starts_on, ends_on, source_text, confirmed FROM node_dates WHERE node_id = $1 ORDER BY starts_on', [id]))
    .rows;

describe('rögzítés', () => {
  it('bejelentkezés nélkül nem megy', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/nodes', payload: { content: 'x' } });
    expect(res.statusCode).toBe(401);
  });

  it('szülő nélkül legfelső szintű node lesz, felfelé nem kapcsolódik', async () => {
    const a = await create({ content: 'első gondolat' });
    const b = await create({ content: 'második gondolat' });
    expect(await parentsOf(a.id)).toEqual([]);
    expect(await parentsOf(b.id)).toEqual([]);
  });

  it('a /meeting és a /téma parancs elemet hoz létre a megadott címmel és a mai dátummal', async () => {
    const today = localDate();
    const topic = await create({ content: 'parancsos téma' });
    const meeting = await create({ content: 'nyitott meeting', type: 'meeting' });

    const res = await post({ content: '/meeting AI workshop\nnapirend: bemutató', parentId: topic.id, contextId: meeting.id });
    expect(res.statusCode).toBe(201);
    const node = res.json().node;
    expect(node.type).toBe('meeting');
    expect(node.content).toBe(`AI workshop ${today}\nnapirend: bemutató`);
    // Ahová írtuk, oda kerül; a nyitott meetinghez nem kapcsolódik.
    expect(await parentsOf(node.id)).toEqual(['parancsos téma']);

    expect((await post({ content: '/téma Számlázás' })).json().node).toMatchObject({ type: 'topic', content: `Számlázás ${today}` });
    expect((await post({ content: '/Tema Riport' })).json().node).toMatchObject({ type: 'topic', content: `Riport ${today}` });
  });

  it('mentéskor a relatív dátum elé a pontos dátum kerül (a rögzítés napjához képest)', async () => {
    const today = localDate();
    const node = (await post({ content: 'ma később kezd' })).json().node;
    expect(node.content).toBe(`${today} ma később kezd`);
    const res = await patch(node.id, { content: `${node.content}, holnap is`, version: node.version });
    const tomorrow = new Date(`${today}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    expect(res.json().node.content).toBe(`${today} ma később kezd, ${tomorrow.toISOString().slice(0, 10)} holnap is`);
  });

  it('a meglévő meetinget nem hozza létre újra, hanem az aktuális node alá linkeli', async () => {
    const today = localDate();
    const first = await create({ content: 'első helye' });
    const meeting = (await post({ content: '/meeting Linkelt workshop', parentId: first.id })).json().node;
    const second = await create({ content: 'második helye' });

    // Dátum nélkül (ma) és a teljes címmel is ugyanaz; kis- és nagybetű nem számít.
    const res = await post({ content: '/meeting linkelt workshop', parentId: second.id });
    expect(res.statusCode).toBe(201);
    expect(res.json().node.id).toBe(meeting.id);
    const again = await post({ content: `/meeting Linkelt workshop ${today}\nott: jegyzet`, parentId: second.id });
    expect(again.json().node.id).toBe(meeting.id);

    const same = await db.query(`SELECT count(*)::int AS n FROM nodes WHERE content = $1`, [`Linkelt workshop ${today}`]);
    expect(same.rows[0].n).toBe(1);
    expect(await parentsOf(meeting.id)).toEqual(['első helye', 'második helye']);
    // Az első sor alatti szöveg a meglévő meeting alá kerül.
    const below = await db.query(
      `SELECT n.content FROM edges e JOIN nodes n ON n.id = e.target_id WHERE e.source_id = $1`,
      [meeting.id],
    );
    expect(below.rows.map((r) => r.content)).toEqual(['ott: jegyzet']);
  });

  it('a meglévő meetinget nem linkeli a saját alárendeltje alá', async () => {
    const meeting = (await post({ content: '/meeting Körös workshop' })).json().node;
    const inside = await create({ content: 'benne', parentId: meeting.id });
    const res = await post({ content: '/meeting Körös workshop', parentId: inside.id });
    expect(res.statusCode).toBe(400);
  });

  it('ha a címben számmal írt dátum van, nem kerül mögé még egy; a szöveges nap nem számít', async () => {
    const today = localDate();
    expect((await post({ content: '/meeting ERP technikai státusz 2026-11-10' })).json().node.content).toBe(
      'ERP technikai státusz 2026-11-10',
    );
    expect((await post({ content: '/meeting Retro nov. 10' })).json().node.content).toBe('Retro nov. 10');
    expect((await post({ content: '/meeting Pénteki retro' })).json().node.content).toBe(`Pénteki retro ${today}`);
  });

  it('ismeretlen parancs, cím nélküli parancs vagy szöveg közbeni perjel sima szöveg marad', async () => {
    for (const content of ['/xyz valami', '/meeting', '/meeting   ', 'később /meeting AI', 'a/b teszt']) {
      const node = (await post({ content })).json().node;
      expect(node).toMatchObject({ type: null, content: content.trim() });
    }
  });

  it('szerkesztéskor is hat a parancs, a rögzítés napjával; típusos node-nál szöveg marad', async () => {
    const node = await create({ content: 'sima sor\nmásodik sor' });
    const day = localDate(new Date((await db.query('SELECT created_at FROM nodes WHERE id = $1', [node.id])).rows[0].created_at));
    const res = await patch(node.id, { content: '/meeting Utólag\nmásodik sor', version: node.version });
    expect(res.json().node).toMatchObject({ type: 'meeting', content: `Utólag ${day}\nmásodik sor` });

    const typed = await create({ content: 'egy téma', type: 'topic' });
    const res2 = await patch(typed.id, { content: '/meeting Más', version: typed.version });
    expect(res2.json().node).toMatchObject({ type: 'topic', content: '/meeting Más' });
  });

  it('a meeting második szülőként kapcsolódik', async () => {
    const topic = await create({ content: 'IREMS' });
    const meeting = await create({ content: 'Heti egyeztetés', type: 'meeting' });
    const entry = await create({ content: 'átbeszéltük', parentId: topic.id, contextId: meeting.id });
    expect(await parentsOf(entry.id)).toEqual(['Heti egyeztetés', 'IREMS']);
  });

  it('a szövegből jegyet, embert és dátumot ismer fel, és elmenti őket', async () => {
    await create({ content: 'Szabi', type: 'person', aliases: ['Szabolcs'] });
    await create({ content: 'Kovács István', type: 'person' });

    const res = await post({ content: 'Szabi a #1234-et nov. 20-ig beadja, utána Istvánra várunk' });
    expect(res.statusCode).toBe(201);
    const { node, spans } = res.json();
    expect(spans.map((s: { kind: string }) => s.kind)).toEqual(['person', 'ticket', 'date', 'person']);
    expect(await edgesFrom(node.id)).toEqual(['mention:#1234', 'mention:Kovács István', 'mention:Szabi']);

    const dates = await datesOf(node.id);
    expect(dates).toHaveLength(1);
    // Mentéskor a pontos dátum elé került, a kettő egy felismert dátum.
    expect(dates[0]).toMatchObject({ source_text: expect.stringMatching(/^\d{4}-11-20 nov\. 20$/), confirmed: false });
    expect(dates[0].starts_on).toBe(dates[0].ends_on);
    expect(dates[0].starts_on).toMatch(/-11-20$/);

    const ticket = await db.query(`SELECT type, content FROM nodes WHERE ticket_no = 1234`);
    expect(ticket.rows).toEqual([{ type: 'ticket', content: '#1234' }]);
  });

  it('ugyanaz a jegy csak egyszer jön létre, és utána # nélkül is felismeri', async () => {
    const again = await create({ content: 'a #1234 még mindig nyitva' });
    const bare = await create({ content: '1234 kész, 5678 nem jegy' });
    expect(await edgesFrom(again.id)).toEqual(['mention:#1234']);
    expect(await edgesFrom(bare.id)).toEqual(['mention:#1234']);
    expect((await db.query(`SELECT count(*)::int AS n FROM nodes WHERE type = 'ticket'`)).rows[0].n).toBe(1);
  });

  it('az átnevezett jegyet is megtalálja, és a jegy nem említi önmagát', async () => {
    const { rows } = await db.query('SELECT id, version FROM nodes WHERE ticket_no = 1234');
    const res = await patch(rows[0].id, { content: '#1234 Számlakép export', version: rows[0].version });
    expect(res.statusCode).toBe(200);
    expect(await edgesFrom(rows[0].id)).toEqual([]);
    const entry = await create({ content: '#1234 tesztelés alatt' });
    expect(await edgesFrom(entry.id)).toEqual(['mention:#1234 Számlakép export']);
  });

  it('szerkesztéskor az említések és a dátumok újraszámolódnak', async () => {
    const created = (await post({ content: 'Szabi #1234 holnap' })).json().node;
    expect(await edgesFrom(created.id)).toEqual(['mention:#1234 Számlakép export', 'mention:Szabi']);

    const res = await patch(created.id, { content: 'István #777', version: created.version });
    expect(res.statusCode).toBe(200);
    expect(res.json().node.version).toBe(created.version + 1);
    expect(await edgesFrom(created.id)).toEqual(['mention:#777', 'mention:Kovács István']);
    expect(await datesOf(created.id)).toEqual([]);
  });

  it('a kézzel megerősített dátum szerkesztés után is megmarad', async () => {
    const created = (await post({ content: 'Szabi nincs dec 22–jan 2' })).json().node;
    await db.query(`UPDATE node_dates SET confirmed = true, meaning = 'absence' WHERE node_id = $1`, [created.id]);
    await patch(created.id, { content: 'Szabi nincs dec 22–jan 2, holnap még bent', version: created.version });
    const dates = await datesOf(created.id);
    expect(dates.map((d) => [d.source_text, d.confirmed])).toEqual([
      [expect.stringMatching(/^\d{4}-\d{2}-\d{2} holnap$/), false], // mentéskor a pontos dátum elé került
      [expect.stringMatching(/^\d{4}-12-22–\d{4}-01-02 dec 22–jan 2$/), true],
    ]);
  });

  it('elavult verzióval 409, hibás bemenettel 400, ismeretlen szülővel 404', async () => {
    const node = await create({ content: 'verziós' });
    await patch(node.id, { content: 'friss', version: node.version });
    expect((await patch(node.id, { content: 'elavult', version: node.version })).statusCode).toBe(409);
    expect((await post({ content: '   ' })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ content: 'x', parentId: 'nem-uuid' })).statusCode).toBe(400);
    expect((await post({ content: 'x', parentId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    expect((await patch('00000000-0000-4000-8000-000000000000', { content: 'x', version: 1 })).statusCode).toBe(404);
  });

  it('az ismeretlen @név új embert hoz létre, egyszer, és a korábbi szövegekben is felismeri', async () => {
    const earlier = await create({ content: 'Gézától kérdezd meg' });
    expect(await edgesFrom(earlier.id)).toEqual([]);

    const res = await post({ content: '@Gézának szólni kell, @Gézát is hívd' });
    const { node, spans } = res.json();
    expect(spans.map((s: { text: string }) => s.text)).toEqual(['@Gézának', '@Gézát']);
    const people = await db.query(`SELECT content FROM nodes WHERE type = 'person' AND content LIKE 'Géz%'`);
    expect(people.rows).toEqual([{ content: 'Géza' }]);
    expect(await edgesFrom(node.id)).toEqual(['mention:Géza']);
    expect(await edgesFrom(earlier.id)).toEqual(['mention:Géza']);

    // Később már @ nélkül is.
    const later = await create({ content: 'Géza ráér' });
    expect(await edgesFrom(later.id)).toEqual(['mention:Géza']);
  });

  it('a többtagú @név egy embert hoz létre, a teljes névvel és a tagjaival is felismerhetően', async () => {
    const earlier = await create({ content: 'Mátrai Petinek szóltam' });
    const res = await post({ content: '@Mátrai Peti átnézi, @Mátrai Petit is kérdezd' });
    expect(res.json().spans.map((s: { text: string }) => s.text)).toEqual(['@Mátrai Peti', '@Mátrai Petit']);
    const people = await db.query(`SELECT content FROM nodes WHERE type = 'person' AND content LIKE 'Mátrai%'`);
    expect(people.rows).toEqual([{ content: 'Mátrai Peti' }]);
    expect(await edgesFrom(earlier.id)).toEqual(['mention:Mátrai Peti']);

    // Egy másik Peti mellett a „Peti” magában nem dönt, a „Mátrai” igen.
    await create({ content: '@Gulyás Peti is jön' });
    const later = await create({ content: 'Peti és Mátrai' });
    expect(await edgesFrom(later.id)).toEqual(['mention:Mátrai Peti']);
  });

  it('kézzel nem lehet emberré tenni egy node-ot, a tévesen emberré tettet viszont vissza lehet állítani', async () => {
    const node = await create({ content: '@Ödön címsor' });
    const res = await patch(node.id, { type: 'person', version: node.version });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/@Név/);

    const wrong = await create({ content: '@Ödön', type: 'person' });
    expect((await patch(wrong.id, { type: null, version: wrong.version })).statusCode).toBe(200);
  });

  it('szerkesztéskor is létrejön az új @-os ember', async () => {
    const node = await create({ content: 'meg kell kérdezni' });
    await patch(node.id, { content: 'meg kell kérdezni @Hannától', version: node.version });
    expect(await edgesFrom(node.id)).toEqual(['mention:Hanna']);
  });

  it('a kommentben a @név nem hoz létre embert', async () => {
    const node = await create({ content: 'kommentelt' });
    await app.inject({ method: 'POST', url: `/api/nodes/${node.id}/notes`, payload: { content: '@Ottó tudja' }, cookies });
    expect((await db.query(`SELECT 1 FROM nodes WHERE content = 'Ottó'`)).rowCount).toBe(0);
  });

  it('sikertelen rögzítés után nem marad félkész adat', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM nodes')).rows[0].n;
    await post({ content: 'árva #9999', parentId: '00000000-0000-4000-8000-000000000000' });
    expect((await db.query('SELECT count(*)::int AS n FROM nodes')).rows[0].n).toBe(before);
  });
});
