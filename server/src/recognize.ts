/**
 * Szabad szöveg felismerése: jegyszám, név, dátum.
 * Tiszta függvények, adatbázis nélkül – a kliens is használhatja kiemeléshez.
 */

export interface Person {
  id: string;
  /** Nevek és becenevek (pl. "Szabi", "Mátrai Peti"); a többtagú név tagjai külön is felismerhetők. */
  names: string[];
}

interface Base {
  start: number;
  end: number;
  text: string;
}
export type TicketSpan = Base & { kind: 'ticket'; ticketNo: number };
/** Ismert embernél personId; a még nem létező @névnél newName (az alapalak, ebből lesz az új ember). */
export type PersonSpan = Base & { kind: 'person'; personId?: string; newName?: string };
/** from és to: YYYY-MM-DD; egyetlen napnál megegyeznek. */
export type DateSpan = Base & { kind: 'date'; from: string; to: string };
export type Span = TicketSpan | PersonSpan | DateSpan;

export interface RecognizeOptions {
  /** A rögzítés napja (YYYY-MM-DD); a relatív dátumok ehhez képest értendők. */
  today: string;
  people?: Person[];
  /** Már létező jegyek: ezeknél a # nélküli szám is jegynek számít. */
  knownTickets?: ReadonlySet<number>;
}

// A \b nem kezeli az ékezetes betűket, ezért saját szóhatár.
const B = '(?<![\\p{L}\\d])';
const E = '(?![\\p{L}\\d])';
const re = (src: string) => new RegExp(src, 'giu');

// ---------- dátumszámítás ----------

const DAY = 86_400_000;
const toDays = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const fromDays = (days: number) => new Date(days * DAY).toISOString().slice(0, 10);

