import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'sid';
export const SESSION_DAYS = 30;

export interface User {
  id: string;
  email: string;
  display_name: string;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createUser(db: Db, email: string, displayName: string, password: string): Promise<User> {
  if (password.length < 10) throw new Error('A jelszó legalább 10 karakter legyen');
  const { rows } = await db.query(
    `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET display_name = excluded.display_name, password_hash = excluded.password_hash
     RETURNING id, email, display_name`,
    [email.toLowerCase(), displayName, await hashPassword(password)],
  );
  return rows[0];
}

// Ismeretlen e-mailnél is elvégezzük a jelszóellenőrzést, hogy a válaszidő ne árulja el, létezik-e a fiók.
const DUMMY_HASH = await hashPassword(randomBytes(12).toString('hex'));

export async function login(db: Db, email: string, password: string): Promise<{ token: string; user: User } | null> {
  const { rows } = await db.query(
    'SELECT id, email, display_name, password_hash FROM users WHERE email = $1',
    [email.toLowerCase()],
  );
  const row = rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) return null;
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), row.id, SESSION_DAYS],
  );
  return { token, user: { id: row.id, email: row.email, display_name: row.display_name } };
}

export async function userForToken(db: Db, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

export async function logout(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}
