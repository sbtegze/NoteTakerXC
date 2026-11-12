import pg from 'pg';

// A DATE oszlopokat szövegként (YYYY-MM-DD) kérjük, hogy ne csússzanak el időzóna miatt.
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createDb(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) throw new Error('A DATABASE_URL nincs beállítva');
  return new pg.Pool({ connectionString });
}

/**
 * Írási művelet tranzakcióban. Az app.user_id beállításból tudják a napló
 * triggerei, hogy ki módosított.
 */
export async function withUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK');
    throw err;
  } finally {
    tx.release();
  }
}
