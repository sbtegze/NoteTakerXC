import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { login, logout, SESSION_COOKIE, SESSION_DAYS, userForToken, type User } from './auth.js';
import type { Db } from './db.js';

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

  return app;
}
