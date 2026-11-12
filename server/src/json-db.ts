import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * JSON-fájl alapú adatbázis. Az egész adat a memóriában van, minden írás után a teljes fájl újraíródik
 * (előbb egy ideiglenes fájlba, aztán átnevezéssel, hogy félkész fájl ne maradjon). A Postgres-séma
 * szabályait és triggereit utánozza: alapértékek, korlátozások, verziószám, napló (change_log).
 * Egy szerverfolyamatra készült; ha a fájlt közben más írta (pl. a create-user), a következő
 * művelet előtt újraolvassa.
 */

export type Row = Record<string, unknown>;
export const TABLES = ['users', 'sessions', 'nodes', 'edges', 'node_dates', 'notes', 'change_log'] as const;
export type Table = (typeof TABLES)[number];

export const FORMAT = 1;

export interface FileData {
  format: number;
  next_log_id: number;
  next_tx_id: number;
  tables: Record<Table, Row[]>;
}

const KEY: Record<Table, string> = {
  users: 'id',
  sessions: 'token_hash',
  nodes: 'id',
  edges: 'id',
  node_dates: 'id',
  notes: 'id',
  change_log: 'id',
};

/** A naplózott táblák és a napló entity értéke. */
const LOGGED: Partial<Record<Table, string>> = { nodes: 'node', edges: 'edge', notes: 'note' };
/** Ezeknél a mentés növeli a verziót (bump_version). */
const VERSIONED = new Set<Table>(['nodes', 'notes']);

function defaults(table: Table, now: string): Row {
  switch (table) {
    case 'users':
      return { id: randomUUID(), created_at: now };
    case 'sessions':
      return { created_at: now };
    case 'nodes':
      return {
        id: randomUUID(),
        type: null,
        aliases: [],
        children_layout: 'auto',
        ticket_no: null,
        version: 1,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };
    case 'edges':
      return { id: randomUUID(), kind: 'unsorted', position: null, role: null, created_at: now };
    case 'node_dates':
      return { id: randomUUID(), meaning: 'unknown', confirmed: false };
    case 'notes':
      return { id: randomUUID(), visibility: 'public', version: 1, created_at: now, updated_at: now, deleted_at: null };
    case 'change_log':
      return {};
  }
}

const REQUIRED: Record<Table, string[]> = {
  users: ['email', 'display_name', 'password_hash'],
  sessions: ['token_hash', 'user_id', 'expires_at'],
  nodes: ['content', 'created_by', 'updated_by'],
  edges: ['source_id', 'target_id', 'created_by'],
  node_dates: ['node_id', 'starts_on', 'ends_on', 'source_text'],
  notes: ['node_id', 'content', 'created_by', 'updated_by'],
  change_log: [],
};

const ONE_OF: Partial<Record<Table, Record<string, readonly string[]>>> = {
  nodes: { children_layout: ['auto', 'group', 'tree', 'numbered'] },
  edges: { kind: ['unsorted', 'belongs_to', 'related', 'mention'] },
  node_dates: { meaning: ['unknown', 'due', 'absence'] },
  notes: { visibility: ['private', 'public'] },
};

/** Hivatkozások (idegen kulcsok): oszlop -> tábla. */
const REFS: Partial<Record<Table, Record<string, Table>>> = {
  sessions: { user_id: 'users' },
  nodes: { created_by: 'users', updated_by: 'users' },
  edges: { source_id: 'nodes', target_id: 'nodes', created_by: 'users' },
  node_dates: { node_id: 'nodes' },
  notes: { node_id: 'nodes', created_by: 'users', updated_by: 'users' },
};

