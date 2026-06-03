/**
 * Built-in plugin: semantic RAG.
 *
 * A drop-in semantic-retrieval source. The widget already does lexical BM25
 * over the page (and cross-page via `crossPageRAG`); this plugin adds
 * *semantic* recall — so "law" matches a passage about "legal", "doctor"
 * matches "healthcare", etc. — without shipping any model to the browser.
 *
 * Design: the heavy parts (a SHARED, server-side vector index built once, and
 * query embedding) live behind a same-origin endpoint. This plugin is just a
 * thin `RAGSourceProvider` that POSTs the query and gets back ranked passages.
 * The widget merges them with its built-in lexical hits, so semantic is purely
 * additive — if the endpoint is missing or the index isn't built yet, the
 * chat keeps working on BM25 alone (no chicken-and-egg).
 *
 * Backend-agnostic: it knows nothing about OpenAI / Ollama / the store. Enable
 * by name in config — `{ "name": "semanticRAG" }` — the universal switch.
 */

import type { AcolytePlugin, RAGSourceProvider } from '../plugin.js';
import type { RAGContent } from '../types.js';

export interface SemanticRAGConfig {
  /** Same-origin search endpoint. Default '/api/semantic-search'. */
  endpoint?: string;
  /** How many passages to request. Default 6. */
  topK?: number;
  /** Extra headers (e.g. a shared token). */
  headers?: Record<string, string>;
}

export function semanticRAG(cfg: SemanticRAGConfig = {}): AcolytePlugin {
  const endpoint = cfg.endpoint ?? '/api/semantic-search';
  const topK = cfg.topK ?? 6;
  const headers = { 'content-type': 'application/json', ...(cfg.headers ?? {}) };

  const source: RAGSourceProvider = {
    name: 'semanticRAG',
    perQuery: true,      // live search — the endpoint ranks against the query
    crossPage: true,     // results may come from other pages of the site
    async fetch({ query, signal }) {
      if (!query) return [];
      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query, topK }),
          signal
        });
        if (!r.ok) return [];
        const data = await r.json();
        const passages = Array.isArray(data?.passages) ? data.passages : [];
        return passages.map((p: any, i: number): RAGContent => ({
          id: p.id ?? `${p.url ?? 'semantic'}#${i}`,
          title: p.title ?? 'Result',
          text: p.text ?? '',
          meta: { url: p.url, score: p.score }
        }));
      } catch {
        // Endpoint down / index not built → silently yield nothing; BM25 covers it.
        return [];
      }
    },
    pageUrl(section) {
      return (section.meta?.url as string) ?? undefined;
    }
  };

  return {
    name: 'semanticRAG',
    version: '0.1.0',
    ragSources: [source]
  };
}
