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
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** A felismert szövegrész, a hozzá tartozó node azonosítójával (jegynél, embernél). */
export type LinkedSpan = Span & { targetId?: string };

type Queryable = Pick<Tx, 'query'>;

const NODE_COLS = 'id, content, type, aliases, ticket_no, version, created_at, updated_at';
const N_COLS = NODE_COLS.split(', ').map((c) => `n.${c}`).join(', ');
const TIMEZONE = process.env.APP_TIMEZONE ?? 'Europe/Budapest';
export const NODE_TYPES = ['person', 'ticket', 'meeting', 'topic'] as const;

/** A naptári nap (YYYY-MM-DD) az alkalmazás időzónájában. */
export function localDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(at);
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
      // A node első sora és a becenevek; a többtagú név tagjait ("Kovács István" -> Kovács, István)
      // a felismerő maga bontja ki.
      names: [(r.content.split('\n')[0] ?? '').trim(), ...r.aliases].filter((n: string) => n.length >= 2),
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
  /** A kiválasztott node, amihez az új tartozik; ha nincs, legfelső szintű lesz. */
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
    const parentId = input.parentId;
    if (parentId) await requireNode(tx, parentId);
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
    // Ember csak @Név-vel jön létre; egy bejegyzésből különben másolat-ember lenne.
    if (input.type === 'person' && before.rows[0].type !== 'person') {
      throw new HttpError(400, 'Embert a szövegben @Név formában hozz létre');
    }
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

/**
 * Törölhető az a node, amelynek legfeljebb egy kapcsolata van, és az is a szülője felé mutat
 * (a legfelső szintűnek egy sincs), és nincs (élő) kommentje. SQL-kifejezés az `n` aliasú node-ra.
 */
const DELETABLE = `(
  CASE (SELECT count(*) FROM edges e WHERE n.id IN (e.source_id, e.target_id))
    WHEN 0 THEN true
    WHEN 1 THEN EXISTS (SELECT 1 FROM edges e WHERE e.target_id = n.id AND e.kind IN ('unsorted', 'belongs_to'))
    ELSE false
  END
  AND NOT EXISTS (SELECT 1 FROM notes c WHERE c.node_id = n.id AND c.deleted_at IS NULL))`;

/** Végleges törlés: a sor és a kapcsolata eltűnik, visszaállítás nincs; a napló „remove” bejegyzést kap. */
export function deleteNode(db: Db, userId: string, id: string, version: unknown) {
  if (!Number.isInteger(version)) throw new HttpError(400, 'A verzió kötelező');
  return withUser(db, userId, async (tx) => {
    const { rows } = await tx.query(
      `SELECT n.version, n.type, ${DELETABLE} AS deletable,
         (SELECT e.source_id FROM edges e WHERE e.target_id = n.id LIMIT 1) AS parent_id
       FROM nodes n WHERE n.id = $1 AND n.deleted_at IS NULL FOR UPDATE`,
      [id],
    );
    const node = rows[0];
    if (!node) throw new HttpError(404, 'A node nem található');
    if (node.version !== version) throw new HttpError(409, 'A node közben megváltozott');
    if (!node.deletable) {
      throw new HttpError(409, 'Csak az a node törölhető, amelynek csak a szülője felé van kapcsolata, és nincs kommentje');
    }
    await tx.query('DELETE FROM notes WHERE node_id = $1', [id]); // a már törölt kommentek
    await tx.query('DELETE FROM edges WHERE target_id = $1', [id]);
    await tx.query('DELETE FROM nodes WHERE id = $1', [id]); // a dátumok vele mennek (ON DELETE CASCADE)
    if (node.type === 'person') await reindexAll(tx, userId); // pl. a „Peti” újra egyértelmű lehet
    return { parentId: (node.parent_id as string | null) ?? null }; // legfelső szintűnél null
  });
}

// ---------- olvasás ----------

const brief = (r: NodeRow) => ({ id: r.id, content: r.content, type: r.type, ticket_no: r.ticket_no });

/**
 * A kezdőlap: a legfelső szintű (szülő nélküli) node-ok, a legújabb elöl. Az ember és a jegy
 * nem kerül ide, bár nekik sincs szülőjük: őket a keresőből és az említésekből érjük el.
 */
