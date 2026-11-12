export interface User {
  id: string;
  email: string;
  display_name: string;
}

export type NodeType = 'person' | 'ticket' | 'meeting' | 'topic';

export interface Brief {
  id: string;
  content: string;
  type: NodeType | null;
  ticket_no: number | null;
}

export interface Span {
  kind: 'ticket' | 'person' | 'date';
  start: number;
  end: number;
  text: string;
  targetId?: string;
  from?: string;
  to?: string;
}

export interface NodeDate {
  starts_on: string;
  ends_on: string;
  meaning: 'unknown' | 'due' | 'absence';
  source_text: string;
  confirmed: boolean;
}

export interface Note {
  id: string;
  node_id: string;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
  spans: Span[];
}

export interface Detailed extends Brief {
  version: number;
  aliases: string[];
  created_at: string;
  spans: Span[];
  dates: NodeDate[];
  notes: Note[];
  /** Csak a szülője felé van kapcsolata, és nincs kommentje: végleg törölhető. */
  deletable: boolean;
}

export interface Entry extends Detailed {
  is_child: boolean;
  contexts: Brief[];
}

export interface Connected extends Brief {
  mentions: number;
  last_at: string;
}

export interface View {
  center: Detailed;
  parents: Brief[];
  /** Minden ős a gyökérig, a saját szülei azonosítójával. */
  ancestors: (Brief & { created_at: string; parent_ids: string[] })[];
  /** Az őt (máshol) említő bejegyzések szülei: innen indul az „Említve itt” fa. */
  mention_parent_ids: string[];
  below: Entry[];
  connected: Connected[];
  /** Többszintű nézetben a bejegyzések alatti szintek node-jai és kapcsolatai. */
  deeper: Detailed[];
  deeper_edges: { parent_id: string; child_id: string }[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'A szerver nem érhető el');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Hiba (${res.status})`);
  return data as T;
}

export const api = {
  me: () => call<{ user: User }>('GET', '/api/me'),
  login: (email: string, password: string) => call<{ user: User }>('POST', '/api/login', { email, password }),
  logout: () => call('POST', '/api/logout', {}),
  roots: () => call<{ roots: (Brief & { created_at: string })[] }>('GET', '/api/roots'),
  /** depth: a bejegyzések alatti további szintek száma (többszintű nézet). */
  view: (id: string, depth = 0) => call<View>('GET', `/api/nodes/${id}${depth ? `?melyseg=${depth}` : ''}`),
  search: (q: string) => call<{ results: Brief[] }>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  create: (input: { content: string; parentId?: string; contextId?: string }) =>
    call<{ node: Detailed }>('POST', '/api/nodes', input),
  update: (id: string, input: { version: number; content?: string; type?: NodeType | null; aliases?: string[] }) =>
    call<{ node: Detailed }>('PATCH', `/api/nodes/${id}`, input),
  addNote: (nodeId: string, content: string) => call<{ note: Note }>('POST', `/api/nodes/${nodeId}/notes`, { content }),
  updateNote: (id: string, version: number, content: string) =>
    call<{ note: Note }>('PATCH', `/api/notes/${id}`, { version, content }),
  deleteNote: (id: string, version: number) => call('DELETE', `/api/notes/${id}?version=${version}`),
  move: (id: string, from: string, to: string) => call<{ ok: true }>('POST', `/api/nodes/${id}/move`, { from, to }),
  deleteNode: (id: string, version: number) =>
    call<{ parentId: string | null }>('DELETE', `/api/nodes/${id}?version=${version}`),
};

/** A node rövid neve: a szöveg első sora. */
export const title = (n: { content: string }) => n.content.split('\n')[0] ?? '';
