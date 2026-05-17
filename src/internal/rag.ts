/**
 * In-browser RAG retrieval over the host page's content.
 *
 * Modes (in priority order):
 *   1. Explicit `sections` config — use those, skip the DOM.
 *   2. `sourceUrl` config — fetch JSON sidecar.
 *   3. `selector` config — scan that element's content.
 *   4. Auto — try <main>, <article>, then collect <section>s, then <body>;
 *      sub-split by h1/h2/h3 headings into passages.
 */

import type { RAGConfig, RAGContent } from '../types.js';

interface Passage {
  id: number;
  sectionId: string;
  sectionTitle: string;
  text: string;
  terms: string[];
  len: number;
}

export class RAGEngine {
  private cfg: RAGConfig;
  private passages: Passage[] | null = null;
  private df: Record<string, number> = {};
  private avgLen = 0;
  private readonly k1 = 1.4;
  private readonly b  = 0.75;

  constructor(cfg: RAGConfig = {}) {
    this.cfg = cfg;
  }

  /** Lazily build passages on first retrieve. */
  async ensureBuilt(): Promise<void> {
    if (this.passages !== null) return;
    let content: RAGContent[] = [];

    if (this.cfg.sections && this.cfg.sections.length) {
      content = this.cfg.sections;
    } else if (this.cfg.sourceUrl) {
      try {
        const r = await fetch(this.cfg.sourceUrl);
        if (r.ok) content = await r.json() as RAGContent[];
      } catch { /* fall through */ }
    } else {
      content = this.scrapeFromDOM();
    }

    this.indexPassages(content);
  }

  private scrapeFromDOM(): RAGContent[] {
    if (typeof document === 'undefined') return [];
    const selector = this.cfg.selector;
    let root: Element | null = null;
    if (selector) root = document.querySelector(selector);
    if (!root) root = document.querySelector('main');
    if (!root) root = document.querySelector('article');
    if (!root) {
      // Multiple section elements? Treat each as a section.
      const sections = Array.from(document.querySelectorAll('section'));
      if (sections.length) {
        return sections.map((s, i) => {
          const titleEl = s.querySelector('h1, h2, h3');
          return {
            id: s.id || `section-${i}`,
            title: (titleEl?.textContent || `Section ${i + 1}`).trim(),
            text: this.extractText(s)
          };
        }).filter(s => s.text.length > (this.cfg.minPassageLength ?? 80));
      }
      root = document.body;
    }

    // Within the chosen root, segment by headings.
    return this.segmentByHeadings(root);
  }

  private extractText(el: Element): string {
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll(
      'script, style, noscript, .acolyte-panel, .acolyte-fab, #acolyte-panel, #acolyte-fab, [data-acolyte-ignore]'
    ).forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  private segmentByHeadings(root: Element): RAGContent[] {
    const headings = root.querySelectorAll('h1, h2, h3');
    if (!headings.length) {
      const text = this.extractText(root);
      return text ? [{ id: 'root', title: 'Page', text }] : [];
    }
    const out: RAGContent[] = [];
    const headingArr = Array.from(headings);
    for (let i = 0; i < headingArr.length; i++) {
      const h = headingArr[i];
      const next = headingArr[i + 1];
      const title = (h.textContent || `Section ${i + 1}`).trim();
      const buf: string[] = [];
      let cur: Node | null = h.nextSibling;
      while (cur && cur !== next) {
        if (cur.nodeType === 1 || cur.nodeType === 3) {
          buf.push((cur as Element).textContent || cur.nodeValue || '');
        }
        cur = cur.nextSibling;
      }
      const text = buf.join(' ').replace(/\s+/g, ' ').trim();
      if (text.length > (this.cfg.minPassageLength ?? 80)) {
        // If the heading has no real DOM id, stamp our synthetic one back
        // onto the element so that <ref id="h-N"> markers emitted by the
        // LLM in SPEAK blocks have a real anchor to scroll to. Without
        // this, the auto-scroll-and-highlight feature is a no-op for
        // pages whose authors didn't add id attributes.
        const id = h.id || `acolyte-h-${i}`;
        if (!h.id) (h as HTMLElement).id = id;
        out.push({ id, title, text });
      }
    }
    return out;
  }

  private tokenize(s: string): string[] {
    return s.toLowerCase()
      .replace(/[^a-z0-9_\-/.]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && t.length < 40);
  }

  private splitIntoPassages(text: string, maxChars: number): string[] {
    const parts = text.split(/\n{2,}|(?<=\.)\s+(?=[A-Z])/);
    const out: string[] = [];
    let buf = '';
    for (const p of parts) {
      if ((buf + ' ' + p).length > maxChars && buf) {
        out.push(buf.trim());
        buf = p;
      } else {
        buf = buf ? buf + ' ' + p : p;
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  private indexPassages(sections: RAGContent[]): void {
    this.passages = [];
    this.df = {};
    let totalLen = 0;
    for (const s of sections) {
      const chunks = this.splitIntoPassages(s.text, 600);
      for (const text of chunks) {
        const terms = this.tokenize(text);
        const id = this.passages.length;
        this.passages.push({
          id, sectionId: s.id, sectionTitle: s.title,
          text, terms, len: terms.length
        });
        totalLen += terms.length;
        const seen: Record<string, true> = {};
        for (const t of terms) {
          if (!seen[t]) { this.df[t] = (this.df[t] ?? 0) + 1; seen[t] = true; }
        }
      }
    }
    this.avgLen = this.passages.length ? totalLen / this.passages.length : 0;
  }

  async retrieve(query: string, topN?: number): Promise<{ score: number; passage: Passage }[]> {
    await this.ensureBuilt();
    const N = this.passages?.length ?? 0;
    if (!N) return [];
    const k = topN ?? this.cfg.topK ?? 5;
    const qTerms = this.tokenize(query);
    const scores = new Array(N).fill(0);
    for (const qt of qTerms) {
      const dft = this.df[qt] ?? 0;
      if (!dft) continue;
      const idf = Math.log(1 + (N - dft + 0.5) / (dft + 0.5));
      for (let i = 0; i < N; i++) {
        const p = this.passages![i];
        let tf = 0;
        for (const term of p.terms) if (term === qt) tf++;
        if (!tf) continue;
        const denom = tf + this.k1 * (1 - this.b + this.b * (p.len / (this.avgLen || 1)));
        scores[i] += idf * (tf * (this.k1 + 1)) / denom;
      }
    }
    const floor = this.cfg.scoreFloor ?? 0;
    return scores
      .map((s, i) => ({ score: s, passage: this.passages![i] }))
      .filter(r => r.score > floor)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** Force a rebuild on next retrieve (e.g. after content changed). */
  rebuild(): void { this.passages = null; this.df = {}; }
}
