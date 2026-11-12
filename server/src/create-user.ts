import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { openStore } from './store.js';

/**
 * Felhasználó létrehozása vagy jelszavának cseréje.
 * Paraméter nélkül futtatva bekéri az adatokat – így a jelszó nem kerül a parancssori előzményekbe.
 */
const interactive = process.stdin.isTTY === true;
let rl: ReturnType<typeof createInterface> | undefined;
let lines: AsyncIterator<string> | undefined;
let muted = false;

// A readline ezen keresztül ír; jelszó bekérésekor elnémítjuk, hogy a begépelt szöveg ne látsszon.
const output = new Writable({
  write(chunk, _encoding, done) {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});

async function ask(question: string, hidden = false): Promise<string> {
  rl ??= createInterface({ input: process.stdin, output, terminal: interactive });
  if (!interactive) {
    // Átirányított bemenet (pl. szkriptből): soronként olvasunk.
    lines ??= rl[Symbol.asyncIterator]();
    process.stdout.write(question);
    const next = await lines.next();
    process.stdout.write('\n');
    return next.done ? '' : next.value.trim();
  }
  const pending = rl.question(question); // a kérdés még kiíródik
  muted = hidden;
  const answer = await pending;
  muted = false;
  if (hidden) process.stdout.write('\n');
  return answer.trim();
}

/** Megmutatja, mit olvastunk ki a DATABASE_URL-ből – a jelszót magát nem, csak a hosszát. */
function describeUrl(): string {
  const raw = process.env.DATABASE_URL ?? '';
  try {
    const url = new URL(raw);
    const password = decodeURIComponent(url.password);
    const hints: string[] = [];
    if (!password) hints.push('a sorban nincs jelszó');
    if (password === 'JELSZO') hints.push('a jelszó helyén még a minta (JELSZO) áll');
    if (/^["']|["']$/.test(raw)) hints.push('a sor idézőjelek között van, ezeket töröld');
    if (/\s/.test(raw)) hints.push('a sorban szóköz van');
    if (!url.pathname.slice(1)) hints.push('hiányzik az adatbázis neve – a jelszóban lévő # / ? jelet kódolni kell');
    return (
      `A .env fájlból ezt olvastam ki: felhasználó "${decodeURIComponent(url.username)}", ` +
      `jelszó ${password.length} karakter, gép "${url.hostname}", port ${url.port || '5432'}, ` +
      `adatbázis "${url.pathname.slice(1)}".` +
      (hints.length ? ` Gyanús: ${hints.join('; ')}.` : ' Ha a jelszó hossza nem stimmel, a különleges karaktereket kódolni kell.')
    );
  } catch {
    return 'A DATABASE_URL nem érvényes URL; a jelszó különleges karaktereit (@ : / # ? %) kódolni kell.';
  }
}

function explain(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e.message?.includes('DATABASE_URL')) {
    return 'A DATABASE_URL nincs beállítva. Másold a .env.example fájlt .env néven a repó gyökerébe, és írd át.';
  }
  if (e.code === 'ECONNREFUSED') return 'Az adatbázis nem érhető el. Fut a PostgreSQL, és jó a gép meg a port a DATABASE_URL-ben?';
  if (e.code === '28P01') return `Az adatbázis elutasította a jelszót. ${describeUrl()}`;
  if (e.code === '3D000') return 'A DATABASE_URL-ben megadott adatbázis nem létezik.';
  if (e.code === '42501') {
    const url = new URL(process.env.DATABASE_URL!);
    const [user, dbName] = [decodeURIComponent(url.username), url.pathname.slice(1)];
    return (
      `A(z) "${user}" felhasználónak nincs joga táblákat létrehozni a(z) "${dbName}" adatbázisban (${e.message}). ` +
      `Futtasd a postgres felhasználóval, a(z) "${dbName}" adatbázishoz kapcsolódva:\n` +
      `  ALTER DATABASE ${dbName} OWNER TO ${user};\n` +
      `  ALTER SCHEMA public OWNER TO ${user};`
    );
  }
  if (e.code === 'ERR_INVALID_URL') return 'A DATABASE_URL nem érvényes. A jelszó különleges karaktereit (@ : / # ? %) kódolni kell.';
  return e.message ?? String(err);
}

try {
  const [argEmail, argName, argPassword] = process.argv.slice(2);
  const store = await openStore();
  try {
    const email = argEmail ?? (await ask('E-mail: '));
    const displayName = argName ?? (await ask('Megjelenített név: '));
    const password = argPassword ?? (await ask('Jelszó (legalább 10 karakter): ', true));
    if (!email.includes('@') || !displayName) throw new Error('Az e-mail és a név kötelező.');
    const user = await store.createUser(email, displayName, password);
    console.log(`Felhasználó kész: ${user.email}`);
  } finally {
    rl?.close();
    await store.close();
  }
} catch (err) {
  console.error(`Hiba: ${explain(err)}`);
  process.exitCode = 1;
}
