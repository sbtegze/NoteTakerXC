import { withUser, type Db } from './db.js';
import { HttpError, loadContext, NOTE_COLS, noteWithSpans as withSpans, requireNode } from './nodes.js';

// Komment: pontosan egy node-hoz tartozik. A felismerés csak kiemel, kapcsolatot nem hoz létre.

function cleanContent(content: unknown): string {
  if (typeof content !== 'string' || !content.trim()) throw new HttpError(400, 'A komment nem lehet üres');
  return content.trim();
}

export function createNote(db: Db, userId: string, nodeId: string, content: unknown) {
  const text = cleanContent(content);
  return withUser(db, userId, async (tx) => {
    await requireNode(tx, nodeId);
    const { rows } = await tx.query(
      `INSERT INTO notes (node_id, content, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING ${NOTE_COLS}`,
      [nodeId, text, userId],
    );
    return { note: withSpans(rows[0], await loadContext(tx)) };
  });
}

export function updateNote(db: Db, userId: string, id: string, content: unknown, version: unknown) {
  const text = cleanContent(content);
  if (!Number.isInteger(version)) throw new HttpError(400, 'A verzió kötelező');
  return withUser(db, userId, async (tx) => {
    const { rows } = await tx.query(
      `UPDATE notes SET content = $1, updated_by = $2
       WHERE id = $3 AND version = $4 AND deleted_at IS NULL RETURNING ${NOTE_COLS}`,
      [text, userId, id, version],
    );
    if (!rows[0]) await conflictOrMissing(tx, id);
    return { note: withSpans(rows[0], await loadContext(tx)) };
  });
}

/** Törlés: a sor megmarad (deleted_at), a napló „delete” bejegyzést kap. */
export function deleteNote(db: Db, userId: string, id: string, version: unknown) {
  if (!Number.isInteger(version)) throw new HttpError(400, 'A verzió kötelező');
  return withUser(db, userId, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE notes SET deleted_at = now(), updated_by = $1 WHERE id = $2 AND version = $3 AND deleted_at IS NULL`,
      [userId, id, version],
    );
    if (!rowCount) await conflictOrMissing(tx, id);
    return { ok: true };
  });
}

async function conflictOrMissing(tx: Pick<Db, 'query'>, id: string): Promise<never> {
  const { rowCount } = await tx.query('SELECT 1 FROM notes WHERE id = $1 AND deleted_at IS NULL', [id]);
  throw rowCount ? new HttpError(409, 'A komment közben megváltozott') : new HttpError(404, 'A komment nem található');
}
