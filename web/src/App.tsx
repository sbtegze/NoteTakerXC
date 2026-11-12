import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, ApiError, title, type Brief, type Detailed, type Entry, type Note, type NodeType, type Span, type User, type View } from './api';

interface Crumb {
  id: string;
  title: string;
}

const TYPE_LABEL: Record<NodeType, string> = { person: 'Ember', ticket: 'Jegy', meeting: 'Meeting', topic: 'Téma' };
/** A bejegyzés első sorában írható parancsok (a szerver nodes.ts COMMANDS listájával egyezik). */
const COMMAND_TYPES: Record<string, NodeType> = { meeting: 'meeting', téma: 'topic', tema: 'topic' };
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
// így a vissza/előre gomb és az újratöltés is ugyanoda visz. A ?nezet=fa a többszintű bejegyzéslista.
const urlFor = (path: Crumb[], tree: boolean) => (path.length ? `/n/${path.at(-1)!.id}` : '/') + (tree ? '?nezet=fa' : '');
const treeFromUrl = () => new URLSearchParams(location.search).get('nezet') === 'fa';
/** Többszintű nézetben ennyi szint látszik a bejegyzések alatt. */
const TREE_DEPTH = 2;
const idFromUrl = () => /^\/n\/([^/]+)$/.exec(location.pathname)?.[1];
function pathFromHistory(): Crumb[] {
  const id = idFromUrl();
  const saved = (history.state as { path?: Crumb[] } | null)?.path;
  if (saved && saved.at(-1)?.id === id) return saved;
  return id ? [{ id, title: '' }] : []; // a nevet a betöltés pótolja
}

