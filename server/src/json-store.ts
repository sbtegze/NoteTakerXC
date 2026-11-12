import { randomBytes } from 'node:crypto';
import { DUMMY_HASH, hashPassword, hashToken, SESSION_DAYS, verifyPassword, type User } from './auth.js';
import { JsonDb, type JsonTx, type Row } from './json-db.js';
import {
  anchorDates,
  brief,
  checkType,
  contextFrom,
  HttpError,
  localDate,
  MAX_DEPTH,
  NODE_TYPES,
  noteWithSpans,
  parseCommand,
  spansOf,
  type CreateNodeInput,
  type LinkedSpan,
  type NodeRow,
  type NoteRow,
  type RecognitionContext,
  type UpdateNodeInput,
} from './nodes.js';
import type { Store } from './store.js';

// A nodes.ts és a notes.ts SQL-es függvényeinek megfelelője a JSON-motorhoz, ugyanazzal a viselkedéssel.

type Node = NodeRow & Row & { deleted_at: string | null; created_at: string; updated_at: string };
type Edge = Row & { id: string; source_id: string; target_id: string; kind: string };
type Note = NoteRow & Row & { deleted_at: string | null; created_at: string };
type NodeDate = Row & { node_id: string; starts_on: string; ends_on: string; source_text: string; confirmed: boolean };

