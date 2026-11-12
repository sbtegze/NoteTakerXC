import { withUser, type Db, type Tx } from './db.js';
import { recognize, type Person, type Span } from './recognize.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface NodeRow {
  id: string;
  content: string;
  type: string | null;
  aliases: string[];
  ticket_no: number | null;
  is_inbox: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** A felismert szövegrész, a hozzá tartozó node azonosítójával (jegynél, embernél). */
export type LinkedSpan = Span & { targetId?: string };

type Queryable = Pick<Tx, 'query'>;

const NODE_COLS = 'id, content, type, aliases, ticket_no, is_inbox, version, created_at, updated_at';
const N_COLS = NODE_COLS.split(', ').map((c) => `n.${c}`).join(', ');
const TIMEZONE = process.env.APP_TIMEZONE ?? 'Europe/Budapest';
export const NODE_TYPES = ['person', 'ticket', 'meeting', 'topic'] as const;

/** A naptári nap (YYYY-MM-DD) az alkalmazás időzónájában. */
export function localDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(at);
}

export async function ensureInbox(tx: Queryable, userId: string): Promise<string> {
  const existing = await tx.query('SELECT id FROM nodes WHERE is_inbox');
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await tx.query(
    `INSERT INTO nodes (content, is_inbox, created_by, updated_by) VALUES ('Bejövő', true, $1, $1) RETURNING id`,
    [userId],
  );
  return rows[0].id;
}

// ---------- felismerés ----------

interface RecognitionContext {
  people: Person[];
  tickets: Map<number, string>;
}

export async function loadContext(q: Queryable): Promise<RecognitionContext> {
  const people = await q.query(`SELECT id, content, aliases FROM nodes WHERE type = 'person' AND deleted_at IS NULL`);
  const tickets = await q.query('SELECT id, ticket_no FROM nodes WHERE ticket_no IS NOT NULL AND deleted_at IS NULL');
  return {
    people: people.rows.map((r) => ({
      id: r.id,
      // A node első sorának szavai és a becenevek: "Kovács István" -> Kovács, István
      names: [...(r.content.split('\n')[0] ?? '').split(/\s+/), ...r.aliases].filter((n: string) => n.length >= 2),
    })),
    tickets: new Map(tickets.rows.map((r) => [r.ticket_no, r.id])),
  };
}

export function spansOf(node: Pick<NodeRow, 'id' | 'content' | 'created_at'>, ctx: RecognitionContext): LinkedSpan[] {
  return recognize(node.content, {
    today: localDate(node.created_at), // a relatív dátumok a rögzítés napjához képest értendők
    people: ctx.people.filter((p) => p.id !== node.id),
    knownTickets: new Set(ctx.tickets.keys()),
  }).map((s) => ({
    ...s,
    targetId: s.kind === 'person' ? s.personId : s.kind === 'ticket' ? ctx.tickets.get(s.ticketNo) : undefined,
  }));
}

async function ticketNode(tx: Tx, userId: string, ticketNo: number, ctx: RecognitionContext): Promise<string> {
  const known = ctx.tickets.get(ticketNo);
  if (known) return known;
  const { rows } = await tx.query(
    `INSERT INTO nodes (content, type, ticket_no, created_by, updated_by) VALUES ($1, 'ticket', $2, $3, $3) RETURNING id`,
    [`#${ticketNo}`, ticketNo, userId],
  );
  ctx.tickets.set(ticketNo, rows[0].id);
  return rows[0].id;
}

/**
 * Újraszámolja a node szövegéből származtatott adatokat: az említéseket
 * (mention kapcsolatok) és a dátumokat. A kézzel megerősített dátumokhoz nem nyúl.
 */
