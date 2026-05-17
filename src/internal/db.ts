/**
 * IndexedDB store — response cache + tool-result cache + conversation history.
 * Cache key is intentionally coarse (last user message + active section) so
 * repeat-question hits work mid-conversation. Tool cache is keyed on
 * (toolName + JSON args).
 */

export interface ConversationRow {
  id?: number;
  title: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messages: { role: string; content: string; ts?: number; tool_name?: string }[];
}

export interface CacheRow {
  hash: string;
  provider: string;
  model: string;
  preview: string;
  response: string;
  createdAt: number;
  hits: number;
}

export interface ConvoSummary {
  id: number;
  title: string;
  provider: string;
  model: string;
  updatedAt: number;
  messageCount: number;
}

export interface CacheStats { count: number; hits: number; bytes: number; }

export class ChatDB {
  private dbName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly STORE_CONVO = 'conversations';
  private readonly STORE_CACHE = 'responseCache';

  constructor(dbName = 'acolyte-chat') {
    this.dbName = dbName;
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB not supported'));
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.STORE_CONVO)) {
          const s1 = db.createObjectStore(this.STORE_CONVO, { keyPath: 'id', autoIncrement: true });
          s1.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(this.STORE_CACHE)) {
          const s2 = db.createObjectStore(this.STORE_CACHE, { keyPath: 'hash' });
          s2.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private async tx<T = unknown>(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.open();
    return db.transaction(name, mode).objectStore(name);
  }

  private wrap<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  private async digest(payload: string): Promise<string> {
    if (window.crypto?.subtle) {
      const enc = new TextEncoder().encode(payload);
      const buf = await crypto.subtle.digest('SHA-256', enc);
      return Array.prototype.map
        .call(new Uint8Array(buf), (b: number) => ('0' + b.toString(16)).slice(-2))
        .join('');
    }
    // 32-bit FNV-1a fallback
    let h = 0x811c9dc5;
    for (let i = 0; i < payload.length; i++) {
      h ^= payload.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  private lastUserMsg(msgs: { role: string; content: string }[]): string {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === 'user') return String(msgs[i].content || '');
    }
    return '';
  }

  /* ───── Conversations ───── */

  async newConversation(meta: { title?: string; provider?: string; model?: string }): Promise<ConversationRow> {
    const store = await this.tx(this.STORE_CONVO, 'readwrite');
    const now = Date.now();
    const row: ConversationRow = {
      title: meta.title ?? 'Untitled',
      provider: meta.provider ?? '',
      model:    meta.model ?? '',
      createdAt: now, updatedAt: now,
      messages: []
    };
    const id = await this.wrap(store.add(row)) as number;
    row.id = id;
    return row;
  }

  async appendMessage(id: number, msg: { role: string; content: string }): Promise<ConversationRow | null> {
    const store = await this.tx(this.STORE_CONVO, 'readwrite');
    const conv = await this.wrap(store.get(id)) as ConversationRow | undefined;
    if (!conv) return null;
    conv.messages.push({ ...msg, ts: Date.now() });
    conv.updatedAt = Date.now();
    if (conv.title === 'Untitled' && msg.role === 'user' && msg.content) {
      conv.title = String(msg.content).slice(0, 80);
    }
    await this.wrap(store.put(conv));
    return conv;
  }

  async listConversations(limit = 50): Promise<ConvoSummary[]> {
    const store = await this.tx(this.STORE_CONVO, 'readonly');
    const index = store.index('updatedAt');
    return new Promise((resolve) => {
      const out: ConvoSummary[] = [];
      const cur = index.openCursor(null, 'prev');
      cur.onsuccess = (e) => {
        const c = (e.target as IDBRequest).result as IDBCursorWithValue | null;
        if (!c || out.length >= limit) { resolve(out); return; }
        const v = c.value as ConversationRow;
        out.push({
          id: v.id!, title: v.title, provider: v.provider, model: v.model,
          updatedAt: v.updatedAt, messageCount: v.messages?.length ?? 0
        });
        c.continue();
      };
      cur.onerror = () => resolve(out);
    });
  }

  async getConversation(id: number): Promise<ConversationRow | undefined> {
    const store = await this.tx(this.STORE_CONVO, 'readonly');
    return this.wrap(store.get(id)) as Promise<ConversationRow | undefined>;
  }

  async deleteConversation(id: number): Promise<void> {
    const store = await this.tx(this.STORE_CONVO, 'readwrite');
    await this.wrap(store.delete(id));
  }

  async clearConversations(): Promise<void> {
    const store = await this.tx(this.STORE_CONVO, 'readwrite');
    await this.wrap(store.clear());
  }

  /** Simple keyword overlap search across past conversations. */
  async searchConversations(
    query: string,
    topN = 3,
    opts: { excludeId?: number } = {}
  ): Promise<{ conversation: ConvoSummary; score: number; snippets: { role: string; content: string }[] }[]> {
    const tokens = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9_\-/.]+/g, ' ').split(/\s+/).filter(t => t.length > 1 && t.length < 40);
    const qTokens = tokens(query);
    if (!qTokens.length) return [];
    const qSet: Record<string, number> = {};
    for (const t of qTokens) qSet[t] = (qSet[t] ?? 0) + 1;

    const store = await this.tx(this.STORE_CONVO, 'readonly');
    const convos: ConversationRow[] = await new Promise((resolve) => {
      const out: ConversationRow[] = [];
      const cur = store.openCursor();
      cur.onsuccess = (e) => {
        const c = (e.target as IDBRequest).result as IDBCursorWithValue | null;
        if (!c) { resolve(out); return; }
        if (!opts.excludeId || c.value.id !== opts.excludeId) out.push(c.value);
        c.continue();
      };
      cur.onerror = () => resolve(out);
    });

    const results: { conversation: ConvoSummary; score: number; snippets: { role: string; content: string }[] }[] = [];
    for (const c of convos) {
      let convoScore = 0;
      const snippets: { role: string; content: string; score: number }[] = [];
      for (const m of c.messages ?? []) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const toks = tokens(m.content);
        if (!toks.length) continue;
        let score = 0;
        const seen: Record<string, true> = {};
        for (const tok of toks) {
          if (qSet[tok] && !seen[tok]) { score += qSet[tok]; seen[tok] = true; }
        }
        const distinct = Object.keys(seen).length;
        if (distinct >= 2) score *= 1 + distinct * 0.3;
        if (score > 0) { snippets.push({ role: m.role, content: m.content, score }); convoScore += score; }
      }
      if (convoScore > 0) {
        snippets.sort((a, b) => b.score - a.score);
        results.push({
          conversation: { id: c.id!, title: c.title, provider: c.provider, model: c.model, updatedAt: c.updatedAt, messageCount: c.messages?.length ?? 0 },
          score: convoScore,
          snippets: snippets.slice(0, 4).map(s => ({ role: s.role, content: s.content }))
        });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topN);
  }

  /* ───── Response cache ───── */

  private async cacheHash(
    provider: string, model: string,
    messages: { role: string; content: string }[],
    contextKey: string
  ): Promise<string> {
    const lastMsg = this.lastUserMsg(messages).trim().toLowerCase();
    return this.digest(JSON.stringify({ provider, model, q: lastMsg, ctx: contextKey }));
  }

  async cacheGet(
    provider: string, model: string,
    messages: { role: string; content: string }[],
    contextKey = ''
  ): Promise<CacheRow | null> {
    const h = await this.cacheHash(provider, model, messages, contextKey);
    const store = await this.tx(this.STORE_CACHE, 'readonly');
    const row = await this.wrap(store.get(h)) as CacheRow | undefined;
    return row ?? null;
  }

  async cachePut(
    provider: string, model: string,
    messages: { role: string; content: string }[],
    response: string,
    contextKey = ''
  ): Promise<void> {
    const h = await this.cacheHash(provider, model, messages, contextKey);
    const store = await this.tx(this.STORE_CACHE, 'readwrite');
    await this.wrap(store.put({
      hash: h, provider, model,
      preview: this.lastUserMsg(messages).slice(0, 200),
      response, createdAt: Date.now(), hits: 0
    } satisfies CacheRow));
  }

  async cacheBumpHit(hash: string): Promise<void> {
    const store = await this.tx(this.STORE_CACHE, 'readwrite');
    const row = await this.wrap(store.get(hash)) as CacheRow | undefined;
    if (!row) return;
    row.hits = (row.hits ?? 0) + 1;
    await this.wrap(store.put(row));
  }

  async cacheStats(): Promise<CacheStats> {
    const store = await this.tx(this.STORE_CACHE, 'readonly');
    return new Promise((resolve) => {
      let count = 0, hits = 0, bytes = 0;
      const cur = store.openCursor();
      cur.onsuccess = (e) => {
        const c = (e.target as IDBRequest).result as IDBCursorWithValue | null;
        if (!c) { resolve({ count, hits, bytes }); return; }
        const v = c.value as CacheRow;
        count++;
        hits += (v.hits ?? 0);
        bytes += (v.response?.length ?? 0) + (v.preview?.length ?? 0) + 80;
        c.continue();
      };
      cur.onerror = () => resolve({ count, hits, bytes });
    });
  }

  async clearCache(): Promise<void> {
    const store = await this.tx(this.STORE_CACHE, 'readwrite');
    await this.wrap(store.clear());
  }

  /* ───── Tool-result cache (same store, "TOOL:" key prefix) ───── */

  private async toolHash(name: string, args: unknown): Promise<string> {
    const payload = JSON.stringify({ tool: name, args: args ?? {} });
    return 'TOOL:' + (await this.digest(payload));
  }

  async toolCacheGet(name: string, args: unknown): Promise<CacheRow | null> {
    const h = await this.toolHash(name, args);
    const store = await this.tx(this.STORE_CACHE, 'readonly');
    const row = await this.wrap(store.get(h)) as CacheRow | undefined;
    return row ?? null;
  }

  async toolCachePut(name: string, args: unknown, result: string): Promise<void> {
    const h = await this.toolHash(name, args);
    const store = await this.tx(this.STORE_CACHE, 'readwrite');
    await this.wrap(store.put({
      hash: h, provider: 'tool', model: name,
      preview: JSON.stringify(args ?? {}).slice(0, 200),
      response: typeof result === 'string' ? result : JSON.stringify(result),
      createdAt: Date.now(), hits: 0
    } satisfies CacheRow));
  }

  async toolCacheBumpHit(name: string, args: unknown): Promise<void> {
    const h = await this.toolHash(name, args);
    const store = await this.tx(this.STORE_CACHE, 'readwrite');
    const row = await this.wrap(store.get(h)) as CacheRow | undefined;
    if (!row) return;
    row.hits = (row.hits ?? 0) + 1;
    await this.wrap(store.put(row));
  }
}
