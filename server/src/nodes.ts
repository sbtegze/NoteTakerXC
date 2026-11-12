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

const NODE_COLS = 'id, content, type, aliases, ticket_no, is_inbox, version, created_at, updated_at';
const TIMEZONE = process.env.APP_TIMEZONE ?? 'Europe/Budapest';

/** A naptári nap (YYYY-MM-DD) az alkalmazás időzónájában. */
export function localDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(at);
}

export async function ensureInbox(tx: Tx, userId: string): Promise<string> {
  const existing = await tx.query('SELECT id FROM nodes WHERE is_inbox');
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await tx.query(
    `INSERT INTO nodes (content, is_inbox, created_by, updated_by) VALUES ('Bejövő', true, $1, $1) RETURNING id`,
    [userId],
  );
  return rows[0].id;
}

async function loadPeople(tx: Tx): Promise<Person[]> {
  const { rows } = await tx.query(`SELECT id, content, aliases FROM nodes WHERE type = 'person' AND deleted_at IS NULL`);
  return rows.map((r) => ({
    id: r.id,
    // A node első sorának szavai és a becenevek: "Kovács István" -> Kovács, István
    names: [...(r.content.split('\n')[0] ?? '').split(/\s+/), ...r.aliases].filter((n: string) => n.length >= 2),
  }));
}

async function ticketNode(tx: Tx, userId: string, ticketNo: number): Promise<string> {
  const existing = await tx.query('SELECT id FROM nodes WHERE ticket_no = $1', [ticketNo]);
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await tx.query(
    `INSERT INTO nodes (content, type, ticket_no, created_by, updated_by) VALUES ($1, 'ticket', $2, $3, $3) RETURNING id`,
    [`#${ticketNo}`, ticketNo, userId],
  );
  return rows[0].id;
}

/**
 * Újraszámolja a node szövegéből származtatott adatokat: az említéseket
 * (mention kapcsolatok) és a dátumokat. A kézzel megerősített dátumokhoz nem nyúl.
 */
async function applyRecognition(tx: Tx, userId: string, node: NodeRow): Promise<Span[]> {
  const known = await tx.query('SELECT ticket_no FROM nodes WHERE ticket_no IS NOT NULL AND deleted_at IS NULL');
  const spans = recognize(node.content, {
    today: localDate(node.created_at), // a relatív dátumok a rögzítés napjához képest értendők
    people: await loadPeople(tx),
    knownTickets: new Set(known.rows.map((r) => r.ticket_no)),
  });

  const targets = new Set<string>();
  for (const s of spans) {
    if (s.kind === 'person') targets.add(s.personId);
    if (s.kind === 'ticket') targets.add(await ticketNode(tx, userId, s.ticketNo));
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

  await tx.query('DELETE FROM node_dates WHERE node_id = $1 AND NOT confirmed', [node.id]);
  const confirmed = await tx.query('SELECT source_text FROM node_dates WHERE node_id = $1', [node.id]);
  const kept = new Set(confirmed.rows.map((r) => r.source_text));
  for (const s of spans) {
    if (s.kind !== 'date' || kept.has(s.text)) continue;
    await tx.query('INSERT INTO node_dates (node_id, starts_on, ends_on, source_text) VALUES ($1, $2, $3, $4)', [
      node.id,
      s.from,
      s.to,
      s.text,
    ]);
  }
  return spans;
}

export interface CreateNodeInput {
  content: string;
  /** A kiválasztott node, amihez az új tartozik; ha nincs, a Bejövő. */
  parentId?: string;
  /** Második szülő, pl. a nyitott meeting. */
  contextId?: string;
  type?: string;
  aliases?: string[];
}

async function requireNode(tx: Tx, id: string): Promise<void> {
  const { rowCount } = await tx.query('SELECT 1 FROM nodes WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!rowCount) throw new HttpError(404, 'A node nem található');
}

export function createNode(db: Db, userId: string, input: CreateNodeInput) {
  const content = input.content?.trim();
  if (!content) throw new HttpError(400, 'A szöveg nem lehet üres');
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
    return { node, spans: await applyRecognition(tx, userId, node) };
  });
}

export function updateNode(db: Db, userId: string, id: string, input: { content: string; version: number }) {
  const content = input.content?.trim();
  if (!content) throw new HttpError(400, 'A szöveg nem lehet üres');
  return withUser(db, userId, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE nodes SET content = $1, updated_by = $2
       WHERE id = $3 AND version = $4 AND deleted_at IS NULL RETURNING ${NODE_COLS}`,
      [content, userId, id, input.version],
    );
    const node: NodeRow | undefined = rows[0];
    if (!node) {
      await requireNode(tx, id);
      throw new HttpError(409, 'A node közben megváltozott');
    }
    return { node, spans: await applyRecognition(tx, userId, node) };
  });
}
