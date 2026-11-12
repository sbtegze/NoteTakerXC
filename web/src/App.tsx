import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, ApiError, title, type Brief, type Detailed, type Entry, type Note, type NodeType, type Span, type User, type View } from './api';

interface Crumb {
  id: string;
  title: string;
}

const TYPE_LABEL: Record<NodeType, string> = { person: 'Ember', ticket: 'Jegy', meeting: 'Meeting', topic: 'Téma' };
const GROUPS: [NodeType | null, string][] = [
  ['person', 'Emberek'],
  ['ticket', 'Jegyek'],
  ['meeting', 'Meetingek'],
  ['topic', 'Témák'],
  [null, 'Egyéb'],
];

// A böngésző megjegyzi az útvonalat és a nyitott meetinget; ha nem tudja, anélkül is működik.
function load<T>(storage: () => Storage, key: string, fallback: T): T {
  try {
    const raw = storage().getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(storage: () => Storage, key: string, value: unknown) {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, JSON.stringify(value));
  } catch {
    /* privát ablakban a tárolás tiltva lehet */
  }
}

// Az URL a középen álló node-ot adja meg (/n/<azonosító>); az útvonalat a böngésző előzményei őrzik,
// így a vissza/előre gomb és az újratöltés is ugyanoda visz.
const urlFor = (path: Crumb[]) => (path.length ? `/n/${path.at(-1)!.id}` : '/');
const idFromUrl = () => /^\/n\/([^/]+)$/.exec(location.pathname)?.[1];
function pathFromHistory(): Crumb[] {
  const id = idFromUrl();
  const saved = (history.state as { path?: Crumb[] } | null)?.path;
  if (saved && saved.at(-1)?.id === id) return saved;
  return id ? [{ id, title: '' }] : []; // a nevet a betöltés pótolja
}

