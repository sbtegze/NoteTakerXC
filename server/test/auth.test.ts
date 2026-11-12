import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db.js';
import { freshDb, TEST_PASSWORD, testUser } from './helpers.js';

let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  db = await freshDb();
  await testUser(db);
  app = await buildApp({ db, loginAttemptsPerMinute: 4 });
});

afterAll(async () => {
  await app.close();
  await db.end();
});

const loginReq = (password: string, email = 'teszt@example.com') =>
  app.inject({ method: 'POST', url: '/api/login', payload: { email, password } });

describe('bejelentkezés', () => {
  it('bejelentkezés nélkül az API 401-et ad', async () => {
    expect((await app.inject({ url: '/api/me' })).statusCode).toBe(401);
  });

  it('hibás jelszóval és ismeretlen e-maillel ugyanazt a hibát adja', async () => {
    const wrong = await loginReq('rossz');
    const unknown = await loginReq(TEST_PASSWORD, 'nincs@example.com');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('helyes jelszóval sütit ad, amivel az API elérhető, kilépés után nem', async () => {
    const res = await loginReq(TEST_PASSWORD);
    expect(res.statusCode).toBe(200);
    const sid = res.cookies.find((c) => c.name === 'sid')!;
    expect(sid.httpOnly).toBe(true);
    expect(sid.sameSite).toBe('Strict');

    const cookies = { sid: sid.value };
    const me = await app.inject({ url: '/api/me', cookies });
    expect(me.json().user.email).toBe('teszt@example.com');

    // A munkamenet tokenje nem kerül nyersen az adatbázisba.
    const stored = await db.query('SELECT token_hash FROM sessions');
    expect(stored.rows.map((r) => r.token_hash)).not.toContain(sid.value);

    await app.inject({ method: 'POST', url: '/api/logout', cookies });
    expect((await app.inject({ url: '/api/me', cookies })).statusCode).toBe(401);
  });

  it('túl sok próbálkozás után korlátoz', async () => {
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await loginReq('rossz')).statusCode;
    expect(last).toBe(429);
  });
});
