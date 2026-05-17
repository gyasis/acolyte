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
      default: return `Unknown tool: ${name}`;
    }
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