async function applyRecognition(tx: Tx, userId: string, node: NodeRow, ctx: RecognitionContext): Promise<LinkedSpan[]> {
  const spans = spansOf(node, ctx);
  const targets = new Set<string>();
  for (const s of spans) {
    if (s.kind === 'person' && s.personId) targets.add(s.personId);
    if (s.kind === 'ticket') {
      s.targetId = await ticketNode(tx, userId, s.ticketNo, ctx);
      targets.add(s.targetId);
    }
  }
  targets.delete(node.id); // a node önmagát nem említi

  await tx.query(`DELETE FROM edges WHERE source_id = $1 AND kind = 'mention' AND NOT (target_id = ANY($2::uuid[]))`, [
    node.id,
    [...targets],
  ]);
  for (const target of targets) {
    await tx.query(
      `INSERT INTO edges (source_id, target_id, kind, created_by) VALUES ($1, $2, 'mention', $3)
       ON CONFLICT (source_id, target_id, kind) DO NOTHING`,
      [node.id, target, userId],
    );
  }

  const confirmed = await tx.query('SELECT source_text FROM node_dates WHERE node_id = $1 AND confirmed', [node.id]);
  const kept = new Set(confirmed.rows.map((r) => r.source_text));
  const wanted = spans.filter((s) => s.kind === 'date' && !kept.has(s.text));
  const current = await tx.query(
    'SELECT starts_on, ends_on, source_text FROM node_dates WHERE node_id = $1 AND NOT confirmed ORDER BY source_text',
    [node.id],
  );
  const key = (from: string, to: string, text: string) => `${from}|${to}|${text}`;
  const before = current.rows.map((r) => key(r.starts_on, r.ends_on, r.source_text));
  const after = wanted.map((s) => (s.kind === 'date' ? key(s.from, s.to, s.text) : '')).sort();
  if (before.sort().join('\n') !== after.join('\n')) {
    await tx.query('DELETE FROM node_dates WHERE node_id = $1 AND NOT confirmed', [node.id]);
    for (const s of wanted) {
      if (s.kind !== 'date') continue;
      await tx.query('INSERT INTO node_dates (node_id, starts_on, ends_on, source_text) VALUES ($1, $2, $3, $4)', [
        node.id,
        s.from,
        s.to,
        s.text,
      ]);
    }
  }
  return spans;
}

/**
 * A @-tal említett, még nem létező embereket létrehozza. Egyenként, a legrövidebb alapalakkal kezdve,
 * hogy a „@Gézának … @Gézát” egy embert adjon. Igazat ad, ha jött létre új.
 */
async function createTaggedPeople(tx: Tx, userId: string, node: NodeRow, ctx: RecognitionContext): Promise<boolean> {
  const created = new Set<string>();
  for (;;) {
    const names = spansOf(node, ctx).flatMap((s) => (s.kind === 'person' && s.newName ? [s.newName] : []));
    if (!names.length) return created.size > 0;
    const name = names.reduce((a, b) => (b.length < a.length ? b : a));
    if (created.has(name)) return true; // nem fordulhat elő: a létrehozott név illik a szóra
    const { rows } = await tx.query(
      `INSERT INTO nodes (content, type, created_by, updated_by) VALUES ($1, 'person', $2, $2) RETURNING id`,
      [name, userId],
    );
    ctx.people.push({ id: rows[0].id, names: [name] });
    created.add(name);
  }
}

/** Ha változott az emberek köre vagy neve, minden szöveg említéseit újraszámoljuk. */
async function reindexAll(tx: Tx, userId: string): Promise<void> {
  const ctx = await loadContext(tx);
  const { rows } = await tx.query(`SELECT ${NODE_COLS} FROM nodes WHERE deleted_at IS NULL`);
  for (const node of rows) await applyRecognition(tx, userId, node, ctx);
}

// ---------- írás ----------

export interface CreateNodeInput {
  content: string;
  /** A kiválasztott node, amihez az új tartozik; ha nincs, a Bejövő. */
  parentId?: string;
  /** Második szülő, pl. a nyitott meeting. */
  contextId?: string;
  type?: string;
  aliases?: string[];
}

