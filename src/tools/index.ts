/**
 * Tool implementations. Each tool gets a JSON-schema descriptor (for
 * native function-calling) and a plain async function.
 */

import type { ToolsConfig } from '../types.js';

export interface ToolDescriptor {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string }>;
      required?: string[];
    };
  };
}

export const TOOL_SCHEMAS: Record<string, ToolDescriptor> = {
  gemini_research: {
    type: 'function',
    function: {
      name: 'gemini_research',
      description: 'Research a topic using Gemini with live Google Search grounding. Use for current events, papers, recent docs, factual questions. Returns answer + citation URLs.',
      parameters: { type: 'object', properties: { topic: { type: 'string', description: 'The thing to research' } }, required: ['topic'] }
    }
  },
  lookup_docs: {
    type: 'function',
    function: {
      name: 'lookup_docs',
      description: 'Fetch focused, up-to-date docs for a programming library from Context7. Use for live library API questions.',
      parameters: {
        type: 'object',
        properties: {
          library: { type: 'string', description: 'Library name' },
          topic:   { type: 'string', description: 'Specific topic within the library' }
        },
        required: ['library']
      }
    }
  },
  deep_analysis: {
    type: 'function',
    function: {
      name: 'deep_analysis',
      description: 'Hand off a hard question + context to Gemini for long-form analysis. Use when reasoning needs to be careful and structured.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          context:  { type: 'string', description: 'Any context to attach' }
        },
        required: ['question']
      }
    }
  },
  catalog_lookup: {
    type: 'function',
    function: {
      name: 'catalog_lookup',
      description: 'Search the site\'s product catalog knowledge graph for PRECISE, COMPLETE answers about which items (packs) exist, what each one does/computes/models, and how they combine. Use this whenever the visitor asks about a specific capability ("which pack computes X"), a use-case ("what would I need for a shipping business"), or combining items — it returns exact matches and their relationships, unlike the page context.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for — a capability, metric, entity, domain, region, use-case, or item name.' }
        },
        required: ['query']
      }
    }
  }
};

export class Tools {
  constructor(private cfg: ToolsConfig = {}) {}
  update(cfg: ToolsConfig): void { this.cfg = { ...this.cfg, ...cfg }; }

  enabledNames(): string[] {
    const out: string[] = [];
    if (this.cfg.geminiResearch?.apiKey) out.push('gemini_research');
    if (this.cfg.context7?.enabled !== false) out.push('lookup_docs');
    if (this.cfg.deepAnalysis?.apiKey) out.push('deep_analysis');
    if (this.cfg.catalogLookup?.dataUrl) out.push('catalog_lookup');
    return out;
  }

  schemas(): ToolDescriptor[] {
    return this.enabledNames().map(n => TOOL_SCHEMAS[n]).filter(Boolean);
  }

