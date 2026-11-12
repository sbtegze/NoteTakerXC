import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { login, logout, SESSION_COOKIE, SESSION_DAYS, userForToken, type User } from './auth.js';
import type { Db } from './db.js';
import {
  createNode,
  ensureInbox,
  getNeighborhood,
  HttpError,
  searchNodes,
  updateNode,
  type CreateNodeInput,
} from './nodes.js';

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `Hibás mező: ${name}`);
  return value;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
  }
}

export interface AppOptions {
  db: Db;
  /** HTTPS mögött true: a süti csak titkosított kapcsolaton megy. */
  secureCookies?: boolean;
  loginAttemptsPerMinute?: number;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { db } = opts;
  const app = Fastify({ trustProxy: true });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Az /api/login kivételével minden API-hívás bejelentkezést kér.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/login') return;
    const user = await userForToken(db, req.cookies[SESSION_COOKIE]);
    if (!user) return reply.code(401).send({ error: 'Bejelentkezés szükséges' });
    req.user = user;
  });

  app.post<{ Body: { email?: string; password?: string } }>(
    '/api/login',
    { config: { rateLimit: { max: opts.loginAttemptsPerMinute ?? 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string') {
        return reply.code(400).send({ error: 'E-mail és jelszó szükséges' });
      }
      const result = await login(db, email, password);
      if (!result) return reply.code(401).send({ error: 'Hibás e-mail vagy jelszó' });
      reply.setCookie(SESSION_COOKIE, result.token, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: opts.secureCookies ?? false,
        maxAge: SESSION_DAYS * 24 * 3600,
      });
      return { user: result.user };
    },
  );

  app.post('/api/logout', async (req, reply) => {
    await logout(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => ({ user: req.user }));

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    // Hibás formátumú azonosító (nem UUID) az adatbázisból
    if (err.code === '22P02') return reply.code(400).send({ error: 'Érvénytelen azonosító' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Szerverhiba' });
  });

  app.post<{ Body: CreateNodeInput }>('/api/nodes', async (req, reply) => {
    const b = req.body ?? ({} as CreateNodeInput);
    if (typeof b.content !== 'string') throw new HttpError(400, 'A szöveg kötelező');
    const result = await createNode(db, req.user.id, {
      content: b.content,
      parentId: optionalString(b.parentId, 'parentId'),
      contextId: optionalString(b.contextId, 'contextId'),
      type: optionalString(b.type, 'type'),
      aliases: Array.isArray(b.aliases) ? b.aliases.filter((a) => typeof a === 'string') : undefined,
    });
    return reply.code(201).send(result);
  });

  app.patch<{
    Params: { id: string };
    Body: { content?: string; version?: number; type?: string | null; aliases?: string[] };
  }>('/api/nodes/:id', async (req) => {
    const { content, version, type, aliases } = req.body ?? {};
    if (!Number.isInteger(version)) throw new HttpError(400, 'A verzió kötelező');
    if (content !== undefined && typeof content !== 'string') throw new HttpError(400, 'Hibás mező: content');
    if (type !== undefined && type !== null && typeof type !== 'string') throw new HttpError(400, 'Hibás mező: type');
    if (aliases !== undefined && !(Array.isArray(aliases) && aliases.every((a) => typeof a === 'string'))) {
      throw new HttpError(400, 'Hibás mező: aliases');
    }
    return updateNode(db, req.user.id, req.params.id, { content, version: version as number, type, aliases });
  });

  // A kezdőpont: a Bejövő node.
  app.get('/api/home', async (req) => ({ id: await ensureInbox(db, req.user.id) }));

  app.get<{ Params: { id: string } }>('/api/nodes/:id', async (req) => getNeighborhood(db, req.params.id));

  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => ({
    results: await searchNodes(db, typeof req.query.q === 'string' ? req.query.q : ''),
  }));

  return app;
}
