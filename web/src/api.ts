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
  is_inbox: boolean;
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
  ancestors: (Brief & { parent_ids: string[] })[];
  below: Entry[];
  connected: Connected[];
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
  home: () => call<{ id: string }>('GET', '/api/home'),
  view: (id: string) => call<View>('GET', `/api/nodes/${id}`),
  search: (q: string) => call<{ results: Brief[] }>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  create: (input: { content: string; parentId?: string; contextId?: string }) =>
    call<{ node: Detailed }>('POST', '/api/nodes', input),
  update: (id: string, input: { version: number; content?: string; type?: NodeType | null; aliases?: string[] }) =>
    call<{ node: Detailed }>('PATCH', `/api/nodes/${id}`, input),
  addNote: (nodeId: string, content: string) => call<{ note: Note }>('POST', `/api/nodes/${nodeId}/notes`, { content }),
  updateNote: (id: string, version: number, content: string) =>
    call<{ note: Note }>('PATCH', `/api/notes/${id}`, { version, content }),
  deleteNote: (id: string, version: number) => call('DELETE', `/api/notes/${id}?version=${version}`),
  deleteNode: (id: string, version: number) =>
    call<{ parentId: string }>('DELETE', `/api/nodes/${id}?version=${version}`),
};

/** A node rövid neve: a szöveg első sora. */
/** A Bejövő jele: szöveges neve nincs a felületen. */
export const INBOX_SYMBOL = '📥';
export const title = (n: { content: string; is_inbox?: boolean }) =>
  n.is_inbox ? INBOX_SYMBOL : (n.content.split('\n')[0] ?? '');