  async run(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'gemini_research': return this.geminiResearch(String(args.topic ?? ''));
      case 'lookup_docs':     return this.lookupDocs(String(args.library ?? ''), String(args.topic ?? ''));
      case 'deep_analysis':   return this.deepAnalysis(String(args.question ?? ''), String(args.context ?? ''));
      case 'catalog_lookup':  return this.catalogLookup(String(args.query ?? ''));
      default: return `Unknown tool: ${name}`;
    }
  }

  /** Client-side knowledge-graph lookup over a static {nodes,edges} JSON.
   *  Scores nodes against the query, then for the matched items returns their
   *  1-hop neighbourhood (what they compute/model + how they combine). No
   *  backend — the graph is fetched once from `catalogLookup.dataUrl`. */
  private _graph: { nodes: any[]; edges: any[] } | null = null;
  private async loadGraph(): Promise<{ nodes: any[]; edges: any[] } | null> {
    if (this._graph) return this._graph;
    const url = this.cfg.catalogLookup?.dataUrl;
    if (!url) return null;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`graph ${r.status}`);
      const g = await r.json() as any;
      this._graph = { nodes: g.nodes ?? [], edges: g.edges ?? [] };
      return this._graph;
    } catch { return null; }
  }

  async catalogLookup(query: string): Promise<string> {
    const g = await this.loadGraph();
    if (!g) return 'Catalog graph is unavailable.';
    const label = this.cfg.catalogLookup?.label ?? 'item';
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    if (!terms.length) return `Ask about a specific ${label}, capability, metric, or use-case.`;

    const byId = new Map<string, any>(g.nodes.map((n) => [n.id, n]));
    const packs = g.nodes.filter((n) => n.type === 'pack');
    const hay = (n: any) => [
      n.label, n.description, n.domain, n.region,
      (n.capabilities ?? []).join(' '), (n.computes ?? []).join(' '),
      (n.metrics ?? []).map((m: any) => `${m.tool} ${m.does}`).join(' '), (n.tags ?? []).join(' ')
    ].join(' ').toLowerCase();

    // score packs directly …
    const score = (n: any) => { const h = hay(n); return terms.reduce((s, t) => s + (h.includes(t) ? 1 : 0), 0); };
    const scored = packs.map((p) => ({ p, s: score(p) })).filter((x) => x.s > 0);

    // … plus packs linked to any matched facet node (capability/entity/domain/region)
    const facet = g.nodes.filter((n) => n.type !== 'pack' && terms.some((t) => (n.label ?? '').toLowerCase().includes(t)));
    const facetPackIds = new Set<string>();
    for (const f of facet) for (const e of g.edges) if (e.to === f.id) facetPackIds.add(e.from);
    for (const id of facetPackIds) { const p = byId.get(id); if (p && !scored.find((x) => x.p.id === id)) scored.push({ p, s: 1 }); }

    if (!scored.length) return `No ${label} in the catalog matches "${query}". There are ${packs.length} ${label}s total; suggest contacting the team for a custom build.`;

    scored.sort((a, b) => b.s - a.s);
    const top = scored.slice(0, 8);
    const lines = top.map(({ p }) => {
      const combines = g.edges.filter((e) => e.from === p.id && e.rel === 'combinesWith').map((e) => byId.get(e.to)?.label).filter(Boolean);
      const metrics = (p.metrics ?? []).slice(0, 6).map((m: any) => m.tool).join(', ');
      const computes = (p.computes ?? []).slice(0, 8).join('; ');
      return `• ${p.label} [${p.region}] — ${p.description}` +
        (computes ? `\n    Computes: ${computes}` : '') +
        (metrics ? `\n    Queryable: ${metrics}` : '') +
        (combines.length ? `\n    Combines with: ${combines.join(', ')}` : '');
    });
    return `Matched ${top.length} of ${packs.length} ${label}s for "${query}":\n${lines.join('\n')}`;
  }

  async geminiResearch(topic: string): Promise<string> {
    const key = this.cfg.geminiResearch?.apiKey;
    if (!key) return 'Gemini research needs a Google AI Studio API key.';
    const model = this.cfg.geminiResearch?.model ?? 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      contents: [{ parts: [{ text: 'You are a research assistant. Provide a concise, factual answer with citations. Topic: ' + topic }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 4000 }
    };
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const data = await r.json() as any;
      const cand = data.candidates?.[0] ?? {};
      const parts = cand.content?.parts ?? [];
      let text = parts.map((p: any) => p.text ?? '').join('').trim();
      const gm = cand.groundingMetadata ?? cand.grounding_metadata ?? null;
      const chunks = gm?.groundingChunks ?? gm?.grounding_chunks ?? [];
      if (chunks?.length) {
        const sources = chunks.slice(0, 5).map((c: any, i: number) => {
          const w = c.web ?? {};
          return `[${i + 1}] ${w.title ?? w.uri ?? '?'} — ${w.uri ?? ''}`;
        }).join('\n');
        text = text + '\n\nSources:\n' + sources;
      }
      return text || '(gemini returned empty)';
    } catch (e: any) { return `Gemini research failed: ${e.message}`; }
  }

  async lookupDocs(library: string, topic: string): Promise<string> {
    try {
      const resolve = await fetch(`https://context7.com/api/v1/search?query=${encodeURIComponent(library)}`);
      if (!resolve.ok) throw new Error(`resolve ${resolve.status}`);
      const resolved = await resolve.json() as any;
      const pick = (resolved.results ?? resolved.items ?? [])[0];
      if (!pick) return `Context7: no library matched "${library}".`;
      const id = pick.id ?? pick.libraryId ?? pick.path;
      const docs = await fetch(`https://context7.com/api/v1/${id}?topic=${encodeURIComponent(topic ?? '')}&tokens=2000`);
      if (!docs.ok) throw new Error(`docs ${docs.status}`);
      const data = await docs.json() as any;
      const snippet = (data.content ?? data.text ?? '').slice(0, 1500);
      return `Context7 · ${pick.title ?? id}${topic ? ' · ' + topic : ''}\n\n${snippet}`;
    } catch (e: any) { return `Context7 lookup failed: ${e.message}`; }
  }

  async deepAnalysis(question: string, context: string): Promise<string> {
    const key = this.cfg.deepAnalysis?.apiKey;
    if (!key) return 'Deep analysis needs a Google AI Studio API key.';
    const model = this.cfg.deepAnalysis?.model ?? 'gemini-1.5-flash-latest';
    const prompt = `You are an expert analyst. Use the provided context to give a detailed, structured answer.\n\nCONTEXT:\n${context || '(none)'}\n\nQUESTION:\n${question}`;
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 1500 } })
      });
      if (!r.ok) throw new Error(`gemini ${r.status}`);
      const data = await r.json() as any;
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      return parts.map((p: any) => p.text ?? '').join('').trim() || '(gemini returned empty)';
    } catch (e: any) { return `Deep analysis failed: ${e.message}`; }
  }
}