const PARENT_KINDS = new Set(['unsorted', 'belongs_to']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hibás formátumú azonosító: a Postgres-motor is 400-at ad rá. */
function uuid(id: string): string {
  if (!UUID.test(id)) throw new HttpError(400, 'Érvénytelen azonosító');
  return id.toLowerCase();
}

const nodeCols = (n: Node): NodeRow => ({
  id: n.id,
  content: n.content,
  type: n.type,
  aliases: n.aliases,
  ticket_no: n.ticket_no,
  version: n.version,
  created_at: n.created_at,
  updated_at: n.updated_at,
});
const noteCols = (n: Note): NoteRow => ({
  id: n.id,
  node_id: n.node_id,
  content: n.content,
  version: n.version,
  created_at: n.created_at,
  updated_at: n.updated_at,
});
const byCreated = (a: { created_at: unknown }, b: { created_at: unknown }) =>
  String(a.created_at).localeCompare(String(b.created_at));

const nodes = (tx: JsonTx) => [...tx.rows('nodes')] as Node[];
const live = (tx: JsonTx) => nodes(tx).filter((n) => n.deleted_at === null);
const edges = (tx: JsonTx) => [...tx.rows('edges')] as Edge[];
const liveNode = (tx: JsonTx, id: string) => {
  const n = tx.get('nodes', id) as Node | undefined;
  return n && n.deleted_at === null ? n : undefined;
};

// ---------- felismerés ----------

function loadContext(tx: JsonTx): RecognitionContext {
  const all = live(tx);
  return contextFrom(
    all.filter((n) => n.type === 'person'),
    all.filter((n) => n.ticket_no !== null) as { id: string; ticket_no: number }[],
  );
}

function ticketNode(tx: JsonTx, userId: string, ticketNo: number, ctx: RecognitionContext): string {
  const known = ctx.tickets.get(ticketNo);
  if (known) return known;
  const row = tx.insert('nodes', {
    content: `#${ticketNo}`,
    type: 'ticket',
    ticket_no: ticketNo,
    created_by: userId,
    updated_by: userId,
  });
  ctx.tickets.set(ticketNo, row.id as string);
  return row.id as string;
}

/** Újraszámolja az említéseket és a dátumokat; a kézzel megerősített dátumokhoz nem nyúl. */
function applyRecognition(tx: JsonTx, userId: string, node: NodeRow, ctx: RecognitionContext): LinkedSpan[] {
  const spans = spansOf(node, ctx);
  const targets = new Set<string>();
  for (const s of spans) {
    if (s.kind === 'person' && s.personId) targets.add(s.personId);
    if (s.kind === 'ticket') {
      s.targetId = ticketNode(tx, userId, s.ticketNo, ctx);
      targets.add(s.targetId);
    }
  }
  targets.delete(node.id);

  const mentions = edges(tx).filter((e) => e.source_id === node.id && e.kind === 'mention');
  for (const e of mentions) if (!targets.has(e.target_id)) tx.remove('edges', e.id);
  for (const target of targets) {
    if (!mentions.some((e) => e.target_id === target)) {
      tx.insert('edges', { source_id: node.id, target_id: target, kind: 'mention', created_by: userId });
    }
  }

  const dates = ([...tx.rows('node_dates')] as NodeDate[]).filter((d) => d.node_id === node.id);
  const kept = new Set(dates.filter((d) => d.confirmed).map((d) => d.source_text));
  const wanted = spans.filter((s) => s.kind === 'date' && !kept.has(s.text));
  const current = dates.filter((d) => !d.confirmed);
  const key = (from: string, to: string, text: string) => `${from}|${to}|${text}`;
  const before = current.map((d) => key(d.starts_on, d.ends_on, d.source_text)).sort();
  const after = wanted.map((s) => (s.kind === 'date' ? key(s.from, s.to, s.text) : '')).sort();
  if (before.join('\n') !== after.join('\n')) {
    for (const d of current) tx.remove('node_dates', d.id as string);
    for (const s of wanted) {
      if (s.kind !== 'date') continue;
      tx.insert('node_dates', { node_id: node.id, starts_on: s.from, ends_on: s.to, source_text: s.text });
    }
  }
  return spans;
}

/** A @-tal említett, még nem létező emberek létrehozása; igazat ad, ha jött létre új. */
function createTaggedPeople(tx: JsonTx, userId: string, node: NodeRow, ctx: RecognitionContext): boolean {
  const created = new Set<string>();
  for (;;) {
    const names = spansOf(node, ctx).flatMap((s) => (s.kind === 'person' && s.newName ? [s.newName] : []));
    if (!names.length) return created.size > 0;
    const name = names.reduce((a, b) => (b.length < a.length ? b : a));
    if (created.has(name)) return true;
    const row = tx.insert('nodes', { content: name, type: 'person', created_by: userId, updated_by: userId });
    ctx.people.push({ id: row.id as string, names: [name] });
    created.add(name);
  }
}

function reindexAll(tx: JsonTx, userId: string): void {
  const ctx = loadContext(tx);
  for (const node of live(tx)) applyRecognition(tx, userId, node, ctx);
}

// ---------- írás ----------

function requireNode(tx: JsonTx, id: string): void {
  if (!liveNode(tx, uuid(id))) throw new HttpError(404, 'A node nem található');
}

function createNode(tx: JsonTx, userId: string, input: CreateNodeInput) {
  const trimmed = input.content?.trim();
  if (!trimmed) throw new HttpError(400, 'A szöveg nem lehet üres');
  checkType(input.type);
  const command = input.type === undefined ? parseCommand(trimmed) : null;
  const type = command?.type ?? input.type;
  const content = anchorDates(command?.content ?? trimmed, type, localDate());
  const contextId = command ? undefined : input.contextId;
  const parentId = input.parentId;
  if (parentId) requireNode(tx, parentId);
  if (contextId) requireNode(tx, contextId);

  if (command) {
    const [first = '', ...rest] = content.split('\n');
    const existing = live(tx)
      .filter((n) => n.type === type && (n.content.split('\n')[0] ?? '').toLowerCase() === first.toLowerCase())
      .sort(byCreated)[0];
    if (existing) return linkExisting(tx, userId, existing, parentId, rest.join('\n').trim());
  }
  return insertNode(tx, userId, content, type, input.aliases ?? [], [parentId, contextId]);
}

function insertNode(
  tx: JsonTx,
  userId: string,
  content: string,
  type: string | null | undefined,
  aliases: string[],
  parents: (string | undefined)[],
) {
  const node = nodeCols(
    tx.insert('nodes', { content, type: type ?? null, aliases, created_by: userId, updated_by: userId }) as Node,
  );
  for (const source of new Set(parents)) {
    if (!source) continue;
    tx.insert('edges', { source_id: source.toLowerCase(), target_id: node.id, kind: 'unsorted', created_by: userId });
  }
  const createdPeople = createTaggedPeople(tx, userId, node, loadContext(tx));
  if (node.type === 'person' || createdPeople) reindexAll(tx, userId);
  return { node, spans: applyRecognition(tx, userId, node, loadContext(tx)) };
}

/** A `parent` alá (bármilyen mélyen) tartozó node-ok, legfeljebb `maxLevel` szintig. */
function descendants(tx: JsonTx, roots: string[], maxLevel = Infinity): Map<string, number> {
  const all = edges(tx).filter((e) => PARENT_KINDS.has(e.kind));
  const found = new Map<string, number>();
  let frontier = new Set(roots);
  for (let level = 1; level <= maxLevel && frontier.size; level++) {
    const next = new Set<string>();
    for (const e of all) {
      if (!frontier.has(e.source_id) || found.has(e.target_id)) continue;
      found.set(e.target_id, level);
      next.add(e.target_id);
    }
    frontier = next;
  }
  return found;
}

const isBelow = (tx: JsonTx, root: string, node: string) => descendants(tx, [root]).has(node);

function linkExisting(tx: JsonTx, userId: string, existing: Node, parentId: string | undefined, body: string) {
  if (parentId) {
    const parent = parentId.toLowerCase();
    if (parent === existing.id || isBelow(tx, existing.id, parent)) {
      throw new HttpError(400, 'Ez az elem a saját alárendeltje alá nem linkelhető');
    }
    const linked = edges(tx).some((e) => e.source_id === parent && e.target_id === existing.id && PARENT_KINDS.has(e.kind));
    if (!linked) tx.insert('edges', { source_id: parent, target_id: existing.id, kind: 'unsorted', created_by: userId });
  }
  if (body) insertNode(tx, userId, body, null, [], [existing.id]);
  return { node: nodeCols(existing), spans: spansOf(existing, loadContext(tx)) };
}

function updateNode(tx: JsonTx, userId: string, rawId: string, input: UpdateNodeInput) {
  const content = input.content?.trim();
  if (input.content !== undefined && !content) throw new HttpError(400, 'A szöveg nem lehet üres');
  checkType(input.type);
  const before = liveNode(tx, uuid(rawId));
  if (!before) throw new HttpError(404, 'A node nem található');
  if (input.type === 'person' && before.type !== 'person') {
    throw new HttpError(400, 'Embert a szövegben @Név formában hozz létre');
  }
  const day = localDate(new Date(before.created_at));
  const command = content && input.type === undefined && before.type === null ? parseCommand(content, day) : null;
  const type = command ? command.type : input.type;
  const newContent = command?.content ?? content;
  const anchored = newContent ? anchorDates(newContent, type !== undefined ? type : before.type, day) : null;
  if (before.version !== input.version) throw new HttpError(409, 'A node közben megváltozott');
  const node = nodeCols(
    tx.update('nodes', before.id, {
      content: anchored ?? before.content,
      type: type !== undefined ? (type ?? null) : before.type,
      aliases: input.aliases ?? before.aliases,
      updated_by: userId,
    }) as Node,
  );
  const createdPeople = createTaggedPeople(tx, userId, node, loadContext(tx));
  if (node.type === 'person' || before.type === 'person' || createdPeople) reindexAll(tx, userId);
  return { node, spans: applyRecognition(tx, userId, node, loadContext(tx)) };
}

/** Törölhető: legfeljebb egy kapcsolata van, és az is a szülője felé mutat; nincs élő kommentje. */
function deletableIds(tx: JsonTx, ids: string[]): Set<string> {
  const all = edges(tx);
  const notes = [...tx.rows('notes')] as Note[];
  return new Set(
    ids.filter((id) => {
      const own = all.filter((e) => e.source_id === id || e.target_id === id);
      const edgesOk = own.length === 0 || (own.length === 1 && own[0]!.target_id === id && PARENT_KINDS.has(own[0]!.kind));
      return edgesOk && !notes.some((c) => c.node_id === id && c.deleted_at === null);
    }),
  );
}

function deleteNode(tx: JsonTx, userId: string, rawId: string, version: unknown) {
  if (!Number.isInteger(version)) throw new HttpError(400, 'A verzió kötelező');
  const node = liveNode(tx, uuid(rawId));
  if (!node) throw new HttpError(404, 'A node nem található');
  if (node.version !== version) throw new HttpError(409, 'A node közben megváltozott');
  if (!deletableIds(tx, [node.id]).has(node.id)) {
    throw new HttpError(409, 'Csak az a node törölhető, amelynek csak a szülője felé van kapcsolata, és nincs kommentje');
  }
  const parentId = edges(tx).find((e) => e.target_id === node.id)?.source_id ?? null;
  for (const n of [...tx.rows('notes')] as Note[]) if (n.node_id === node.id) tx.remove('notes', n.id);
  for (const e of edges(tx)) if (e.target_id === node.id) tx.remove('edges', e.id);
  tx.remove('nodes', node.id); // a dátumok vele mennek
  if (node.type === 'person') reindexAll(tx, userId);
  return { parentId };
}

function moveNode(tx: JsonTx, userId: string, rawId: string, from: unknown, to: unknown) {
  if (typeof from !== 'string' || typeof to !== 'string') throw new HttpError(400, 'A honnan és a hová kötelező');
  const [id, source, target] = [uuid(rawId), uuid(from), uuid(to)];
  requireNode(tx, id);
  requireNode(tx, target);
  if (target === id) throw new HttpError(400, 'Önmaga alá nem helyezhető');
  if (isBelow(tx, id, target)) throw new HttpError(400, 'A saját alárendeltje alá nem helyezhető');
  const old = edges(tx).filter((e) => e.source_id === source && e.target_id === id && PARENT_KINDS.has(e.kind));
  if (!old.length) throw new HttpError(409, 'Közben megváltozott: már nem ennek a node-nak az alatt van');
  for (const e of old) tx.remove('edges', e.id);
  const linked = edges(tx).some((e) => e.source_id === target && e.target_id === id && PARENT_KINDS.has(e.kind));
  if (!linked) tx.insert('edges', { source_id: target, target_id: id, kind: 'belongs_to', created_by: userId });
  return { ok: true };
}

// ---------- olvasás ----------

function listByType(tx: JsonTx, type: unknown) {
  if (typeof type !== 'string' || !(NODE_TYPES as readonly string[]).includes(type)) {
    throw new HttpError(400, 'Ismeretlen típus');
  }
  const rows = live(tx)
    .filter((n) => n.type === type)
    .sort((a, b) => {
      if (a.ticket_no !== b.ticket_no) {
        if (a.ticket_no === null) return 1;
        if (b.ticket_no === null) return -1;
        return a.ticket_no - b.ticket_no;
      }
      return -byCreated(a, b);
    });
  const list = rows.map((r) => ({ ...brief(r), created_at: r.created_at }));
  if (type === 'person') list.sort((a, b) => a.content.localeCompare(b.content, 'hu'));
  return { nodes: list };
}

function getRoots(tx: JsonTx) {
  const hasParent = new Set(edges(tx).filter((e) => PARENT_KINDS.has(e.kind)).map((e) => e.target_id));
  const roots = live(tx)
    .filter((n) => n.type !== 'person' && n.type !== 'ticket' && !hasParent.has(n.id))
    .sort((a, b) => -byCreated(a, b));
  return { roots: roots.map((r) => ({ ...brief(r), created_at: r.created_at })) };
}

function getNeighborhood(tx: JsonTx, rawId: string, depth = 0) {
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH) {
    throw new HttpError(400, `A mélység 0 és ${MAX_DEPTH} között lehet`);
  }
  const id = uuid(rawId);
  const center = liveNode(tx, id);
  if (!center) throw new HttpError(404, 'A node nem található');
  const ctx = loadContext(tx);
  const allEdges = edges(tx);
  const parentEdges = allEdges.filter((e) => PARENT_KINDS.has(e.kind));
  const get = (nid: string) => tx.get('nodes', nid) as Node | undefined;
  const isLive = (nid: string) => get(nid)?.deleted_at === null;

  // Ide tartozik: a node szülei.
  const parents = parentEdges
    .filter((e) => e.target_id === id && isLive(e.source_id))
    .map((e) => get(e.source_id)!)
    .sort(byCreated);

  // Alatta lévő node-ok és minden bejegyzés, ami említi – időrendben, egyszer.
  const belowMap = new Map<string, { node: Node; is_child: boolean; is_mention: boolean }>();
  for (const e of allEdges) {
    let nid: string | undefined;
    if (e.source_id === id && e.target_id !== id && PARENT_KINDS.has(e.kind)) nid = e.target_id;
    else if (e.target_id === id && e.kind === 'mention') nid = e.source_id;
    if (!nid || !isLive(nid)) continue;
    const b = belowMap.get(nid) ?? { node: get(nid)!, is_child: false, is_mention: false };
    b.is_child ||= e.source_id === id;
    b.is_mention ||= e.kind === 'mention';
    belowMap.set(nid, b);
  }
  const below = [...belowMap.values()].sort((a, b) => byCreated(a.node, b.node));
  const belowIds = below.map((b) => b.node.id);
  const mentionIds = below.filter((b) => b.is_mention && !b.is_child).map((b) => b.node.id);

  // Az összes ős a gyökérig, mindegyik a saját szüleivel; a látogatott halmaz a kört is lezárja.
  const up = new Map<string, Set<string>>(); // gyerek -> szülők
  const queue = [id, ...mentionIds];
  const visited = new Set(queue);
  while (queue.length) {
    const child = queue.shift()!;
    for (const e of parentEdges) {
      if (e.target_id !== child) continue;
      if (!up.has(child)) up.set(child, new Set());
      up.get(child)!.add(e.source_id);
      if (!visited.has(e.source_id)) {
        visited.add(e.source_id);
        queue.push(e.source_id);
      }
    }
  }
  const ancestorIds = new Set([...up.values()].flatMap((s) => [...s]));
  const ancestors = [...ancestorIds]
    .filter(isLive)
    .map((aid) => get(aid)!)
    .sort(byCreated)
    .map((n) => ({
      node: n,
      parent_ids: [...(up.get(n.id) ?? [])].filter(isLive).map((p) => get(p)!).sort(byCreated).map((p) => p.id),
    }));

  // Az említő bejegyzések szülei: innen indul az „Említve itt” fa.
  const mentionSet = new Set(mentionIds);
  const mentionParentIds = [
    ...new Set(
      parentEdges
        .filter((e) => mentionSet.has(e.target_id) && e.source_id !== id && isLive(e.source_id))
        .map((e) => get(e.source_id)!)
        .sort(byCreated)
        .map((n) => n.id),
    ),
  ];

  // Többszintű nézet: a bejegyzések gyerekei, azok gyerekei … a kért mélységig.
  const deeperEdges: { parent_id: string; child_id: string }[] = [];
  if (depth) {
    const pairs = new Set<string>();
    let frontier = new Set(belowIds);
    for (let level = 1; level <= depth && frontier.size; level++) {
      const next = new Set<string>();
      for (const e of parentEdges) {
        if (!frontier.has(e.source_id)) continue;
        next.add(e.target_id);
        const key = `${e.source_id}|${e.target_id}`;
        if (isLive(e.target_id) && !pairs.has(key)) {
          pairs.add(key);
          deeperEdges.push({ parent_id: e.source_id, child_id: e.target_id });
        }
      }
      frontier = next;
    }
  }
  const deeperRows = [...new Set(deeperEdges.map((e) => e.child_id))].map((cid) => get(cid)!).sort(byCreated);
  const shownIds = new Set([id, ...belowIds, ...deeperRows.map((r) => r.id)]);

  // Hol hangzott el: a bejegyzések többi szülője (pl. a meeting).
  const belowSet = new Set(belowIds);
  const contexts = parentEdges
    .filter((e) => belowSet.has(e.target_id) && e.source_id !== id && isLive(e.source_id))
    .map((e) => ({ target_id: e.target_id, node: get(e.source_id)! }))
    .sort((a, b) => byCreated(a.node, b.node));
  const dates = ([...tx.rows('node_dates')] as NodeDate[])
    .filter((d) => shownIds.has(d.node_id))
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on));

  // A node alatti fa, legfeljebb 1 + MAX_DEPTH szintig: a „Kapcsolódik” ebből is gyűjt.
  const subtree = [...descendants(tx, [id], 1 + MAX_DEPTH).keys()]
    .filter(isLive)
    .map((sid) => get(sid)!)
    .sort((a, b) => -byCreated(a, b));
  // Kapcsolódik: akiket és amiket a node, a bejegyzései, az alattuk és a felettük lévők említenek …
  const sources = new Set([id, ...belowIds, ...subtree.map((r) => r.id), ...ancestors.map((a) => a.node.id)]);
  const connectedMap = new Map<string, { node: Node; mentions: number; last_at: string }>();
  for (const m of allEdges) {
    if (m.kind !== 'mention' || !sources.has(m.source_id) || m.target_id === id || !isLive(m.target_id)) continue;
    const src = get(m.source_id);
    if (!src) continue;
    const c = connectedMap.get(m.target_id) ?? { node: get(m.target_id)!, mentions: 0, last_at: '' };
    c.mentions++;
    if (src.created_at > c.last_at) c.last_at = src.created_at;
    connectedMap.set(m.target_id, c);
  }
  const connected = [...connectedMap.values()].sort((a, b) => b.last_at.localeCompare(a.last_at));
  // … és az alatta és felette lévő meetingek és témák.
  const typedBelow = [...subtree, ...ancestors.map((a) => a.node)].filter(
    (r, i, all) => (r.type === 'meeting' || r.type === 'topic') && r.id !== id && all.findIndex((x) => x.id === r.id) === i,
  );
  const notes = ([...tx.rows('notes')] as Note[])
    .filter((n) => shownIds.has(n.node_id) && n.deleted_at === null)
    .sort(byCreated);
  const deletable = deletableIds(tx, [...shownIds]);

  const detailed = (r: Node) => ({
    ...brief(r),
    version: r.version,
    aliases: r.aliases,
    created_at: r.created_at,
    spans: spansOf(r, ctx),
    dates: dates
      .filter((d) => d.node_id === r.id)
      .map((d) => ({
        starts_on: d.starts_on,
        ends_on: d.ends_on,
        meaning: d.meaning,
        source_text: d.source_text,
        confirmed: d.confirmed,
      })),
    notes: notes.filter((n) => n.node_id === r.id).map((n) => noteWithSpans(noteCols(n), ctx)),
    deletable: deletable.has(r.id),
  });

  return {
    center: detailed(center),
    parents: parents.map(brief),
    ancestors: ancestors.map((a) => ({ ...brief(a.node), created_at: a.node.created_at, parent_ids: a.parent_ids })),
    mention_parent_ids: mentionParentIds,
    below: below.map((b) => ({
      ...detailed(b.node),
      is_child: b.is_child,
      contexts: contexts.filter((c) => c.target_id === b.node.id).map((c) => brief(c.node)),
    })),
    connected: [
      ...connected.map((c) => ({ ...brief(c.node), mentions: c.mentions, last_at: c.last_at })),
      ...typedBelow
        .filter((r) => !connectedMap.has(r.id))
        .map((r) => ({ ...brief(r), mentions: 0, last_at: r.created_at })),
    ],
    deeper: deeperRows.map(detailed),
    deeper_edges: deeperEdges,
  };
}

