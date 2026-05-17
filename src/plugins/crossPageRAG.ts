/**
 * Built-in plugin: cross-page RAG.
 *
 * Fetches additional pages of the same site, extracts their text, and
 * makes them retrievable. When the agent answers using one of these
 * passages, the source card carries a `pageUrl` so the user can click
 * to navigate there.
 *
 * Three discovery modes (in priority):
 *   1. `pages`   — explicit list of URLs to fetch
 *   2. `sitemap` — URL of a sitemap.xml; widget fetches and crawls
 *   3. `autoLinks` — follow same-origin <a href> from the current page (limited depth)
 *
 * Fetched content is cached in IndexedDB so repeat page loads don't
 * re-fetch. The cache invalidates after `maxAgeMs` (default 1 day).
 */

import type { AcolytePlugin, RAGSourceProvider } from '../plugin.js';
import type { RAGContent } from '../types.js';

export interface CrossPageRAGConfig {
  /** Explicit list of page URLs to index. */
  pages?: string[];
  /** URL of a sitemap.xml. The plugin will fetch and follow up to `maxPages`. */
  sitemap?: string;
  /** Follow same-origin <a> links from the current page. Discouraged for
   *  large sites — explicit `pages` is more predictable. */
  autoLinks?: boolean;
  /** Cap on pages to fetch. Default 20. */
  maxPages?: number;
  /** Cache TTL for fetched pages, in ms. Default 86_400_000 (1 day). */
  maxAgeMs?: number;
  /** CSS selector to extract content from each fetched page. Default 'main, article, body'. */
  contentSelector?: string;
  /** Optional: a function that, given a page URL, returns the title to use. */
  titleFor?(url: string, doc: Document): string;
}

interface CachedPage {
  url: string;
  title: string;
  sections: RAGContent[];
  fetchedAt: number;
}

/** Extract clean text-segmented sections from a fetched HTML document. */
function extractSections(doc: Document, url: string, contentSelector: string, titleFor?: CrossPageRAGConfig['titleFor']): RAGContent[] {
  const root = doc.querySelector(contentSelector) ?? doc.body;
  if (!root) return [];
  // Strip noisy elements
  root.querySelectorAll('script, style, noscript, nav, footer, aside, [data-acolyte-ignore]').forEach(n => n.remove());

  const pageTitle = titleFor?.(url, doc) ?? doc.title ?? url;
  const headings = root.querySelectorAll('h1, h2, h3');
  if (!headings.length) {
    const text = (root.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return [];
    return [{ id: `${url}#root`, title: pageTitle, text, meta: { url } }];
  }

  const out: RAGContent[] = [];
  const arr = Array.from(headings);
  for (let i = 0; i < arr.length; i++) {
    const h = arr[i];
    const next = arr[i + 1];
    const sectionTitle = (h.textContent ?? `Section ${i + 1}`).trim();
    const buf: string[] = [];
    let cur: Node | null = h.nextSibling;
    while (cur && cur !== next) {
      if (cur.nodeType === 1 || cur.nodeType === 3) {
        buf.push((cur as Element).textContent ?? cur.nodeValue ?? '');
      }
      cur = cur.nextSibling;
    }
    const text = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length < 80) continue;
    const anchor = h.id ? `#${h.id}` : '';
    out.push({
      id: `${url}${anchor || `#h-${i}`}`,
      title: `${pageTitle} — ${sectionTitle}`,
      text,
      meta: { url: url + anchor }
    });
  }
  return out;
}

async function fetchAndParse(url: string, contentSelector: string, titleFor?: CrossPageRAGConfig['titleFor']): Promise<RAGContent[]> {
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) return [];
    const ct = r.headers.get('content-type') ?? '';
    if (!ct.includes('html') && !ct.includes('text')) return [];
    const html = await r.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    return extractSections(doc, url, contentSelector, titleFor);
  } catch {
    return [];
  }
}

async function discoverFromSitemap(sitemapUrl: string, max: number): Promise<string[]> {
  try {
    const r = await fetch(sitemapUrl);
    if (!r.ok) return [];
    const xml = await r.text();
    const dom = new DOMParser().parseFromString(xml, 'text/xml');
    const locs = Array.from(dom.querySelectorAll('url > loc, sitemap > loc'));
    return locs.slice(0, max).map(l => (l.textContent ?? '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function discoverFromLinks(origin: string, max: number): string[] {
  if (typeof document === 'undefined') return [];
  const here = window.location.href;
  const links = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
  const seen = new Set<string>();
  for (const a of links) {
    if (seen.size >= max) break;
    try {
      const u = new URL(a.href, here);
      if (u.origin !== origin) continue;
      if (u.pathname === window.location.pathname) continue;
      u.hash = '';                  // dedupe by path
      seen.add(u.toString());
    } catch { /* skip */ }
  }
  return [...seen];
}

/** Factory — returns an AcolytePlugin you pass to mount({ plugins: [...] }). */
export function crossPageRAG(cfg: CrossPageRAGConfig = {}): AcolytePlugin {
  const contentSelector = cfg.contentSelector ?? 'main, article, body';
  const maxPages = cfg.maxPages ?? 20;
  const maxAge   = cfg.maxAgeMs ?? 24 * 60 * 60 * 1000;
  let cached: RAGContent[] = [];

  const source: RAGSourceProvider = {
    name: 'crossPageRAG',
    perQuery: false,
    crossPage: true,
    async fetch() { return cached; },
    pageUrl(section) { return (section.meta?.url as string) ?? undefined; }
  };

  return {
    name: 'crossPageRAG',
    version: '0.1.0',
    ragSources: [source],

    async init(handle, ctx) {
      ctx.log('discovering pages…');

      // 1) check persistent cache (per-origin)
      const cacheKey = 'pages';
      const cachedBlob = (await ctx.storage.get<CachedPage[]>(cacheKey)) ?? [];
      const fresh = cachedBlob.filter(p => Date.now() - p.fetchedAt < maxAge);
      if (fresh.length) {
        cached = fresh.flatMap(p => p.sections);
        ctx.log(`loaded ${cached.length} cached passages from ${fresh.length} pages`);
        await ctx.refreshRAG();
      }

      // 2) figure out the URL list to (re-)fetch
      let urls: string[] = [];
      if (cfg.pages?.length) urls = cfg.pages.slice(0, maxPages);
      else if (cfg.sitemap)  urls = await discoverFromSitemap(cfg.sitemap, maxPages);
      else if (cfg.autoLinks) urls = discoverFromLinks(window.location.origin, maxPages);

      // 3) fetch in parallel
      const fetched: CachedPage[] = [];
      const todo = urls.filter(u => !fresh.find(p => p.url === u));
      await Promise.all(todo.map(async url => {
        const sections = await fetchAndParse(url, contentSelector, cfg.titleFor);
        if (sections.length) fetched.push({ url, title: sections[0].title, sections, fetchedAt: Date.now() });
      }));

      // 4) merge fresh + newly fetched; persist
      const merged = [...fresh, ...fetched];
      cached = merged.flatMap(p => p.sections);
      await ctx.storage.set(cacheKey, merged);
      ctx.log(`indexed ${cached.length} passages across ${merged.length} pages`);

      await ctx.refreshRAG();
    }
  };
}