const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('hu-HU', { month: 'short', day: 'numeric', weekday: 'short' });
const fmtRange = (from: string, to: string) => (from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`);
const fmtStamp = (iso: string) =>
  new Date(iso).toLocaleString('hu-HU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return <p className="status">Betöltés…</p>;
  if (user === null) return <Login onLogin={setUser} />;
  return <Workspace user={user} onLogout={() => setUser(null)} />;
}

function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin((await api.login(email, password)).user);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Túl sok próbálkozás, várj egy percet.' : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="login" onSubmit={submit}>
      <h1>NoteTakerXC</h1>
      <label>
        E-mail
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required autoComplete="username" />
      </label>
      <label>
        Jelszó
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
      </label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>Belépés</button>
    </form>
  );
}

function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [path, setPath] = useState<Crumb[]>(pathFromHistory);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [context, setContext] = useState<Crumb | null>(() => load(() => localStorage, 'context', null));
  const currentId = path.at(-1)?.id;
  const captureRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => save(() => localStorage, 'context', context), [context]);

  // Az aktuális előzménybejegyzés mindig a friss útvonalat tárolja (pl. átnevezés vagy törölt node után).
  useEffect(() => {
    history.replaceState({ path }, '', urlFor(path));
    const name = path.at(-1)?.title;
    document.title = name ? `${name} – NoteTakerXC` : 'NoteTakerXC';
  }, [path]);

  useEffect(() => {
    const onPop = () => setPath(pathFromHistory());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) onLogout();
      else setError((err as Error).message);
    },
    [onLogout],
  );

  /** Középre állítás: ha a node már szerepel az útvonalon, oda lépünk vissza. Új előzménybejegyzést kap. */
  const go = useCallback(
    (node: { id: string; content: string }) => {
      if (node.id === path.at(-1)?.id) return;
      const at = path.findIndex((c) => c.id === node.id);
      const next = at >= 0 ? path.slice(0, at + 1) : [...path, { id: node.id, title: title(node) }];
      history.pushState({ path: next }, '', urlFor(next));
      setPath(next);
    },
    [path],
  );

  const reload = useCallback(
    async (id: string) => {
      try {
        const next = await api.view(id);
        setView(next);
        setError('');
        // Átnevezés után az útvonalon is az új név álljon.
        setPath((p) => p.map((c) => (c.id === id && c.title !== title(next.center) ? { ...c, title: title(next.center) } : c)));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) setPath((p) => p.filter((c) => c.id !== id));
        else fail(err);
      }
    },
    [fail],
  );

  useEffect(() => {
    if (currentId) {
      void reload(currentId);
    } else {
      api
        .home()
        .then(({ id }) => setPath([{ id, title: 'Bejövő' }]))
        .catch(fail);
    }
  }, [currentId, reload, fail]);

  useEffect(() => {
    // Középre állítás után rögtön lehet írni – de ha a felhasználó épp máshol gépel (pl. a keresőben), nem vesszük el a fókuszt.
    const busyElsewhere = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '');
    if (view?.center.id === currentId && !busyElsewhere) captureRef.current?.focus();
  }, [view?.center.id, currentId]);

  const capture = async (content: string) => {
    if (!currentId) return;
    await api.create({ content, parentId: currentId, contextId: context && context.id !== currentId ? context.id : undefined });
    await reload(currentId);
  };

  const ready = view && view.center.id === currentId;

  return (
    <div className="app">
      <header className="topbar">
        <nav className="path" aria-label="Útvonal">
          {path.map((c, i) => (
            <span key={c.id}>
              {i > 0 && <span className="sep">›</span>}
              <button className={i === path.length - 1 ? 'crumb current' : 'crumb'} onClick={() => go({ id: c.id, content: c.title })}>
                {c.title}
              </button>
            </span>
          ))}
        </nav>
        <Search onPick={go} onError={fail} />
        <span className="user">
          {user.display_name}
          <button
            className="link"
            onClick={() => {
              void api.logout().finally(onLogout);
            }}
          >
            Kilépés
          </button>
        </span>
      </header>

      {context && (
        <div className="context-bar">
          Nyitott meeting: <button className="link" onClick={() => go({ id: context.id, content: context.title })}>{context.title}</button>
          <span className="hint">minden új bejegyzés ehhez is kapcsolódik</span>
          <button className="link" onClick={() => setContext(null)}>
            Lezárás
          </button>
        </div>
      )}
      {error && <p className="error banner">{error}</p>}

      {ready ? (
        <main className="map" key={view.center.id}>
          <aside className="side">
            <h2>Ide tartozik</h2>
            {view.parents.length ? <Ancestors view={view} onPick={go} /> : <p className="empty">Nincs szülője</p>}
          </aside>

          <section className="middle">
            <Center
              node={view.center}
              isContext={context?.id === view.center.id}
              onToggleContext={() =>
                setContext(context?.id === view.center.id ? null : { id: view.center.id, title: title(view.center) })
              }
              onChanged={() => reload(view.center.id)}
              onError={fail}
              onPick={go}
              onDeleted={(parentId) => {
                // A törölt node kikerül az útvonalból, a szülője áll középre.
                const parent = view.parents.find((p) => p.id === parentId);
                setPath((p) => {
                  const rest = p.filter((c) => c.id !== view.center.id);
                  if (!parent || rest.at(-1)?.id === parentId) return rest;
                  return [...rest, { id: parent.id, title: title(parent) }];
                });
              }}
              nodes={[...view.connected, ...view.parents]}
            />
            <Capture inputRef={captureRef} onSave={capture} onError={fail} target={title(view.center)} />
            <Below view={view} onPick={go} onChanged={() => reload(view.center.id)} onError={fail} />
          </section>

          <aside className="side">
            <h2>Kapcsolódik</h2>
            {view.connected.length === 0 && <p className="empty">Még semmi</p>}
            {GROUPS.map(([type, label]) => {
              const nodes = view.connected.filter((n) => n.type === type);
              return nodes.length ? (
                <div key={label} className="group">
                  <h3>{label}</h3>
                  <Chips nodes={nodes} onPick={go} counts />
                </div>
              ) : null;
            })}
          </aside>
        </main>
      ) : (
        !error && <p className="status">Betöltés…</p>
      )}
    </div>
  );
}

function Chips({ nodes, onPick, counts }: { nodes: (Brief & { mentions?: number })[]; onPick: (n: Brief) => void; counts?: boolean }) {
  return (
    <ul className="chips">
      {nodes.map((n) => (
        <li key={n.id}>
          <button className={`chip type-${n.type ?? 'none'}`} onClick={() => onPick(n)} title={n.content}>
            <span className="chip-title">{title(n)}</span>
            {counts && n.mentions! > 1 && <span className="count">{n.mentions}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Kuka ikon: megerősítés után végleges törlés. Csak a törölhető node-on jelenik meg. */
function DeleteButton(props: {
  node: Detailed;
  onDeleted: (parentId: string) => void;
  onError: (err: unknown) => Promise<void>;
}) {
  const { node } = props;
  const remove = async () => {
    if (!window.confirm(`Végleg törlöd ezt a node-ot?\n\n„${title(node)}”\n\nVisszaállítani nem lehet.`)) return;
    try {
      const { parentId } = await api.deleteNode(node.id, node.version);
      props.onDeleted(parentId);
    } catch (err) {
      await props.onError(err);
    }
  };
  return (
    <button className="link icon" onClick={() => void remove()} title="Végleges törlés" aria-label="Törlés">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
      </svg>
    </button>
  );
}

/** Az ősök fája: a közvetlen szülők, alattuk beljebb a saját szüleik, egészen a gyökérig. */
function Ancestors({ view, onPick }: { view: View; onPick: (n: Brief) => void }) {
  const byId = new Map(view.ancestors.map((a) => [a.id, a]));
  const branch = (ids: string[], seen: Set<string>): ReactNode => {
    const shown = ids.filter((id) => byId.has(id) && !seen.has(id)); // a kör nem pörög körbe
    if (!shown.length) return null;
    return (
      <ul className="tree">
        {shown.map((id) => {
          const a = byId.get(id)!;
          return (
            <li key={id}>
              <button className={`chip type-${a.type ?? 'none'}`} onClick={() => onPick(a)} title={a.content}>
                <span className="chip-title">{title(a)}</span>
              </button>
              {branch(a.parent_ids, new Set([...seen, id]))}
            </li>
          );
        })}
      </ul>
    );
  };
  return branch(
    view.parents.map((p) => p.id),
    new Set([view.center.id]),
  );
}

/** A szöveg a felismert részekkel: a jegy és a név kattintható, a dátum kiemelt. */
function RichText({ node, onPick, nodes }: { node: { content: string; spans: Span[] }; onPick: (n: Brief) => void; nodes: Brief[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  node.spans.forEach((s, i) => {
    if (s.start < at) return;
    parts.push(node.content.slice(at, s.start));
    const text = node.content.slice(s.start, s.end);
    if (s.kind === 'date') {
      parts.push(
        <span key={i} className="span date" title={fmtRange(s.from!, s.to!)}>
          {text}
        </span>,
      );
    } else if (s.targetId) {
      const target = nodes.find((n) => n.id === s.targetId);
      parts.push(
        <button
          key={i}
          className={`span ${s.kind}`}
          title={target ? title(target) : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onPick(target ?? { id: s.targetId!, content: text, type: null, ticket_no: null, is_inbox: false });
          }}
        >
          {text}
        </button>,
      );
    } else {
      parts.push(text);
    }
    at = s.end;
  });
  parts.push(node.content.slice(at));
  return <span className="rich">{parts}</span>;
}

function Editor({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSave(text);
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
  };
  return (
    <div className="editor">
      <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} autoFocus rows={Math.max(2, text.split('\n').length)} />
      <div className="row">
        <button onClick={() => void submit()} disabled={busy || !text.trim()}>
          Mentés
        </button>
        <button className="link" onClick={onCancel}>
          Mégse
        </button>
        <span className="hint">Ctrl+Enter ment, Esc elvet</span>
      </div>
    </div>
  );
}

function Center(props: {
  node: Detailed;
  nodes: Brief[];
  isContext: boolean;
  onToggleContext: () => void;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
  onPick: (n: Brief) => void;
  onDeleted: (parentId: string) => void;
}) {
  const { node, onChanged, onError } = props;
  const [editing, setEditing] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [aliases, setAliases] = useState(node.aliases.join(', '));

  const update = async (input: Parameters<typeof api.update>[1] extends infer T ? Omit<T & object, 'version'> : never) => {
    try {
      await api.update(node.id, { version: node.version, ...input });
      setEditing(false);
    } catch (err) {
      onError(err instanceof ApiError && err.status === 409 ? new Error('Közben megváltozott, újratöltöttem. Próbáld újra.') : err);
    }
    await onChanged();
  };

  const [first = '', ...rest] = node.content.split('\n');
  const body = rest.join('\n').trim();

  return (
    <article className={`center type-${node.type ?? 'none'}`}>
      {editing ? (
        <Editor initial={node.content} onSave={(content) => update({ content })} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <h1>
            <RichText
              node={{ content: first, spans: node.spans.filter((s) => s.end <= first.length) }}
              onPick={props.onPick}
              nodes={props.nodes}
            />
          </h1>
          {body && (
            <p className="body">
              <RichText node={{ ...node, content: node.content }} onPick={props.onPick} nodes={props.nodes} />
            </p>
          )}
        </>
      )}
      {node.dates.length > 0 && (
        <p className="dates">
          {node.dates.map((d, i) => (
            <span key={i} className="span date">
              {fmtRange(d.starts_on, d.ends_on)}
            </span>
          ))}
        </p>
      )}
      <div className="row meta">
        <label>
          Ez a node:
          <select
            value={node.type ?? ''}
            disabled={node.is_inbox || node.type === 'ticket'}
            title="Magát ezt a node-ot jelöli meg; egy emberre a szövegben @Név formában hivatkozz."
            onChange={(e) => {
              const next = (e.target.value || null) as NodeType | null;
              // Egy mondatot ritkán akarunk emberré tenni: az első sor minden szava névvé válna.
              const sentence = first!.trim().split(/\s+/).length > 2;
              if (
                next === 'person' &&
                sentence &&
                !window.confirm(
                  `„${first}” maga lesz egy ember, és a program az első sor minden szavát a nevének tekinti.\n\n` +
                    'Ha csak említeni akarsz valakit, írd a szövegbe így: @Név.\n\nBiztosan emberré teszed?',
                )
              ) {
                return;
              }
              void update({ type: next });
            }}
          >
            <option value="">–</option>
            {(Object.keys(TYPE_LABEL) as NodeType[]).map((t) => (
              <option key={t} value={t} disabled={t === 'ticket' && node.type !== 'ticket'}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        {node.type === 'person' && (
          <label>
            Becenevek
            <input
              title="Ezekre a nevekre is ráismer a szövegekben, ragozva is."
              value={aliases}
              placeholder="pl. Szabolcs, Szabika"
              onChange={(e) => setAliases(e.target.value)}
              onBlur={() => {
                const next = aliases.split(',').map((a) => a.trim()).filter(Boolean);
                if (next.join(',') !== node.aliases.join(',')) void update({ aliases: next });
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </label>
        )}
        {!editing && !node.is_inbox && (
          <button className="link" onClick={() => setEditing(true)}>
            Szerkesztés
          </button>
        )}
        {!node.is_inbox && (
          <button className="link" onClick={props.onToggleContext}>
            {props.isContext ? 'Meeting lezárása' : 'Megnyitás meetingként'}
          </button>
        )}
        {!commenting && !node.is_inbox && (
          <button className="link" onClick={() => setCommenting(true)}>
            Komment
          </button>
        )}
        {node.deletable && (
          <DeleteButton
            node={node}
            onDeleted={(parentId) => props.onDeleted(parentId)}
            onError={async (err) => {
              onError(err);
              await onChanged();
            }}
          />
        )}
      </div>
      <Notes
        nodeId={node.id}
        notes={node.notes}
        known={props.nodes}
        adding={commenting}
        onAddDone={() => setCommenting(false)}
        onPick={props.onPick}
        onChanged={onChanged}
        onError={onError}
      />
    </article>
  );
}

function Capture(props: {
  inputRef: React.RefObject<HTMLTextAreaElement>;
  target: string;
  onSave: (text: string) => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await props.onSave(text);
      setText('');
    } catch (err) {
      props.onError(err); // a szöveg a mezőben marad
    } finally {
      setBusy(false);
      props.inputRef.current?.focus();
    }
  };

  return (
    <textarea
      ref={props.inputRef}
      className="capture"
      rows={Math.min(8, Math.max(1, text.split('\n').length))}
      value={text}
      placeholder={`Új bejegyzés ide: ${props.target} – Enter ment, Shift+Enter új sor`}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          void submit();
        }
      }}
    />
  );
}

function Below({ view, onPick, onChanged, onError }: { view: View; onPick: (n: Brief) => void; onChanged: () => Promise<void>; onError: (e: unknown) => void }) {
  // A típusos gyerekek (ember, jegy, meeting, téma) elemek; a többi bejegyzés.
  const items = view.below.filter((n) => n.is_child && n.type);
  const entries = view.below.filter((n) => !(n.is_child && n.type)).reverse(); // a legfrissebb elöl
  const known = [...view.connected, ...view.parents, ...view.below, view.center];

  return (
    <>
      {items.length > 0 && (
        <section className="items">
          <h2>Elemek</h2>
          <Chips nodes={items} onPick={onPick} />
        </section>
      )}
      <section className="entries">
        <h2>
          Bejegyzések <span className="count">{entries.length}</span>
        </h2>
        {entries.length === 0 && <p className="empty">Még nincs bejegyzés. Írj egyet a fenti mezőbe.</p>}
        <ul>
          {entries.map((e) => (
            <EntryRow key={e.id} entry={e} known={known} onPick={onPick} onChanged={onChanged} onError={onError} />
          ))}
        </ul>
      </section>
    </>
  );
}

function EntryRow({ entry, known, onPick, onChanged, onError }: { entry: Entry; known: Brief[]; onPick: (n: Brief) => void; onChanged: () => Promise<void>; onError: (e: unknown) => void }) {
  const [editing, setEditing] = useState(false);
  const [commenting, setCommenting] = useState(false);

  const saveEdit = async (content: string) => {
    try {
      await api.update(entry.id, { version: entry.version, content });
      setEditing(false);
    } catch (err) {
      onError(err instanceof ApiError && err.status === 409 ? new Error('Közben megváltozott, újratöltöttem. Próbáld újra.') : err);
    }
    await onChanged();
  };

  // Kattintásra megnyílik; a gombok, a szerkesztő, a kommentek és a szövegkijelölés kivételével.
  const open = (e: React.MouseEvent) => {
    if (editing || (e.target as HTMLElement).closest('button, a, textarea, input, .notes')) return;
    if (window.getSelection()?.toString()) return;
    onPick(entry);
  };

  return (
    <li className={editing ? 'entry' : 'entry clickable'} onClick={open}>
      <div className="entry-head">
        <time dateTime={entry.created_at}>{fmtStamp(entry.created_at)}</time>
        {entry.contexts.map((c) => (
          <button key={c.id} className={`chip small type-${c.type ?? 'none'}`} onClick={() => onPick(c)}>
            {title(c)}
          </button>
        ))}
        <span className="spacer" />
        {!commenting && (
          <button className="link" onClick={() => setCommenting(true)}>
            Komment
          </button>
        )}
        {!editing && (
          <button className="link" onClick={() => setEditing(true)}>
            Szerkesztés
          </button>
        )}
        {entry.deletable && (
          <DeleteButton
            node={entry}
            onDeleted={() => void onChanged()}
            onError={async (err) => {
              onError(err);
              await onChanged();
            }}
          />
        )}
        <button className="link" onClick={() => onPick(entry)} title="Középre állítás">
          Megnyitás
        </button>
      </div>
      {editing ? (
        <Editor initial={entry.content} onSave={saveEdit} onCancel={() => setEditing(false)} />
      ) : (
        <p className="entry-text">
          <RichText node={entry} onPick={onPick} nodes={known} />
        </p>
      )}
      <Notes
        nodeId={entry.id}
        notes={entry.notes}
        known={known}
        adding={commenting}
        onAddDone={() => setCommenting(false)}
        onPick={onPick}
        onChanged={onChanged}
        onError={onError}
      />
    </li>
  );
}

/** Egy node kommentjei. A felismert nevek és jegyek kiemeltek, de kapcsolatot nem hoznak létre. */
function Notes(props: {
  nodeId: string;
  notes: Note[];
  known: Brief[];
  adding: boolean;
  onAddDone: () => void;
  onPick: (n: Brief) => void;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { notes, onChanged, onError } = props;
  const [editingId, setEditingId] = useState<string | null>(null);

  /** Igazat ad, ha sikerült; hibánál a szerkesztő nyitva marad, a szöveg nem vész el. */
  const run = async (action: () => Promise<unknown>) => {
    let ok = true;
    try {
      await action();
    } catch (err) {
      ok = false;
      onError(err instanceof ApiError && err.status === 409 ? new Error('Közben megváltozott, újratöltöttem. Próbáld újra.') : err);
    }
    await onChanged();
    return ok;
  };

  if (!notes.length && !props.adding) return null;
  return (
    <div className="notes">
      {notes.length > 0 && (
        <ul>
          {notes.map((n) => (
            <li key={n.id} className="note">
              {editingId === n.id ? (
                <Editor
                  initial={n.content}
                  onSave={(content) => run(() => api.updateNote(n.id, n.version, content)).then((ok) => {
                      if (ok) setEditingId(null);
                    })}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <>
                  <p className="note-text">
                    <RichText node={n} onPick={props.onPick} nodes={props.known} />
                  </p>
                  <div className="note-head">
                    <time dateTime={n.created_at}>{fmtStamp(n.created_at)}</time>
                    <button className="link" onClick={() => setEditingId(n.id)}>
                      Szerkesztés
                    </button>
                    <button
                      className="link"
                      onClick={() => {
                        if (window.confirm('Törlöd a kommentet?')) void run(() => api.deleteNote(n.id, n.version));
                      }}
                    >
                      Törlés
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {props.adding && (
        <Editor
          initial=""
          onSave={(content) => run(() => api.addNote(props.nodeId, content)).then((ok) => {
              if (ok) props.onAddDone();
            })}
          onCancel={props.onAddDone}
        />
      )}
    </div>
  );
}

function Search({ onPick, onError }: { onPick: (n: Brief) => void; onError: (e: unknown) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Brief[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      api
        .search(q)
        .then((r) => {
          if (!stale) {
            setResults(r.results);
            setActive(0);
          }
        })
        .catch(onError);
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [q, onError]);

  const close = () => {
    setOpen(false);
    setQ('');
    input.current?.blur();
  };
  const pick = (n: Brief) => {
    onPick(n);
    close();
  };
  const createNew = async () => {
    try {
      pick((await api.create({ content: q.trim() })).node);
    } catch (err) {
      onError(err);
    }
  };
  // Az utolsó sor mindig az új node létrehozása a Bejövő alá.
  const total = results.length + (q.trim() ? 1 : 0);

  return (
    <div className="search">
      <input
        ref={input}
        value={q}
        placeholder="Keresés (Ctrl+K)"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(total - 1, a + 1));
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          }
          if (e.key === 'Enter' && total > 0) {
            const hit = results[active];
            if (hit) pick(hit);
            else void createNew();
          }
        }}
      />
      {open && total > 0 && (
        <ul className="results">
          {results.map((r, i) => (
            <li key={r.id}>
              <button className={i === active ? 'active' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
                {r.type && <span className={`tag type-${r.type}`}>{TYPE_LABEL[r.type]}</span>}
                <span className="chip-title">{title(r)}</span>
              </button>
            </li>
          ))}
          <li>
            <button
              className={active === results.length ? 'active new' : 'new'}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void createNew()}
            >
              Új node: „{q.trim()}”
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