export class ConstraintError extends Error {}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const without = (row: Row, ...keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

type Maps = Record<Table, Map<string, Row>>;

/** Egy írási művelet: a változások a végén együtt mentődnek, hibánál mind visszavonódnak. */
export class JsonTx {
  private saved = new Map<Table, Map<string, Row>>();

  constructor(
    private readonly maps: Maps,
    private readonly state: { next_log_id: number },
    /** A művelet ideje: egy műveleten belül minden sor ugyanazt kapja, mint a Postgres now()-ja. */
    readonly now: string,
    readonly txId: number,
    private readonly userId: string | null,
  ) {}

  /** A tábla sorai (élő nézet). A sorokat ne módosítsd közvetlenül, csak az update-tel. */
  rows(table: Table): IterableIterator<Row> {
    return this.maps[table].values();
  }

  get(table: Table, key: string): Row | undefined {
    return this.maps[table].get(key);
  }

  private touch(table: Table): Map<string, Row> {
    if (!this.saved.has(table)) this.saved.set(table, new Map(this.maps[table]));
    return this.maps[table];
  }

  /** Visszaállítja a művelet előtti állapotot. */
  rollback(): Map<Table, Map<string, Row>> {
    return this.saved;
  }

  insert(table: Table, values: Row): Row {
    if (table === 'change_log') throw new ConstraintError('a change_log nem módosítható');
    const row = { ...defaults(table, this.now), ...values };
    this.check(table, row);
    const key = String(row[KEY[table]]);
    if (this.maps[table].has(key)) throw new ConstraintError(`${table}: ismétlődő kulcs (unique)`);
    this.touch(table).set(key, row);
    this.log(table, 'create', null, row);
    return row;
  }

  update(table: Table, key: string, changes: Row): Row {
    if (table === 'change_log') throw new ConstraintError('a change_log nem módosítható');
    const old = this.maps[table].get(key);
    if (!old) throw new ConstraintError(`${table}: nincs ilyen sor`);
    let row: Row = { ...old, ...changes };
    if (VERSIONED.has(table)) {
      // bump_version: csak tényleges változásnál nő a verzió és a módosítás ideje.
      const meta = ['version', 'updated_at', 'updated_by'];
      row = same(without(row, ...meta), without(old, ...meta))
        ? old
        : { ...row, version: (old.version as number) + 1, updated_at: this.now };
    }
    if (same(row, old)) return old;
    this.check(table, row, key);
    this.touch(table).set(key, row);
    const entity = LOGGED[table];
    let action = 'update';
    if (entity && entity !== 'edge' && old.deleted_at == null && row.deleted_at != null) action = 'delete';
    if (entity && entity !== 'edge' && old.deleted_at != null && row.deleted_at == null) action = 'restore';
    this.log(table, action, old, row);
    return row;
  }

  remove(table: Table, key: string): void {
    if (table === 'change_log') throw new ConstraintError('a change_log nem módosítható');
    const old = this.maps[table].get(key);
    if (!old) return;
    // A rá hivatkozó sorok: a dátumok vele mennek (ON DELETE CASCADE, mint a munkamenetek), a többi tiltja.
    for (const [other, refs] of Object.entries(REFS) as [Table, Record<string, Table>][]) {
      for (const [col, target] of Object.entries(refs)) {
        if (target !== table) continue;
        for (const r of [...this.maps[other].values()]) {
          if (r[col] !== key) continue;
          if (other === 'node_dates' || other === 'sessions') this.remove(other, String(r[KEY[other]]));
          else throw new ConstraintError(`${table}: a sorra még hivatkozik egy ${other} sor (foreign key)`);
        }
      }
    }
    this.touch(table).delete(key);
    this.log(table, 'remove', old, null);
  }

  private check(table: Table, row: Row, oldKey?: string): void {
    for (const col of REQUIRED[table]) {
      if (row[col] == null) throw new ConstraintError(`${table}.${col} nem lehet üres (not null)`);
    }
    for (const [col, allowed] of Object.entries(ONE_OF[table] ?? {})) {
      if (!allowed.includes(row[col] as string)) throw new ConstraintError(`${table}.${col}: nem megengedett érték (check)`);
    }
    for (const [col, target] of Object.entries(REFS[table] ?? {})) {
      if (row[col] != null && !this.maps[target].has(String(row[col]))) {
        throw new ConstraintError(`${table}.${col}: nincs ilyen ${target} sor (foreign key)`);
      }
    }
    const others = () => [...this.maps[table].values()].filter((r) => r[KEY[table]] !== oldKey);
    if (table === 'users' && others().some((r) => r.email === row.email)) {
      throw new ConstraintError('users.email: már létezik (unique)');
    }
    if (table === 'nodes' && row.ticket_no != null && others().some((r) => r.ticket_no === row.ticket_no)) {
      throw new ConstraintError('nodes.ticket_no: már létezik (unique)');
    }
    if (table === 'edges') {
      if (row.source_id === row.target_id) throw new ConstraintError('edges: önmagára nem mutathat (check)');
      if (row.kind === 'related' && !((row.source_id as string) < (row.target_id as string))) {
        throw new ConstraintError('edges: a related kapcsolat iránya rendezett (check)');
      }
      const dup = others().some((r) => r.source_id === row.source_id && r.target_id === row.target_id && r.kind === row.kind);
      if (dup) throw new ConstraintError('edges: ez a kapcsolat már létezik (unique)');
    }
    if (table === 'node_dates' && (row.ends_on as string) < (row.starts_on as string)) {
      throw new ConstraintError('node_dates: a vége nem lehet a kezdete előtt (check)');
    }
  }

  private log(table: Table, action: string, old: Row | null, row: Row | null): void {
    const entity = LOGGED[table];
    if (!entity) return;
    const id = this.state.next_log_id++;
    this.touch('change_log').set(String(id), {
      id,
      entity,
      entity_id: (row ?? old)!.id,
      action,
      old_state: old,
      new_state: row,
      changed_by: this.userId,
      tx_id: this.txId,
      changed_at: this.now,
    });
  }
}

export class JsonDb {
  private maps = emptyMaps();
  private state = { next_log_id: 1, next_tx_id: 1 };
  private lastNow = 0;
  /** A fájl utoljára látott állapota; ha eltér, valaki más írta, újraolvassuk. */
  private seen = '';
  private saving: Promise<void> = Promise.resolve();

  private constructor(readonly file: string) {}

  static open(file: string): JsonDb {
    const db = new JsonDb(file);
    if (existsSync(file)) db.load();
    else db.persistNow();
    return db;
  }

  private stamp(): string {
    try {
      const s = statSync(this.file);
      return `${s.mtimeMs}|${s.size}`;
    } catch {
      return '';
    }
  }

  private load(): void {
    const data = JSON.parse(readFileSync(this.file, 'utf8')) as FileData;
    if (data.format !== FORMAT) throw new Error(`${this.file}: ismeretlen formátum (${data.format})`);
    const maps = emptyMaps();
    for (const t of TABLES) for (const r of data.tables[t] ?? []) maps[t].set(String(r[KEY[t]]), r);
    this.maps = maps;
    this.state = { next_log_id: data.next_log_id, next_tx_id: data.next_tx_id };
    this.seen = this.stamp();
  }

  private refresh(): void {
    if (this.stamp() !== this.seen) this.load();
  }

  private serialize(): string {
    const data: FileData = {
      format: FORMAT,
      ...this.state,
      tables: Object.fromEntries(TABLES.map((t) => [t, [...this.maps[t].values()]])) as FileData['tables'],
    };
    return JSON.stringify(data, null, 1);
  }

  private persistNow(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, this.serialize());
    renameSync(tmp, this.file);
    this.seen = this.stamp();
  }

  /** Olvasás: a függvény szinkron fut, így félkész írást nem láthat. */
  read<T>(fn: (tx: JsonTx) => T): T {
    this.refresh();
    return fn(new JsonTx(this.maps, this.state, this.nextNow(), 0, null));
  }

  /**
   * Írás egy műveletben: a függvény szinkron fut; ha hibát dob, minden változása visszavonódik.
   * Siker esetén a fájl mentése után tér vissza.
   */
  async write<T>(userId: string | null, fn: (tx: JsonTx) => T): Promise<T> {
    await this.saving; // az előző mentés (és az esetleges újraolvasás) után
    this.refresh();
    const state = { ...this.state };
    const tx = new JsonTx(this.maps, state, this.nextNow(), state.next_tx_id++, userId);
    let result: T;
    try {
      result = fn(tx);
    } catch (err) {
      for (const [table, map] of tx.rollback()) this.maps[table] = map;
      throw err;
    }
    this.state = state;
    const save = this.saving.then(() => this.persistNow());
    this.saving = save.catch(() => undefined);
    await save;
    return result;
  }

  /** Szigorúan növekvő időbélyeg, hogy két művelet sorrendje ne legyen döntetlen. */
  private nextNow(): string {
    const t = Math.max(Date.now(), this.lastNow + 1);
    this.lastNow = t;
    return new Date(t).toISOString();
  }

  async close(): Promise<void> {
    await this.saving;
  }
}

function emptyMaps(): Maps {
  return Object.fromEntries(TABLES.map((t) => [t, new Map<string, Row>()])) as Maps;
}