export async function getRoots(db: Db) {
  const { rows } = await db.query(
    `SELECT ${N_COLS} FROM nodes n
     WHERE n.deleted_at IS NULL AND n.type IS DISTINCT FROM 'person' AND n.type IS DISTINCT FROM 'ticket'
       AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target_id = n.id AND e.kind IN ('unsorted', 'belongs_to'))
     ORDER BY n.created_at DESC`,
  );
  return { roots: rows.map((r) => ({ ...brief(r), created_at: r.created_at as Date })) };
}

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

/** A bejegyzések alatt legfeljebb ennyi további szintet adunk vissza (többszintű nézet). */
export const MAX_DEPTH = 2;

/**
 * A középre állított node és minden, ami közvetlenül kapcsolódik hozzá. A `depth` (0..MAX_DEPTH)
 * a bejegyzések alatti további szintek száma: ezek a `deeper` node-ok és a `deeper_edges` kapcsolatok.
 */
export async function getNeighborhood(db: Db, id: string, depth = 0) {
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH) {
    throw new HttpError(400, `A mélység 0 és ${MAX_DEPTH} között lehet`);
  }
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

  // Az összes ős a gyökérig, mindegyik a saját szüleivel. A UNION a kört is lezárja.
  const ancestors = await db.query(
    `WITH RECURSIVE up(child_id, parent_id) AS (
       SELECT target_id, source_id FROM edges WHERE target_id = $1 AND kind IN ('unsorted', 'belongs_to')
       UNION
       SELECT e.target_id, e.source_id FROM edges e JOIN up ON e.target_id = up.parent_id
       WHERE e.kind IN ('unsorted', 'belongs_to')
     )
     SELECT ${N_COLS},
       coalesce((SELECT array_agg(u.parent_id ORDER BY p.created_at) FROM up u JOIN nodes p ON p.id = u.parent_id
                 WHERE u.child_id = n.id AND p.deleted_at IS NULL), '{}') AS parent_ids
     FROM nodes n WHERE n.id IN (SELECT parent_id FROM up) AND n.deleted_at IS NULL`,
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

  // Többszintű nézet: a bejegyzések gyerekei, azok gyerekei … a kért mélységig.
  const deeperEdges = depth
    ? (
        await db.query(
          `WITH RECURSIVE down(parent_id, child_id, level) AS (
             SELECT source_id, target_id, 1 FROM edges
             WHERE source_id = ANY($1::uuid[]) AND kind IN ('unsorted', 'belongs_to')
             UNION ALL
             SELECT e.source_id, e.target_id, d.level + 1 FROM edges e JOIN down d ON e.source_id = d.child_id
             WHERE e.kind IN ('unsorted', 'belongs_to') AND d.level < $2
           )
           SELECT DISTINCT d.parent_id, d.child_id FROM down d JOIN nodes c ON c.id = d.child_id
           WHERE c.deleted_at IS NULL`,
          [belowIds, depth],
        )
      ).rows
    : [];
  const deeperRows = (
    await db.query(`SELECT ${NODE_COLS} FROM nodes WHERE id = ANY($1::uuid[]) ORDER BY created_at`, [
      [...new Set(deeperEdges.map((e) => e.child_id))],
    ])
  ).rows as NodeRow[];
  const shownIds = [id, ...belowIds, ...deeperRows.map((r) => r.id)];

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
    [shownIds],
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
    [shownIds],
  );
  const deletable = await db.query(`SELECT n.id FROM nodes n WHERE n.id = ANY($1::uuid[]) AND ${DELETABLE}`, [
    shownIds,
  ]);
  const deletableIds = new Set(deletable.rows.map((r) => r.id));

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
    deletable: deletableIds.has(r.id),
  });

  return {
    center: detailed(center),
    parents: parents.rows.map(brief),
    ancestors: ancestors.rows.map((r) => ({ ...brief(r), parent_ids: r.parent_ids as string[] })),
    below: below.rows.map((r) => ({
      ...detailed(r),
      is_child: r.is_child as boolean,
      contexts: contexts.rows.filter((c) => c.target_id === r.id).map(brief),
    })),
    connected: connected.rows.map((r) => ({ ...brief(r), mentions: r.mentions as number, last_at: r.last_at as Date })),
    deeper: deeperRows.map(detailed),
    deeper_edges: deeperEdges.map((e) => ({ parent_id: e.parent_id as string, child_id: e.child_id as string })),
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