/**
 * Keresés: szövegrészre, kis- és nagybetűtől függetlenül. A Postgres magyar szótövezését egyszerű
 * csonkolás közelíti: a szavak elejéről-végéről az írásjel (@, #, vessző) lemarad, a betűs szavak
 * végéről legfeljebb három betű (rag) elhagyható, de négy mindig marad. A számot tartalmazó szó egészben számít.
 */
function searchNodes(tx: JsonTx, query: string) {
  // Ékezet nélkül hasonlítunk: a ragozás a tő végét megnyújthatja (Kinga -> Kingával).
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const q = fold(query.trim());
  if (!q) return [];
  const stems = q
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean)
    .map((w) => (/\d/.test(w) || w.length <= 4 ? w : w.slice(0, Math.max(4, w.length - 3))));
  if (!stems.length) stems.push(q);
  return live(tx)
    .map((n) => ({ n, text: fold(n.content) }))
    .filter(({ text }) => text.includes(q) || stems.every((s) => text.includes(s)))
    .sort(
      (a, b) =>
        Number(b.n.type !== null) - Number(a.n.type !== null) ||
        Number(b.text.startsWith(q)) - Number(a.text.startsWith(q)) ||
        b.n.updated_at.localeCompare(a.n.updated_at),
    )
    .slice(0, 20)
    .map(({ n }) => brief(n));
}