function ymd(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Év nélküli hónap-nap: a rögzítés napjához legközelebbi előfordulás. */
function closest(today: string, m: number, d: number): string | null {
  const year = Number(today.slice(0, 4));
  const t = toDays(today);
  let best: string | null = null;
  for (const y of [year - 1, year, year + 1]) {
    const c = ymd(y, m, d);
    if (c && (best === null || Math.abs(toDays(c) - t) < Math.abs(toDays(best) - t))) best = c;
  }
  return best;
}

/** 0 = hétfő … 6 = vasárnap */
const weekday = (days: number) => (((days + 3) % 7) + 7) % 7;

const MONTHS: [string, number][] = [
  ['január', 1], ['jan', 1], ['február', 2], ['febr', 2], ['feb', 2], ['március', 3], ['márc', 3],
  ['április', 4], ['ápr', 4], ['május', 5], ['máj', 5], ['június', 6], ['jún', 6], ['július', 7], ['júl', 7],
  ['augusztus', 8], ['aug', 8], ['szeptember', 9], ['szept', 9], ['október', 10], ['okt', 10],
  ['november', 11], ['nov', 11], ['december', 12], ['dec', 12],
];
const MONTH_ALT = MONTHS.map(([n]) => n).join('|');
const monthNo = (name: string) => MONTHS.find(([n]) => n === name.toLowerCase())![1];

// Ragozva is illeszkedő tövek: kedden, szerdán, pénteken, csütörtökig …
const WEEKDAYS = ['hétfő', 'kedd', 'szerd', 'csütörtök', 'péntek', 'szombat', 'vasárnap'];
const DAY_SUFFIX = 'án|én|ig|ára|ére|ától|étől|jén|ján|tól|től|e';

type Found = { start: number; end: number; from: string; to: string };

function findDates(text: string, today: string): Found[] {
  const t = toDays(today);
  const found: Found[] = [];
  const add = (m: RegExpMatchArray, from: string | null, to: string | null = from, len = m[0].length) => {
    if (from && to) found.push({ start: m.index!, end: m.index! + len, from, to });
  };

  // 2026-11-20, 2026.11.20.
  for (const m of text.matchAll(re(`${B}(\\d{4})[.-]\\s?(\\d{1,2})[.-]\\s?(\\d{1,2})(?!\\d)`))) {
    add(m, ymd(+m[1]!, +m[2]!, +m[3]!));
  }
  // nov. 20, november 20, dec 22
  for (const m of text.matchAll(re(`${B}(${MONTH_ALT})\\.?\\s*(\\d{1,2})(?!\\d)`))) {
    add(m, closest(today, monthNo(m[1]!), +m[2]!));
  }
  // 11.20, 11.20., 3.5-én – tizedes törtet (1.5) és verziószámot (1.2.3) nem veszünk dátumnak
  for (const m of text.matchAll(re(`(?<![\\p{L}\\d.])(\\d{1,2})\\.\\s?(\\d{1,2})(?![\\d])`))) {
    const after = text.slice(m.index! + m[0].length);
    if (/^\.\d/.test(after)) continue;
    const marked = /^\./.test(after) || new RegExp(`^-(${DAY_SUFFIX})${E}`, 'iu').test(after);
    if (!marked && !(m[1]!.length === 2 && m[2]!.length === 2)) continue;
    add(m, closest(today, +m[1]!, +m[2]!));
  }
  // 20-án, 5-ig: a következő ilyen nap
  for (const m of text.matchAll(re(`(?<![\\p{L}\\d.])(\\d{1,2})-(?:${DAY_SUFFIX})${E}`))) {
    const [y, mo] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    const d = +m[1]!;
    const candidates = [ymd(y, mo, d), mo === 12 ? ymd(y + 1, 1, d) : ymd(y, mo + 1, d)];
    add(m, candidates.find((c) => c && toDays(c) >= t) ?? null, undefined, m[1]!.length);
  }
  // pénteken, jövő kedd, jövő héten szerdán, múlt hétfőn
  for (const m of text.matchAll(
    re(`${B}(?:(jövő|múlt)\\s+(?:hét(?:en)?\\s+)?)?(${WEEKDAYS.join('|')})\\p{L}*`),
  )) {
    const target = WEEKDAYS.indexOf(m[2]!.toLowerCase());
    const monday = t - weekday(t);
    const prefix = m[1]?.toLowerCase();
    const day =
      prefix === 'jövő' ? monday + 7 + target
      : prefix === 'múlt' ? monday - 7 + target
      : t + ((target - weekday(t) + 7) % 7); // a mai nap is számít
    add(m, fromDays(day));
  }
  // jövő hét, jövő héten: hétfőtől vasárnapig
  for (const m of text.matchAll(re(`${B}jövő\\s+hét(?:en|re|ig)?${E}`))) {
    const monday = t - weekday(t) + 7;
    add(m, fromDays(monday), fromDays(monday + 6));
  }
  // ma, holnap, holnapután, tegnap
  for (const m of text.matchAll(re(`${B}(holnapután|holnap|tegnapelőtt|tegnap)\\p{L}*|${B}ma${E}`))) {
    const offset = { holnapután: 2, holnap: 1, tegnapelőtt: -2, tegnap: -1 }[m[1]?.toLowerCase() ?? ''] ?? 0;
    add(m, fromDays(t + offset));
  }
  // 3 nap múlva, 2 hét múlva
  for (const m of text.matchAll(re(`${B}(\\d{1,3})\\s+(nap|hét)\\s+múlva${E}`))) {
    add(m, fromDays(t + +m[1]! * (m[2]!.toLowerCase() === 'hét' ? 7 : 1)));
  }

  // Átfedésnél a korábban kezdődő, azon belül a hosszabb találat marad.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Found[] = [];
  for (const f of found) if (!kept.length || f.start >= kept.at(-1)!.end) kept.push(f);

  // Időszak: két dátum között csak kötőjel áll (dec 22–jan 2, 12.22-01.02).
  const merged: Found[] = [];
  for (const f of kept) {
    const prev = merged.at(-1);
    if (prev && /^\s*[-–—]\s*$/.test(text.slice(prev.end, f.start))) {
      let to = f.to;
      if (toDays(to) < toDays(prev.from)) {
        to = ymd(Number(to.slice(0, 4)) + 1, Number(to.slice(5, 7)), Number(to.slice(8, 10))) ?? to;
      }
      if (toDays(to) >= toDays(prev.from)) {
        merged[merged.length - 1] = { start: prev.start, end: f.end, from: prev.from, to };
        continue;
      }
    }
    merged.push(f);
  }

  // Ugyanaz a nap vagy időszak kétféleképpen, egymás mellett (2026-11-12 csütörtökön,
  // 2026-12-22–2027-01-02 dec 22–jan 2): egy kiemelés. Az időszakok összevonása után.
  const joined: Found[] = [];
  for (const f of merged) {
    const prev = joined.at(-1);
    if (prev && /^\s+$/.test(text.slice(prev.end, f.start)) && prev.from === f.from && prev.to === f.to) {
      joined[joined.length - 1] = { ...prev, end: f.end };
    } else {
      joined.push(f);
    }
  }
  return joined;
}

// ---------- relatív dátum kiegészítése ----------

// Az évvel megadott dátum egyértelmű; minden más (napnév, holnap, 20-án, december 10-én, 11.20)
// a rögzítés napjától függ.
const ABSOLUTE_DATE = /\d{4}/;

/**
 * Az év nélküli dátum (csütörtökön, holnap, jövő héten, 20-án, december 10-én) elé beírja a pontos dátumot:
 * „csütörtökön később kezd” -> „2026-11-12 csütörtökön később kezd”. Időszaknál a két végpontot.
 * Másodszorra nem ír elé, mert a kettő már egy kiemelés, benne évvel.
 */
export function anchorRelativeDates(text: string, today: string): string {
  const relative = recognize(text, { today }).filter(
    (s): s is DateSpan => s.kind === 'date' && !ABSOLUTE_DATE.test(s.text),
  );
  let out = text;
  for (const s of relative.reverse()) {
    out = `${out.slice(0, s.start)}${s.from === s.to ? s.from : `${s.from}–${s.to}`} ${out.slice(s.start)}`;
  }
  return out;
}

// ---------- nevek ----------

const CASE_SUFFIXES = new Set([
  'nak', 'nek', 'val', 'vel', 'tól', 'től', 'ról', 'ről', 'hoz', 'hez', 'höz', 'nál', 'nél',
  'ra', 're', 'ba', 'be', 'ban', 'ben', 'ból', 'ből', 'ig', 'ért', 'ék', 'é', 't', 'ot', 'et', 'öt', 'at',
  'n', 'on', 'en', 'ön', 'ként',
]);

/** Igaz, ha a szó a név ragozott alakja (Szabinak, Istvánnal, Gézától). */
export function matchesName(word: string, name: string): boolean {
  const w = word.toLowerCase();
  const n = name.toLowerCase();
  if (w === n) return true;
  const stems = [n];
  if (n.endsWith('a')) stems.push(`${n.slice(0, -1)}á`); // Géza -> Gézának
  if (n.endsWith('e')) stems.push(`${n.slice(0, -1)}é`); // Imre -> Imrével
  for (const stem of stems) {
    if (!w.startsWith(stem)) continue;
    const rest = w.slice(stem.length);
    if (CASE_SUFFIXES.has(rest)) return true;
    // -val/-vel hasonulás: István+nal, Péter+rel
    if (rest.length === 3 && rest[0] === stem.at(-1) && (rest.endsWith('al') || rest.endsWith('el'))) return true;
  }
  return false;
}

// Ismeretlen névnél csak a hosszabb ragokat vágjuk le: a rövidek (-t, -n, -ra) és a -nál/-nél
// gyakran a név része (Bálint, Zoltán, Klára, Kornél).
const LONG_SUFFIXES = ['nak', 'nek', 'val', 'vel', 'tól', 'től', 'ról', 'ről', 'hoz', 'hez', 'höz', 'ból', 'ből', 'ért', 'ként'];

/** A @-os, még ismeretlen név alapalakja: @Gézának -> Géza, @Istvánnal -> István, @Zoltán -> Zoltán. */
export function baseName(word: string): string {
  const lower = word.toLowerCase();
  let stem = word;
  const suffix = LONG_SUFFIXES.find((s) => lower.endsWith(s) && lower.length - s.length >= 3);
  if (suffix) stem = word.slice(0, -suffix.length);
  else if (lower.length >= 6 && /(\p{L})\1[ae]l$/u.test(lower)) stem = word.slice(0, -3); // Istvánnal, Péterrel
  if (stem !== word) stem = stem.replace(/á$/, 'a').replace(/é$/, 'e'); // Gézá-nak -> Géza
  return stem[0]!.toUpperCase() + stem.slice(1);
}

interface Word {
  text: string;
  start: number;
  end: number;
}
const wordsOf = (text: string): Word[] =>
  [...text.matchAll(/\p{L}+/gu)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
/** A többtagú név tagjai között csak szóköz állhat; sortörés vagy írásjel nem. */
const joined = (text: string, a: Word, b: Word) => /^[ \t]+$/.test(text.slice(a.end, b.start));

/** A felismerhető névalakok: a teljes név (Mátrai Peti) és külön a tagjai (Mátrai, Peti). */
interface NameForm {
  personId: string;
  parts: string[];
  full: boolean;
}
function nameForms(people: Person[]): NameForm[] {
  return people.flatMap((p) =>
    p.names.flatMap((name) => {
      const parts = name.split(/\s+/).filter(Boolean);
      const own = parts.length ? [{ personId: p.id, parts, full: true }] : [];
      if (parts.length < 2) return own;
      return [...own, ...parts.filter((w) => w.length >= 2).map((w) => ({ personId: p.id, parts: [w], full: false }))];
    }),
  );
}

/** A szavak ugyanazt a nevet adják-e; csak az utolsó tag lehet ragozott (Mátrai Petinek). */
function matchesForm(words: Word[], parts: string[]): boolean {
  return (
    words.length === parts.length &&
    parts.every((p, k) => (k === parts.length - 1 ? matchesName(words[k]!.text, p) : words[k]!.text.toLowerCase() === p.toLowerCase()))
  );
}

/**
 * Az i. szótól kezdődő leghosszabb ismert név. personId null, ha több emberre is illik
 * (a teljes névvel egyező ember elsőbbséget kap a tagra illővel szemben).
 */
function knownAt(text: string, words: Word[], i: number, forms: NameForm[]) {
  const longest = Math.max(0, ...forms.map((f) => f.parts.length));
  for (let len = Math.min(longest, words.length - i); len >= 1; len--) {
    const ws = words.slice(i, i + len);
    if (!ws.every((w, k) => k === 0 || joined(text, ws[k - 1]!, w))) continue;
    const hits = forms.filter((f) => matchesForm(ws, f.parts));
    if (!hits.length) continue;
    const ids = (full: boolean) => [...new Set(hits.filter((h) => h.full === full).map((h) => h.personId))];
    const [fullIds, partIds] = [ids(true), ids(false)];
    const chosen = fullIds.length ? fullIds : partIds;
    return { len, full: fullIds.length > 0, personId: chosen.length === 1 ? chosen[0]! : null };
  }
  return null;
}

const MAX_NEW_NAME_WORDS = 3;
const capitalize = (w: string) => w[0]!.toUpperCase() + w.slice(1);

/**
 * @név: kis- és nagybetűvel is név; ha még nincs ilyen ember, új jön létre. Az e-mail cím nem az.
 * Az ismeretlen névhez a mögötte álló nagybetűs (nem csupa nagybetűs) szavak is hozzátartoznak,
 * legfeljebb három tagig: @Mátrai Peti, de @Ákos FDD -> Ákos.
 */
function findTaggedPeople(text: string, words: Word[], forms: NameForm[]): PersonSpan[] {
  const spans: PersonSpan[] = [];
  for (const m of text.matchAll(/(?<![\p{L}\d])@(\p{L}+)/gu)) {
    const i = words.findIndex((w) => w.start === m.index! + 1);
    let run = 1;
    while (
      run < MAX_NEW_NAME_WORDS &&
      i + run < words.length &&
      joined(text, words[i + run - 1]!, words[i + run]!) &&
      /^\p{Lu}\p{Ll}/u.test(words[i + run]!.text)
    ) {
      run++;
    }
    const known = knownAt(text, words, i, forms);
    const useKnown = known && (known.len >= run || known.full);
    const len = useKnown ? known.len : run;
    const [start, end] = [m.index!, words[i + len - 1]!.end];
    const base = { kind: 'person' as const, start, end, text: text.slice(start, end) };
    if (useKnown) {
      // Ha több emberre is illik, nem találgatunk.
      if (known.personId) spans.push({ ...base, personId: known.personId });
    } else {
      const ws = words.slice(i, i + run).map((w) => w.text);
      spans.push({ ...base, newName: [...ws.slice(0, -1).map(capitalize), baseName(ws.at(-1)!)].join(' ') });
    }
  }
  return spans;
}

function findPeople(text: string, words: Word[], forms: NameForm[]): PersonSpan[] {
  const spans: PersonSpan[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!.text;
    // Csak nagybetűs szó lehet név, különben a "szabi" (szabadság) is Szabi lenne.
    if (word[0] !== word[0]!.toUpperCase() || word[0] === word[0]!.toLowerCase()) continue;
    const known = knownAt(text, words, i, forms);
    if (!known) continue;
    const [start, end] = [words[i]!.start, words[i + known.len - 1]!.end];
    // Ha több emberre is illik, nem találgatunk.
    if (known.personId) spans.push({ kind: 'person', start, end, text: text.slice(start, end), personId: known.personId });
    i += known.len - 1;
  }
  return spans;
}

// ---------- összefésülés ----------

export function recognize(text: string, opts: RecognizeOptions): Span[] {
  const spans: Span[] = [];
  const overlaps = (start: number, end: number) => spans.some((s) => start < s.end && end > s.start);
  const words = wordsOf(text);
  const forms = nameForms(opts.people ?? []);

  for (const m of text.matchAll(/#(\d{1,7})(?!\d)/g)) {
    spans.push({ kind: 'ticket', start: m.index!, end: m.index! + m[0].length, text: m[0], ticketNo: +m[1]! });
  }
  spans.push(...findTaggedPeople(text, words, forms));
  for (const d of findDates(text, opts.today)) {
    if (!overlaps(d.start, d.end)) spans.push({ kind: 'date', text: text.slice(d.start, d.end), ...d });
  }
  if (opts.knownTickets?.size) {
    for (const m of text.matchAll(re(`${B}(?<![#.,])(\\d{2,7})(?![.,]\\d)${E}`))) {
      const [start, end] = [m.index!, m.index! + m[0].length];
      if (opts.knownTickets.has(+m[1]!) && !overlaps(start, end)) {
        spans.push({ kind: 'ticket', start, end, text: m[0], ticketNo: +m[1]! });
      }
    }
  }
  for (const p of findPeople(text, words, forms)) {
    if (!overlaps(p.start, p.end)) spans.push(p);
  }
  return spans.sort((a, b) => a.start - b.start);
}