export async function requireNode(tx: Queryable, id: string): Promise<void> {
  const { rowCount } = await tx.query('SELECT 1 FROM nodes WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!rowCount) throw new HttpError(404, 'A node nem található');
}

function checkType(type: string | null | undefined): void {
  if (type != null && !(NODE_TYPES as readonly string[]).includes(type)) throw new HttpError(400, 'Ismeretlen típus');
}

export function createNode(db: Db, userId: string, input: CreateNodeInput) {
  const content = input.content?.trim();
  if (!content) throw new HttpError(400, 'A szöveg nem lehet üres');
  checkType(input.type);
  return withUser(db, userId, async (tx) => {
    const parentId = input.parentId ?? (await ensureInbox(tx, userId));
    await requireNode(tx, parentId);
    if (input.contextId) await requireNode(tx, input.contextId);

    const { rows } = await tx.query(
      `INSERT INTO nodes (content, type, aliases, created_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING ${NODE_COLS}`,
      [content, input.type ?? null, input.aliases ?? [], userId],
    );
    const node: NodeRow = rows[0];

    for (const source of new Set([parentId, input.contextId])) {
      if (!source) continue;
      await tx.query(`INSERT INTO edges (source_id, target_id, kind, created_by) VALUES ($1, $2, 'unsorted', $3)`, [
        source,
        node.id,
        userId,
      ]);
    }
    const createdPeople = await createTaggedPeople(tx, userId, node, await loadContext(tx));
    if (node.type === 'person' || createdPeople) await reindexAll(tx, userId);
    return { node, spans: await applyRecognition(tx, userId, node, await loadContext(tx)) };
  });
}

export interface UpdateNodeInput {
  version: number;
  content?: string;
  /** null: a típus törlése */
  type?: string | null;
  aliases?: string[];
}

export function updateNode(db: Db, userId: string, id: string, input: UpdateNodeInput) {
  const content = input.content?.trim();
  if (input.content !== undefined && !content) throw new HttpError(400, 'A szöveg nem lehet üres');
  checkType(input.type);
  return withUser(db, userId, async (tx) => {
    const before = await tx.query('SELECT type FROM nodes WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before.rows[0]) throw new HttpError(404, 'A node nem található');
    const { rows } = await tx.query(
      `UPDATE nodes SET
         content = coalesce($1, content),
         type = CASE WHEN $2 THEN $3 ELSE type END,
         aliases = coalesce($4, aliases),
         updated_by = $5
       WHERE id = $6 AND version = $7 AND deleted_at IS NULL RETURNING ${NODE_COLS}`,
      [content ?? null, input.type !== undefined, input.type ?? null, input.aliases ?? null, userId, id, input.version],
    );
    const node: NodeRow | undefined = rows[0];
    if (!node) throw new HttpError(409, 'A node közben megváltozott');
    const createdPeople = await createTaggedPeople(tx, userId, node, await loadContext(tx));
    if (node.type === 'person' || before.rows[0].type === 'person' || createdPeople) await reindexAll(tx, userId);
    return { node, spans: await applyRecognition(tx, userId, node, await loadContext(tx)) };
  });
}

// ---------- olvasás ----------

const brief = (r: NodeRow) => ({ id: r.id, content: r.content, type: r.type, ticket_no: r.ticket_no, is_inbox: r.is_inbox });

export interface NoteRow {
  id: string;
  node_id: string;
  content: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export const NOTE_COLS = 'id, node_id, content, version, created_at, updated_at';

/** A komment a kiemelendő szövegrészekkel; a node önmagát nem említi, ezért a node azonosítójával ismerjük fel. */
export const noteWithSpans = (n: NoteRow, ctx: RecognitionContext) => ({
  ...n,
  spans: spansOf({ id: n.node_id, content: n.content, created_at: n.created_at }, ctx),
});

/** A középre állított node és minden, ami közvetlenül kapcsolódik hozzá. */
export async function getNeighborhood(db: Db, id: string) {
  const center = (await db.query(`SELECT ${NODE_COLS} FROM nodes WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0] as
    | NodeRow
    | undefined;
  if (!center) throw new HttpError(404, 'A node nem található');
  const ctx = await loadContext(db);

  // Ide tartozik: a node szülei.
  const parents = await db.query(
    `SELECT ${N_COLS} FROM edges e JOIN nodes n ON n.id = e.source_id
     WHERE e.target_id = $1 AND e.kind IN ('unsorted', 'belongs_to') AND n.deleted_at IS NULL
     ORDER BY n.created_at`,
    [id],
  );

  // Alatta lévő node-ok és minden bejegyzés, ami említi – időrendben, egyszer.
  const below = await db.query(
    `SELECT ${N_COLS}, bool_or(e.source_id = $1) AS is_child, bool_or(e.kind = 'mention') AS is_mention
     FROM nodes n JOIN edges e
       ON (e.target_id = n.id AND e.source_id = $1 AND e.kind IN ('unsorted', 'belongs_to'))
       OR (e.source_id = n.id AND e.target_id = $1 AND e.kind = 'mention')
     WHERE n.deleted_at IS NULL
     GROUP BY n.id ORDER BY n.created_at`,
    [id],
  );
  const belowIds = below.rows.map((r) => r.id);

  // Hol hangzott el: a bejegyzések többi szülője (pl. a meeting).
  const contexts = await db.query(
    `SELECT e.target_id, ${N_COLS} FROM edges e JOIN nodes n ON n.id = e.source_id
     WHERE e.target_id = ANY($1::uuid[]) AND e.kind IN ('unsorted', 'belongs_to')
       AND e.source_id <> $2 AND n.deleted_at IS NULL
     ORDER BY n.created_at`,
    [belowIds, id],
  );
  const dates = await db.query(
    `SELECT node_id, starts_on, ends_on, meaning, source_text, confirmed FROM node_dates
     WHERE node_id = ANY($1::uuid[]) ORDER BY starts_on`,
    [[id, ...belowIds]],
  );

  // Kapcsolódik: akiket és amiket ugyanezek a bejegyzések (és maga a node) még említenek.
  const connected = await db.query(
    `SELECT ${N_COLS}, count(*)::int AS mentions, max(src.created_at) AS last_at
     FROM edges m JOIN nodes n ON n.id = m.target_id JOIN nodes src ON src.id = m.source_id
     WHERE m.kind = 'mention' AND m.source_id = ANY($1::uuid[]) AND n.id <> $2 AND n.deleted_at IS NULL
     GROUP BY n.id ORDER BY last_at DESC`,
    [[id, ...belowIds], id],
  );
  const notes = await db.query(
    `SELECT ${NOTE_COLS} FROM notes WHERE node_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY created_at`,
    [[id, ...belowIds]],
  );

  const datesOf = (nodeId: string) =>
    dates.rows.filter((d) => d.node_id === nodeId).map(({ node_id: _omit, ...d }) => d);
  const detailed = (r: NodeRow) => ({
    ...brief(r),
    version: r.version,
    aliases: r.aliases,
    created_at: r.created_at,
    spans: spansOf(r, ctx),
    dates: datesOf(r.id),
    notes: (notes.rows as NoteRow[]).filter((n) => n.node_id === r.id).map((n) => noteWithSpans(n, ctx)),
  });

  return {
    center: detailed(center),
    parents: parents.rows.map(brief),
    below: below.rows.map((r) => ({
      ...detailed(r),
      is_child: r.is_child as boolean,
      contexts: contexts.rows.filter((c) => c.target_id === r.id).map(brief),
    })),
    connected: connected.rows.map((r) => ({ ...brief(r), mentions: r.mentions as number, last_at: r.last_at as Date })),
  };
}

export async function searchNodes(db: Db, query: string) {
  const q = query.trim();
  if (!q) return [];
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const { rows } = await db.query(
    `SELECT ${NODE_COLS} FROM nodes
     WHERE deleted_at IS NULL
       AND (content ILIKE $1 OR to_tsvector('hungarian', content) @@ plainto_tsquery('hungarian', $2))
     ORDER BY (type IS NOT NULL) DESC, (content ILIKE $3) DESC, updated_at DESC
     LIMIT 20`,
    [pattern, q, `${pattern.slice(1)}`],
  );
  return rows.map(brief);
}