/** A szövegből felismert nap: ÉÉÉÉ-HH-NN, napnév (pl. 2026-11-12, csütörtök). */
const fmtDay = (iso: string) => `${iso}, ${WEEKDAYS[new Date(`${iso}T00:00:00`).getDay()]}`;
const fmtRange = (from: string, to: string) => (from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`);
/** Időpont: ÉÉÉÉ-HH-NN, napnév, óó:pp (pl. 2026-11-12, csütörtök, 09:30), helyi idő szerint. */
const WEEKDAYS = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const fmtStamp = (iso: string) => {
  const d = new Date(iso);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}, ` +
    `${WEEKDAYS[d.getDay()]}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
};

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
  const [tree, setTree] = useState(treeFromUrl);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [context, setContext] = useState<Crumb | null>(() => load(() => localStorage, 'context', null));
  const currentId = path.at(-1)?.id;
  const captureRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => save(() => localStorage, 'context', context), [context]);

  // Az aktuális előzménybejegyzés mindig a friss útvonalat tárolja (pl. átnevezés vagy törölt node után).
  useEffect(() => {
    history.replaceState({ path }, '', urlFor(path, tree));
    const name = path.at(-1)?.title;
    document.title = name ? `${name} – NoteTakerXC` : 'NoteTakerXC';
  }, [path, tree]);

  useEffect(() => {
    const onPop = () => {
      setPath(pathFromHistory());
      setTree(treeFromUrl());
    };
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
      history.pushState({ path: next }, '', urlFor(next, tree));
      setPath(next);
    },
    [path, tree],
  );

  /** Egy- vagy többszintű bejegyzéslista; új előzménybejegyzés, így a vissza gomb is visszavált. */
  const setTreeView = (next: boolean) => {
    if (next === tree) return;
    history.pushState({ path }, '', urlFor(path, next));
    setTree(next);
  };

  const reload = useCallback(
    async (id: string) => {
      try {
        const next = await api.view(id, tree ? TREE_DEPTH : 0);
        setView(next);
        setError('');
        // Átnevezés után az útvonalon is az új név álljon.
        setPath((p) => p.map((c) => (c.id === id && c.title !== title(next.center) ? { ...c, title: title(next.center) } : c)));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) setPath((p) => p.filter((c) => c.id !== id));
        else fail(err);
      }
    },
    [fail, tree],
  );

  useEffect(() => {
    if (currentId) void reload(currentId); // üres útvonal: a kezdőlap a saját listáját tölti be
  }, [currentId, reload]);

  const goHome = () => {
    if (!path.length) return;
    history.pushState({ path: [] }, '', urlFor([], tree));
    setPath([]);
  };

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
          <button className={path.length ? 'crumb home' : 'crumb home current'} onClick={goHome} title="Kezdőlap" aria-label="Kezdőlap">
            ⌂
          </button>
          {path.map((c, i) => (
            <span key={c.id}>
              <span className="sep">›</span>
              <button className={i === path.length - 1 ? 'crumb current' : 'crumb'} onClick={() => go({ id: c.id, content: c.title })}>
                {c.title}
              </button>
            </span>
          ))}
        </nav>
        <QuickLists onPick={go} onError={fail} />
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

      {!currentId ? (
        <Home onPick={go} onError={fail} />
      ) : ready ? (
        <main className="map" key={view.center.id}>
          <aside className="side">
            <h2>Ide tartozik</h2>
            {view.parents.length > 0 && <Ancestors view={view} onPick={go} />}
            {view.mention_parent_ids.length > 0 && (
              <div className="group">
                <h3>Említve itt</h3>
                <MentionTree view={view} onPick={go} />
              </div>
            )}
            {!view.parents.length && !view.mention_parent_ids.length && <p className="empty">Legfelső szintű</p>}
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
                // A törölt node kikerül az útvonalból, a szülője áll középre (legfelső szintűnél a kezdőlap).
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
            <Below
              view={view}
              tree={tree}
              onTree={setTreeView}
              onPick={go}
              onChanged={() => reload(view.center.id)}
              onError={fail}
            />
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

/** A fejléc gyors linkjei: egy típusra kattintva lenyílik az összes ilyen node listája. */
function QuickLists({ onPick, onError }: { onPick: (n: Brief) => void; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState<NodeType | null>(null);
  const [nodes, setNodes] = useState<Brief[] | null>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    setNodes(null);
    api
      .byType(open)
      .then((r) => setNodes(r.nodes))
      .catch(onError);
    // Mellékattintásra vagy Esc-re bezárul.
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onError]);

  return (
    <nav className="quick" aria-label="Gyors listák" ref={ref}>
      {GROUPS.flatMap(([type, label]) =>
        type ? (
          <span key={type} className="quick-item">
            <button
              className={`link${open === type ? ' on' : ''}`}
              aria-expanded={open === type}
              onClick={() => setOpen(open === type ? null : type)}
            >
              {label}
            </button>
            {open === type && (
              <ul className="results">
                {nodes === null && <li className="hint">Betöltés…</li>}
                {nodes?.length === 0 && <li className="hint">Még nincs ilyen.</li>}
                {nodes?.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => {
                        setOpen(null);
                        onPick(n);
                      }}
                    >
                      <span className={`chip small type-${chipType(n)}`}>
                        <span className="chip-title">{title(n)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </span>
        ) : [],
      )}
    </nav>
  );
}

/** Kezdőlap: a legfelső szintű node-ok, a legújabb elöl; fent a mező egy újabb legfelső szintű node-hoz. */
function Home({ onPick, onError }: { onPick: (n: Brief) => void; onError: (e: unknown) => void }) {
  const [roots, setRoots] = useState<(Brief & { created_at: string })[] | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const refresh = useCallback(
    () =>
      api
        .roots()
        .then((r) => setRoots(r.roots))
        .catch(onError),
    [onError],
  );
  useEffect(() => {
    void refresh();
    inputRef.current?.focus();
  }, [refresh]);

  return (
    <main className="home-page">
      <Capture
        inputRef={inputRef}
        target="legfelső szint"
        onSave={async (content) => {
          await api.create({ content });
          await refresh();
        }}
        onError={onError}
      />
      <section className="entries">
        <h2>
          Legfelső szint <span className="count">{roots?.length}</span>
        </h2>
        {roots?.length === 0 && <p className="empty">Még nincs semmi. Írj egyet a fenti mezőbe.</p>}
        <ul>
          {roots?.map((r) => (
            <li key={r.id} className="entry clickable" onClick={() => onPick(r)}>
              <div className="entry-head">
                <time dateTime={r.created_at}>{fmtStamp(r.created_at)}</time>
                {r.type && <span className={`tag type-${r.type}`}>{TYPE_LABEL[r.type]}</span>}
              </div>
              <p className="entry-text">{title(r)}</p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function Chips({ nodes, onPick, counts }: { nodes: (Brief & { mentions?: number })[]; onPick: (n: Brief) => void; counts?: boolean }) {
  return (
    <ul className="chips">
      {nodes.map((n) => (
        <li key={n.id}>
          <button className={`chip type-${chipType(n)}`} onClick={() => onPick(n)} title={n.content}>
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
  onDeleted: (parentId: string | null) => void;
  onError: (err: unknown) => Promise<void>;
}) {
  const { node } = props;
  const inactive = !node.deletable;
  const remove = async () => {
    if (inactive) return;
    if (!window.confirm(`Végleg törlöd ezt a node-ot?\n\n„${title(node)}”\n\nVisszaállítani nem lehet.`)) return;
    try {
      const { parentId } = await api.deleteNode(node.id, node.version);
      props.onDeleted(parentId);
    } catch (err) {
      await props.onError(err);
    }
  };
  return (
    // aria-disabled, nem disabled: így a súgó rámutatáskor is megjelenik.
    <button
      className="link icon"
      onClick={() => void remove()}
      aria-disabled={inactive}
      aria-label="Törlés"
      title={
        inactive
          ? 'Nem törölhető: csak az a node törölhető, amelynek egyetlen kapcsolata a szülője felé mutat, és nincs kommentje.'
          : 'Végleges törlés'
      }
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
      </svg>
    </button>
  );
}

/**
 * A címke színe: a node típusa; a típus nélküli, csak egy emberre vagy jegyre hivatkozó node
 * (pl. „@Ákos”, „#5589”) a hivatkozott dolog színét kapja.
 */
function chipType(n: { content: string; type: NodeType | null }): string {
  if (n.type) return n.type;
  const t = title(n).trim();
  if (/^@\p{L}+(?: \p{Lu}\p{Ll}+){0,2}$/u.test(t)) return 'person';
  if (/^#\d+$/.test(t)) return 'ticket';
  return 'none';
}

/**
 * „Említve itt”: ahol a node-ot említik, felülről lefelé. Felül a legfelső szintű node-ok, alattuk beljebb
 * az alábontás, egészen az említő bejegyzések szülőjéig; minden szinten a legújabb elöl.
 */
function MentionTree({ view, onPick }: { view: View; onPick: (n: Brief) => void }) {
  const byId = new Map(view.ancestors.map((a) => [a.id, a]));
  // Az említő bejegyzések szülei és minden ősük.
  const inTree = new Set<string>();
  const collect = (id: string) => {
    if (inTree.has(id) || !byId.has(id) || id === view.center.id) return;
    inTree.add(id);
    byId.get(id)!.parent_ids.forEach(collect);
  };
  view.mention_parent_ids.forEach(collect);
  const newestFirst = (ids: string[]) =>
    ids.map((id) => byId.get(id)!).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const childrenOf = (id: string) =>
    newestFirst([...inTree].filter((c) => byId.get(c)!.parent_ids.includes(id)));
  const roots = newestFirst([...inTree].filter((id) => !byId.get(id)!.parent_ids.some((p) => inTree.has(p))));

  const branch = (nodes: typeof roots, seen: Set<string>): ReactNode => {
    const shown = nodes.filter((n) => !seen.has(n.id)); // a kör nem pörög körbe
    if (!shown.length) return null;
    return (
      <ul className="tree">
        {shown.map((n) => (
          <li key={n.id}>
            <button className={`chip type-${chipType(n)}`} onClick={() => onPick(n)} title={n.content}>
              <span className="chip-title">{title(n)}</span>
            </button>
            {branch(childrenOf(n.id), new Set([...seen, n.id]))}
          </li>
        ))}
      </ul>
    );
  };
  return branch(roots, new Set());
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
              <button className={`chip type-${chipType(a)}`} onClick={() => onPick(a)} title={a.content}>
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

/** A meeting és a téma címe (az első sora) egészben egy pill, a típus színével. */
const hasTitlePill = (n: { type: NodeType | null }) => n.type === 'meeting' || n.type === 'topic';
function TitlePill({ node }: { node: { content: string; type: NodeType | null } }) {
  return <span className={`span title-pill type-${node.type}`}>{title(node)}</span>;
}
/** A szöveg az első sor után (a sortöréssel együtt), a felismert részek helyével eltolva. */
function afterFirstLine(n: { content: string; spans: Span[] }) {
  const cut = title(n).length;
  return {
    content: n.content.slice(cut),
    spans: n.spans.filter((s) => s.start >= cut).map((s) => ({ ...s, start: s.start - cut, end: s.end - cut })),
  };
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
            onPick(target ?? { id: s.targetId!, content: text, type: null, ticket_no: null });
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

/** A helyi nap ÉÉÉÉ-HH-NN alakban. */
const localDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/**
 * Tipp a „/parancs cím” első sorhoz: mit hoz létre belőle a szerver (nodes.ts, parseCommand).
 * `day` a rögzítés napja, ez kerül a cím mögé; `when` pl. „Enterre” vagy „Mentéskor”.
 */
function commandHint(text: string, day: string, when: string): string | null {
  const cmd = /^\/(\p{L}*)(?:[ \t]+(\S.*))?$/u.exec((text.split('\n')[0] ?? '').trim());
  if (!cmd) return null;
  const type = COMMAND_TYPES[cmd[1]!.toLowerCase()];
  if (type && cmd[2]) {
    // Ha a címben számmal írt dátum van, a szerver nem ír mögé még egyet (nodes.ts, parseCommand).
    const name = cmd[2].trim();
    const dated = /\d{4}[-.]\s?\d{1,2}[-.]\s?\d{1,2}|(?<![\d.])\d{1,2}\.\s?\d{1,2}(?!\d)|(?:jan|feb|márc|ápr|máj|jún|júl|aug|szept|okt|nov|dec)\p{L}*\.?\s*\d{1,2}/iu.test(name);
    return `${when} ${TYPE_LABEL[type]} lesz belőle: „${dated ? name : `${name} ${day}`}”`;
  }
  if (type) return `Írd a parancs után a címet, pl. /${cmd[1]} AI workshop`;
  return 'Parancsok: /meeting cím, /téma cím. Más perjeles sor sima szöveg marad.';
}

/** commandDay: ha megadjuk (típus nélküli node rögzítésének napja), a parancs-tippet is mutatja. */
function Editor({ initial, onSave, onCancel, commandDay }: { initial: string; onSave: (text: string) => Promise<void>; onCancel: () => void; commandDay?: string }) {
  const [text, setText] = useState(initial);
  const hint = commandDay ? commandHint(text, commandDay, 'Mentéskor') : null;
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
      {hint && <p className="hint editor-hint">{hint}</p>}
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
  onDeleted: (parentId: string | null) => void;
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
  // Ha a szöveg csak egy ember vagy jegy (pl. „@Sanyi”, „#5589”), a node csak hivatkozás: nem kap típust.
  // Ha mégis van típusa (régebbről), a választó megmarad, hogy vissza lehessen állítani.
  const onlyReference =
    node.type === null &&
    node.spans.length === 1 &&
    node.spans[0]!.kind !== 'date' &&
    node.content.trim() === node.spans[0]!.text;

  return (
    <article className={`center type-${node.type ?? 'none'}`}>
      <time className="stamp" dateTime={node.created_at}>
        {fmtStamp(node.created_at)}
      </time>
      {editing ? (
        <Editor
          initial={node.content}
          onSave={(content) => update({ content })}
          onCancel={() => setEditing(false)}
          commandDay={node.type === null ? localDay(new Date(node.created_at)) : undefined}
        />
      ) : (
        <>
          <h1>
            {hasTitlePill(node) ? (
              <TitlePill node={node} />
            ) : (
              <RichText
                node={{ content: first, spans: node.spans.filter((s) => s.end <= first.length) }}
                onPick={props.onPick}
                nodes={props.nodes}
              />
            )}
          </h1>
          {body && (
            <p className="body">
              <RichText node={{ ...node, content: node.content }} onPick={props.onPick} nodes={props.nodes} />
            </p>
          )}
        </>
      )}
      <div className="row meta">
        {!onlyReference && (
          <label>
            Ez a node:
            {/* Az embert a @Név, a jegyet a #1234 hozza létre; ezeknél a típus nem változtatható. */}
            <select
              value={node.type ?? ''}
              disabled={node.type === 'ticket' || node.type === 'person'}
              title="Magát ezt a node-ot jelöli meg. Embert a szövegben @Név formában hozz létre."
              onChange={(e) => void update({ type: (e.target.value || null) as NodeType | null })}
            >
              {node.type === 'ticket' || node.type === 'person' ? (
                <option value={node.type}>{TYPE_LABEL[node.type]}</option>
              ) : (
                <>
                  <option value="">–</option>
                  <option value="meeting">{TYPE_LABEL.meeting}</option>
                  <option value="topic">{TYPE_LABEL.topic}</option>
                </>
              )}
            </select>
          </label>
        )}
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
        {!editing && (
          <button className="link" onClick={() => setEditing(true)}>
            Szerkesztés
          </button>
        )}
        <button
          className="link"
          onClick={() => {
            // Amit meetingként nyitunk meg, az meeting; a típusos (ember, jegy, téma) és a csak
            // hivatkozásból álló (pl. „@Sanyi”) node nem változik.
            if (!props.isContext && node.type === null && !onlyReference) void update({ type: 'meeting' });
            props.onToggleContext();
          }}
        >
          {props.isContext ? 'Meeting lezárása' : 'Megnyitás meetingként'}
        </button>
        {!commenting && (
          <button className="link" onClick={() => setCommenting(true)}>
            Komment
          </button>
        )}
        <DeleteButton
          node={node}
          onDeleted={(parentId) => props.onDeleted(parentId)}
          onError={async (err) => {
            await onChanged(); // előbb újratöltünk, mert az a hibaüzenetet törli
            onError(err);
          }}
        />
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

  const hint = commandHint(text, localDay(new Date()), 'Enterre');

  return (
    <>
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
      {hint && <p className="hint capture-hint">{hint}</p>}
    </>
  );
}

function Below(props: {
  view: View;
  tree: boolean;
  onTree: (tree: boolean) => void;
  onPick: (n: Brief) => void;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}) {
  const { view, tree, onPick, onChanged, onError } = props;
  // Minden alárendelt és említő node egy listában; a típusost (pl. meeting) a fejlécében címke jelzi.
  const top = view.below;
  const known = [...view.connected, ...view.parents, ...view.below, ...view.deeper, view.center];

  // Egyszintű: a legfrissebb elöl. Többszintű: időrendben, mindegyik alatt a saját albejegyzései,
  // szintenként kicsit beljebb; a kör nem pörög körbe.
  // parentId: ahonnan húzással áthelyezhető; a csak említés miatt itt álló bejegyzésnél nincs ilyen.
  const rows: { entry: Entry; depth: number; parentId?: string }[] = [];
  const topParent = (e: Entry) => (e.is_child ? view.center.id : undefined);
  if (!tree) {
    for (const e of [...top].reverse()) rows.push({ entry: e, depth: 0, parentId: topParent(e) });
  } else {
    const byId = new Map(view.deeper.map((d) => [d.id, d]));
    const childrenOf = (id: string) =>
      view.deeper_edges
        .filter((e) => e.parent_id === id)
        .flatMap((e) => byId.get(e.child_id) ?? [])
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const walk = (entry: Entry, depth: number, parentId: string | undefined, seen: Set<string>) => {
      rows.push({ entry, depth, parentId });
      if (depth >= TREE_DEPTH) return;
      for (const c of childrenOf(entry.id)) {
        if (!seen.has(c.id)) walk({ ...c, is_child: true, contexts: [] }, depth + 1, entry.id, new Set([...seen, c.id]));
      }
    };
    for (const e of top) walk(e, 0, topParent(e), new Set([view.center.id, e.id]));
  }

  return (
    <>
      <section className="entries">
        <div className="entries-head">
          <h2>
            Bejegyzések <span className="count">{top.length}</span>
          </h2>
          <span className="view-toggle" role="group" aria-label="Megjelenítés">
            <button className={tree ? '' : 'on'} aria-pressed={!tree} title="Egyszintű, a legfrissebb elöl" onClick={() => props.onTree(false)}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M2 4h12M2 8h12M2 12h12" />
              </svg>
            </button>
            <button className={tree ? 'on' : ''} aria-pressed={tree} title={`Többszintű, időrendben (+${TREE_DEPTH} szint)`} onClick={() => props.onTree(true)}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M2 3h12M5 8h9M8 13h6" />
              </svg>
            </button>
          </span>
        </div>
        {top.length === 0 && <p className="empty">Még nincs bejegyzés. Írj egyet a fenti mezőbe.</p>}
        <ul>
          {rows.map(({ entry, depth, parentId }, i) => (
            <EntryRow
              key={`${entry.id}-${i}`}
              entry={entry}
              depth={depth}
              parentId={parentId}
              known={known}
              onPick={onPick}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </ul>
      </section>
    </>
  );
}

/** Húzás közben ebben adjuk át, mit és honnan húzunk. */
const DRAG_TYPE = 'application/x-notetaker-node';

function EntryRow({ entry, depth = 0, parentId, known, onPick, onChanged, onError }: { entry: Entry; depth?: number; parentId?: string; known: Brief[]; onPick: (n: Brief) => void; onChanged: () => Promise<void>; onError: (e: unknown) => void }) {
  const [editing, setEditing] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [dropHere, setDropHere] = useState(false);

  // Húzással áthelyezés: a ráejtett bejegyzés ez alá kerül.
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ id: entry.id, from: parentId }));
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropHere(true);
  };
  const onDrop = async (e: React.DragEvent) => {
    setDropHere(false);
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    const { id, from } = JSON.parse(raw) as { id: string; from: string };
    if (id === entry.id) return;
    try {
      await api.move(id, from, entry.id);
      await onChanged();
    } catch (err) {
      await onChanged(); // előbb újratöltünk, mert az a hibaüzenetet törli
      onError(err);
    }
  };

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
    <li
      className={`${editing ? 'entry' : 'entry clickable'}${dropHere ? ' drop-here' : ''}`}
      style={depth ? { marginLeft: `${depth * 20}px` } : undefined}
      onClick={open}
      draggable={!editing && !!parentId}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={() => setDropHere(false)}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="entry-head">
        <time dateTime={entry.created_at}>{fmtStamp(entry.created_at)}</time>
        {entry.contexts.map((c) => (
          <button key={c.id} className={`chip small type-${chipType(c)}`} onClick={() => onPick(c)}>
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
        <button className="link" onClick={() => onPick(entry)} title="Középre állítás">
          Megnyitás
        </button>
        <DeleteButton
          node={entry}
          onDeleted={() => void onChanged()}
          onError={async (err) => {
            await onChanged(); // előbb újratöltünk, mert az a hibaüzenetet törli
            onError(err);
          }}
        />
      </div>
      {editing ? (
        <Editor
          initial={entry.content}
          onSave={saveEdit}
          onCancel={() => setEditing(false)}
          commandDay={entry.type === null ? localDay(new Date(entry.created_at)) : undefined}
        />
      ) : (
        <p className="entry-text">
          {hasTitlePill(entry) ? (
            <>
              <TitlePill node={entry} />
              <RichText node={afterFirstLine(entry)} onPick={onPick} nodes={known} />
            </>
          ) : (
            <RichText node={entry} onPick={onPick} nodes={known} />
          )}
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
  // Az utolsó sor mindig egy új, legfelső szintű node létrehozása.
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