// ---------- kommentek ----------

function cleanContent(content: unknown): string {
  if (typeof content !== 'string' || !content.trim()) throw new HttpError(400, 'A komment nem lehet üres');
  return content.trim();
}

function liveNote(tx: JsonTx, id: string, version: unknown): Note {
  const note = tx.get('notes', uuid(id)) as Note | undefined;
  if (!note || note.deleted_at !== null) throw new HttpError(404, 'A komment nem található');
  if (note.version !== version) throw new HttpError(409, 'A komment közben megváltozott');
  return note;
}

// ---------- felhasználók ----------

const userCols = (u: Row): User => ({ id: u.id as string, email: u.email as string, display_name: u.display_name as string });

export function openJsonStore(file: string): Store & { db: JsonDb } {
  const db = JsonDb.open(file);
  const write = <T>(userId: string | null, fn: (tx: JsonTx) => T) => db.write(userId, fn);
  const read = <T>(fn: (tx: JsonTx) => T) => Promise.resolve().then(() => db.read(fn));

  return {
    engine: 'json',
    db,

    async createUser(email, displayName, password) {
      if (password.length < 10) throw new Error('A jelszó legalább 10 karakter legyen');
      const hash = await hashPassword(password);
      return write(null, (tx) => {
        const mail = email.toLowerCase();
        const old = [...tx.rows('users')].find((u) => u.email === mail);
        const row = old
          ? tx.update('users', old.id as string, { display_name: displayName, password_hash: hash })
          : tx.insert('users', { email: mail, display_name: displayName, password_hash: hash });
        return userCols(row);
      });
    },

    async login(email, password) {
      const row = db.read((tx) => [...tx.rows('users')].find((u) => u.email === email.toLowerCase()));
      const ok = await verifyPassword(password, (row?.password_hash as string | undefined) ?? DUMMY_HASH);
      if (!row || !ok) return null;
      const token = randomBytes(32).toString('base64url');
      await write(null, (tx) =>
        tx.insert('sessions', {
          token_hash: hashToken(token),
          user_id: row.id,
          expires_at: new Date(Date.parse(tx.now) + SESSION_DAYS * 86_400_000).toISOString(),
        }),
      );
      return { token, user: userCols(row) };
    },

    userForToken: (token) =>
      read((tx) => {
        if (!token) return null;
        const s = tx.get('sessions', hashToken(token));
        if (!s || (s.expires_at as string) <= tx.now) return null;
        const u = tx.get('users', s.user_id as string);
        return u ? userCols(u) : null;
      }),

    async logout(token) {
      if (token) await write(null, (tx) => tx.remove('sessions', hashToken(token)));
    },

    createNode: (userId, input) => write(userId, (tx) => createNode(tx, userId, input)),
    updateNode: (userId, id, input) => write(userId, (tx) => updateNode(tx, userId, id, input)),
    deleteNode: (userId, id, version) => write(userId, (tx) => deleteNode(tx, userId, id, version)),
    moveNode: (userId, id, from, to) => write(userId, (tx) => moveNode(tx, userId, id, from, to)),
    listByType: (type) => read((tx) => listByType(tx, type)),
    getRoots: () => read(getRoots),
    getNeighborhood: (id, depth) => read((tx) => getNeighborhood(tx, id, depth)),
    searchNodes: (query) => read((tx) => searchNodes(tx, query)),

    createNote: (userId, nodeId, content) => {
      const text = cleanContent(content);
      return write(userId, (tx) => {
        requireNode(tx, nodeId);
        const row = tx.insert('notes', { node_id: nodeId.toLowerCase(), content: text, created_by: userId, updated_by: userId });
        return { note: noteWithSpans(noteCols(row as Note), loadContext(tx)) };
      });
    },
    updateNote: (userId, id, content, version) => {
      const text = cleanContent(content);
      if (!Number.isInteger(version)) throw new HttpError(400, 'A verzió kötelező');
      return write(userId, (tx) => {
        const note = liveNote(tx, id, version);
        const row = tx.update('notes', note.id, { content: text, updated_by: userId });
        return { note: noteWithSpans(noteCols(row as Note), loadContext(tx)) };
      });
    },
    deleteNote: (userId, id, version) => {
      if (!Number.isInteger(version)) throw new HttpError(400, 'A verzió kötelező');
      return write(userId, (tx) => {
        const note = liveNote(tx, id, version);
        tx.update('notes', note.id, { deleted_at: tx.now, updated_by: userId });
        return { ok: true as const };
      });
    },

    close: () => db.close(),
  };
}
