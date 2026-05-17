/**
 * The chat widget engine — config-driven. Minimal MVP that owns:
 *   - Floating-action-button + side panel
 *   - Provider dispatch via ChatProviders
 *   - Markdown rendering (marked + DOMPurify + KaTeX)
 *   - RAG retrieval via RAGEngine
 *   - TTS via TTSEngine
 *   - Cache + history via ChatDB
 *   - Tools via Tools
 *   - Persona-driven system prompt
 *
 * The full UI parity with the SIO/dspy-course version (history panel,
 * recent strip, drill-down tool blocks, sources footer, voice picker UI,
 * resize handle, keyboard shortcuts) is on the roadmap; this file
 * delivers a working MVP that supports the core ask-page-respond loop
 * with all the underlying engines wired up.
 */

import type {
  AcolyteConfig,
  AcolyteHandle,
  CustomPersona,
  BuiltInPersona
} from './types.js';
import { sendChat, listOllamaModels, type ChatMessage } from './providers/index.js';
import { ChatDB } from './internal/db.js';
import { RAGEngine } from './internal/rag.js';
import { TTSEngine } from './internal/tts.js';
import { Tools } from './tools/index.js';
import { personas } from './personas/index.js';
import { PROMPT_BLOCKS, defaultBlocksFor, type PromptContext } from './prompts/blocks.js';
import {
  loadStoredSettings,
  saveStoredSettings,
  clearStoredSettings,
  listAvailableModels,
  providerLabel
} from './internal/settings.js';
import { PluginHost } from './plugin.js';
import type { RAGContent } from './types.js';

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import renderMathInElement from 'katex/contrib/auto-render';

// Inlined at build time by tsup's `define` — see tsup.config.ts.
// The CSS string lives in src/styles.css; this declares it for TypeScript.
declare const __ACOLYTE_CSS__: string;

let _cssInjected = false;
function injectCSSOnce(): void {
  if (_cssInjected) return;
  _cssInjected = true;
  const tag = document.createElement('style');
  tag.id = 'acolyte-injected-styles';
  tag.setAttribute('data-acolyte', 'true');
  tag.textContent = typeof __ACOLYTE_CSS__ === 'string' ? __ACOLYTE_CSS__ : '';
  document.head.appendChild(tag);
}

function el(tag: string, attrs: Record<string, any> | null = null, children: (Node | string | null | undefined)[] = []): HTMLElement {
  const e = document.createElement(tag);
  if (attrs) for (const k of Object.keys(attrs)) {
    if (k === 'class')      e.className = attrs[k];
    else if (k === 'html')  e.innerHTML = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function resolvePersona(p: BuiltInPersona | CustomPersona | undefined): CustomPersona {
  if (!p) return personas.teacher;
  if (typeof p === 'string') return personas[p] ?? personas.teacher;
  return p;
}

/** Deep merge for runtime config patches. Plain-object only; arrays replace. */
function deepMergeCfg<T extends Record<string, any>>(base: T, patch: any): T {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) return (patch ?? base) as T;
  const out: any = { ...base };
  for (const k of Object.keys(patch)) {
    const bv = (base as any)?.[k];
    const pv = patch[k];
    out[k] = (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv))
      ? deepMergeCfg(bv, pv)
      : pv;
  }
  return out as T;
}

export function createWidget(config: AcolyteConfig): AcolyteHandle {
  // Layer stored user settings on top of caller-supplied config so the
  // last-saved provider/model/voice/etc. survive page reloads.
  let cfg: AcolyteConfig = deepMergeCfg(config, loadStoredSettings(config));
  const db    = new ChatDB(cfg.storage?.dbName ?? 'acolyte-chat');
  const rag   = new RAGEngine(cfg.rag ?? {});
  const tts   = new TTSEngine(cfg.voice ?? {});
  const tools = new Tools(cfg.tools ?? {});
  const pluginHost = new PluginHost();
  for (const p of cfg.plugins ?? []) pluginHost.add(p);

  const state = {
    open: false,
    busy: false,
    history: [] as ChatMessage[],
    convId: null as number | null,
    historyPanelOpen: false,
    lastRagHits: [] as { score: number; passage: any }[],
    currentlySpeakingBtn: null as HTMLElement | null,
    voiceRec: null as any,            // active SpeechRecognition instance
    voiceActive: false,
    voiceBaseline: ''
  };

  /* ───── Markdown rendering ───── */

  function renderMarkdown(text: string): string {
    marked.setOptions({ gfm: true, breaks: true });
    let html = marked.parse(text || '') as string;
    html = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p','br','strong','em','code','pre','ul','ol','li','h1','h2','h3','h4','h5','h6','blockquote','a','hr','table','thead','tbody','tr','th','td','span','div','img','del','svg','g','path','rect','circle','line','polyline','polygon','text','tspan','marker','defs','foreignObject','math','semantics','annotation','annotation-xml','mrow','mi','mo','mn','msup','msub','msubsup','mfrac','msqrt','mroot','mover','munder','munderover','mstyle','mtext','mtable','mtr','mtd','mspace','mpadded','mphantom','menclose'],
      ALLOWED_ATTR: ['href','title','target','rel','class','src','alt','d','x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','width','height','transform','fill','stroke','stroke-width','viewBox','xmlns','points','style','id','marker-end','marker-start','offset','stop-color','dy','dx','text-anchor','font-size','font-family','aria-hidden','aria-label','role','encoding','mathvariant','displaystyle']
    });
    return html;
  }

  function renderMathIn(root: HTMLElement): void {
    try {
      renderMathInElement(root, {
        delimiters: [
          { left: '$$', right: '$$', display: true  },
          { left: '$',  right: '$',  display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true  }
        ],
        throwOnError: false,
        ignoredTags: ['script','noscript','style','textarea','pre','code']
      } as any);
    } catch { /* ignore */ }
  }

  /* ───── System prompt assembly ─────
   *
   * The PURPOSE_BLOCK below is the code-level enforcement of the
   * constitution's principle:
   *
   *   "Acolyte does NOT repeat the page back to the reader. The widget's
   *    job is to supply supplementary, ancillary, or net-new information
   *    grounded in what the reader sees."
   *
   * See: CONSTITUTION.md → Purpose, and docs/personas.md → "The one rule
   * every persona must honor". This block is injected into EVERY system
   * prompt regardless of persona, so a poorly-written custom persona
   * still inherits the behavior.
   */

  /**
   * System prompt is composed from named PROMPT_BLOCKS (src/prompts/blocks.ts).
   * The persona declares an ordered `promptBlocks: string[]` list — or
   * defaults to defaultBlocksFor() when omitted. Each block sees the same
   * PromptContext (persona, enabled tools, RAG + memory contexts). To
   * customize the system prompt for a new domain, write a persona with a
   * different `promptBlocks` list — no widget code change required.
   */
  function buildSystemPrompt(
    question: string,
    ragContext: string,
    memoryContext: string
  ): string {
    const persona = resolvePersona(cfg.persona);
    const enabledTools = tools.enabledNames();
    const ctx: PromptContext = { persona, enabledTools, ragContext, memoryContext, question };
    const blockIds = persona.promptBlocks ?? defaultBlocksFor(persona);
    const parts: string[] = [persona.role];
    for (const id of blockIds) {
      const block = PROMPT_BLOCKS[id];
      if (block) parts.push(block.render(ctx));
    }
    if (persona.extras) parts.push('\n\n' + persona.extras);
    return parts.join('');
  }

  async function buildContextBlock(question: string): Promise<string> {
    const enabled = cfg.rag?.enabled !== false;
    let hits: { score: number; passage: any }[] = enabled ? await rag.retrieve(question) : [];

    // Plugin-supplied RAG sources contribute additional passages — searched
    // through the same BM25 path. Each plugin source is consulted; results
    // are merged + re-ranked.
    const sources = pluginHost.allRAGSources();
    const allowCross = cfg.rag?.crossPageReferences === true;
    for (const src of sources) {
      if (src.crossPage && !allowCross) continue;   // gated by settings switch
      try {
        const sections = await src.fetch({ query: question });
        if (!sections.length) continue;
        const tmpRag = new RAGEngine({ sections, topK: 5 });
        const extra = await tmpRag.retrieve(question);
        for (const h of extra) {
          (h.passage as any).sourceName = src.name;
          (h.passage as any).pageUrl = src.pageUrl?.(sections.find(s => s.id === (h.passage as any).sectionId)!);
        }
        hits = hits.concat(extra);
      } catch (e) { /* plugin source failed — skip */ }
    }
    hits.sort((a, b) => b.score - a.score);
    // Dedupe near-identical passages. The same section can show up multiple
    // times — once from the DOM scan of the host page, once from each
    // plugin source — which crowds out higher-quality, more diverse hits.
    // Fingerprint by section title + first 80 chars of body; keep the
    // highest-scoring instance. Cross-page hits beat same-page only when
    // their score is meaningfully higher, since duplicates from the
    // current page are usually preferable for in-page navigation.
    const seen = new Map<string, { score: number; passage: any }>();
    const normTitle = (t: string): string =>
      (t ?? '').toLowerCase()
        .replace(/^\s*[—–\-]\s*/, '')          // leading dash from "PageTitle — Section"
        .replace(/^\s*[a-z0-9 ]*?\s+[—–\-]\s+/, '')  // strip "Page Title — " prefix entirely
        .replace(/\s+/g, ' ').trim();
    for (const h of hits) {
      const key = normTitle(h.passage.sectionTitle ?? '') + '|' +
                  (h.passage.text ?? '').slice(0, 120).replace(/\s+/g, ' ').trim().toLowerCase();
      const prev = seen.get(key);
      if (!prev) { seen.set(key, h); continue; }
      // Prefer same-page over cross-page on ties (better UX — no page change)
      const prevIsCross = !!(prev.passage as any).pageUrl;
      const curIsCross  = !!(h.passage    as any).pageUrl;
      if (prevIsCross && !curIsCross) { seen.set(key, h); continue; }
      if (!prevIsCross && curIsCross) continue;
      if (h.score > prev.score) seen.set(key, h);
    }
    hits = [...seen.values()].sort((a, b) => b.score - a.score);
    hits = hits.slice(0, cfg.rag?.topK ?? 7);
    state.lastRagHits = hits;
    if (!hits.length) return '';
    const lines = ['===== RELEVANT PASSAGES ====='];
    hits.forEach((h, i) => {
      const src  = (h.passage as any).sourceName ? ` (${(h.passage as any).sourceName})` : '';
      const url  = (h.passage as any).pageUrl    ? ` — ${(h.passage as any).pageUrl}` : '';
      // Surface the DOM section id so the SPEAK block can emit
      // <ref id="..."> markers — the widget watches for those during
      // TTS playback and scrolls/highlights the matching element.
      const sid  = (h.passage as any).sectionId   ? ` {id="${(h.passage as any).sectionId}"}` : '';
      lines.push(`[${i + 1}]${sid} ${h.passage.sectionTitle}${src}${url}`);
      lines.push(h.passage.text);
      lines.push('');
    });
    return lines.join('\n');
  }

  /* ───── DOM construction ───── */

  let fab: HTMLElement;
  let panel: HTMLElement;
  let messagesBox: HTMLElement;
  let inputEl: HTMLTextAreaElement;
  let statusEl: HTMLElement;
  let modelPickerEl: HTMLSelectElement;
  let settingsEl: HTMLElement;
  let historyPanelEl: HTMLElement;
  let recentStripEl: HTMLElement;
  let micBtnEl: HTMLElement;
  let settingsOpen = false;

  function buildPanel(): void {
    fab = el('button', {
      class: 'acolyte-fab',
      onclick: () => toggle(true),
      title: 'Open chat'
    }, [cfg.ui?.fabIcon ?? '💬']);

    statusEl = el('span', { class: 'acolyte-status' }, ['…']);
    modelPickerEl = el('select', {
      class: 'acolyte-model-picker',
      title: 'Switch model',
      onchange: (e: Event) => onModelChange((e.target as HTMLSelectElement).value)
    }, [el('option', { value: '' }, ['loading…'])]) as HTMLSelectElement;

    // Slim header: brand icon + model picker (which doubles as status) +
    // new conversation + settings + close. History panel and width cycle
    // moved into the settings menu / use the drag-resize handle. The whole
    // thing is intentionally minimal because the header is a small section
    // and was getting crowded.
    const brand = el('span', { class: 'acolyte-brand', title: 'Acolyte' }, [cfg.ui?.fabIcon ?? '💬']);
    const header = el('div', { class: 'acolyte-header' }, [
      brand,
      modelPickerEl,
      el('button', { class: 'acolyte-iconbtn', onclick: clearHistory, title: 'New conversation' }, ['+']),
      el('button', { class: 'acolyte-iconbtn', onclick: toggleSettings, title: 'Settings (provider, model, voice, history, …)' }, ['⚙']),
      el('button', { class: 'acolyte-iconbtn', onclick: () => toggle(false), title: 'Close' }, ['×'])
    ]);
    // Status pill is kept in the DOM tree but tucked into the model picker
    // tooltip so we don't double-display the same info.
    statusEl.style.display = 'none';
    settingsEl = buildSettingsPanel();
    historyPanelEl = buildHistoryPanel();
    messagesBox = el('div', { class: 'acolyte-messages' });

    micBtnEl = el('button', {
      class: 'acolyte-iconbtn acolyte-mic',
      title: 'Voice input (Web Speech API)',
      onclick: toggleVoiceInput
    }, ['🎤']);
    inputEl = el('textarea', {
      class: 'acolyte-input',
      placeholder: 'Ask anything… (Shift+Enter for newline)',
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(inputEl.value); }
      }
    }) as HTMLTextAreaElement;
    const sendBtn = el('button', { class: 'acolyte-send', onclick: () => send(inputEl.value) }, ['Send']);
    const inputRow = el('div', { class: 'acolyte-input-row' }, [micBtnEl, inputEl, sendBtn]);

    recentStripEl = el('div', { class: 'acolyte-recent-strip' });

    const resizeHandle = el('div', {
      class: 'acolyte-resize-handle',
      title: 'Drag to resize'
    });

    panel = el('aside', { class: 'acolyte-panel', id: 'acolyte-panel' }, [
      resizeHandle, header, settingsEl, historyPanelEl,
      messagesBox, recentStripEl, inputRow
    ]);

    // Hook up the drag-resize handle to let the user fine-tune width.
    wireResizeHandle(resizeHandle, panel);

    // Apply persisted width preset
    const savedSize = localStorage.getItem('acolyte-panel-size') || '';
    if (savedSize === 'wide' || savedSize === 'full') panel.classList.add('size-' + savedSize);
    const savedWidth = parseInt(localStorage.getItem('acolyte-panel-width') ?? '', 10);
    if (!savedSize && savedWidth && savedWidth > 280) panel.style.width = savedWidth + 'px';

    // Auto-inject the bundled CSS unless the caller opts out (SSR / custom build).
    if (cfg.ui?.autoInjectCss !== false) injectCSSOnce();

    // Apply ui.accent if provided — sets a CSS custom property on the root.
    if (cfg.ui?.accent) {
      document.documentElement.style.setProperty('--acolyte-accent', cfg.ui.accent);
    }

    const target = document.querySelector(cfg.ui?.targetSelector ?? 'body') ?? document.body;
    target.appendChild(fab);
    target.appendChild(panel);

    // keyboard shortcut
    const sc = (cfg.ui?.keyboardShortcut ?? 'mod+k').toLowerCase();
    document.addEventListener('keydown', (e) => {
      const wantsMod = sc.includes('mod') || sc.includes('ctrl') || sc.includes('cmd');
      const isMod = e.ctrlKey || e.metaKey;
      if (wantsMod && isMod && e.key.toLowerCase() === sc.slice(-1)) {
        e.preventDefault(); toggle(!state.open);
      }
      if (e.key === 'Escape' && state.open) toggle(false);
    });
  }

  function toggle(open?: boolean): void {
    state.open = open === undefined ? !state.open : !!open;
    panel.classList.toggle('open', state.open);
    if (state.open) {
      probe();
      refreshRecentStrip();
      if (!state.history.length) renderWelcome();
      setTimeout(() => inputEl.focus(), 50);
    }
  }

  function clearHistory(): void {
    state.history = [];
    state.convId = null;
    messagesBox.innerHTML = '';
    renderWelcome();
  }

  function renderWelcome(): void {
    const persona = resolvePersona(cfg.persona);
    const greeting = persona.greeting ?? 'Hi — ask me anything.';
    appendMsg('assistant', greeting);
  }

  function appendMsg(role: 'user' | 'assistant' | 'tool' | 'system', content: string): HTMLElement {
    const m = el('div', { class: `acolyte-msg ${role}` });
    (m as any).dataset.raw = content;
    // Render markdown into a child wrapper so that subsequent stream
    // updates (which rewrite the body innerHTML) don't blow away
    // siblings like the 🔊 button or the sources footer.
    const body = el('div', { class: 'acolyte-msg-body' }) as HTMLElement;
    m.appendChild(body);
    setMsgContent(m, content, role);
    if (role === 'assistant' && tts.supported) {
      // Per-message 🔊 button — speaks the SPEAK block (or a stripped fallback).
      const speakBtn = el('button', {
        class: 'acolyte-msg-speak',
        title: 'Speak this',
        onclick: (e: Event) => { e.stopPropagation(); speakAssistantMessage(m, speakBtn); }
      }, ['🔊']);
      m.appendChild(speakBtn);
    }
    messagesBox.appendChild(m);
    messagesBox.scrollTop = messagesBox.scrollHeight;
    pluginHost.runOnMessageRender(m, { role, content });
    return m;
  }

  /** Update the raw payload on a streaming assistant bubble so per-message
   *  speak / sources / etc. operate on the FINAL text, not the partial one. */
  function updateAssistantRaw(node: HTMLElement, full: string): void {
    (node as any).dataset.raw = full;
  }

  /* ───── TTS — per-message speak + auto-speak ───── */

  function speakAssistantMessage(node: HTMLElement, btn: HTMLElement): void {
    if (!tts.supported) return;
    // Toggle: same button → stop (works in any state, incl. queued)
    if (state.currentlySpeakingBtn === btn) {
      tts.cancel();
      btn.classList.remove('playing');
      btn.classList.remove('queued');
      btn.title = 'Speak this';
      (node as any).dataset.pendingSpeak = '';
      state.currentlySpeakingBtn = null;
      return;
    }
    // If the bubble is still streaming, queue speech for stream-end. The
    // speak module is a COMMENTARY (SPEAK block), not a transcript read —
    // narrating mid-stream would just speak a fragment.
    if ((node as any).dataset.streaming === '1') {
      if (state.currentlySpeakingBtn) state.currentlySpeakingBtn.classList.remove('playing');
      state.currentlySpeakingBtn = btn;
      btn.classList.remove('playing');
      btn.classList.add('queued');
      btn.title = 'Queued — will speak when answer is complete';
      (node as any).dataset.pendingSpeak = '1';
      return;
    }
    const raw = (node as any).dataset.raw || node.textContent || '';
    const text = tts.spokenVersionFromMarkdown(raw);
    if (!text) return;
    if (state.currentlySpeakingBtn) state.currentlySpeakingBtn.classList.remove('playing');
    state.currentlySpeakingBtn = btn;
    btn.classList.remove('queued');
    btn.classList.add('playing');
    btn.title = 'Stop';
    // Fresh visited-set per playback so a replay re-points at the same
    // first-mention sections in the same order. Orientation budget also
    // resets — one orienting scroll allowed per speech.
    followAlongVisited = new Set<string>();
    followAlongOrientPending = true;
    tts.speak(text, {
      onRef: (id: string) => followAlongTo(id),
      onEnd: () => {
        btn.classList.remove('playing');
        btn.title = 'Speak this';
        clearFollowAlong();
        if (state.currentlySpeakingBtn === btn) state.currentlySpeakingBtn = null;
      }
    }).catch(() => { btn.classList.remove('playing'); btn.title = 'Speak this'; clearFollowAlong(); });
  }

  /** Currently-glowing element from the voice-follow handler (so we can
   *  unglow when the voice moves on or playback ends). */
  let followAlongEl: HTMLElement | null = null;
  /** Ids already pointed at during the current speech — voice-follow only
   *  navigates on FIRST mention so the page doesn't ping-pong if the
   *  voice circles back to a section it's already discussed. */
  let followAlongVisited = new Set<string>();
  /** True until the first ref of the current speech has been handled.
   *  Used to allow exactly ONE orientation scroll per speech; after that
   *  the reader can roam freely and refs only glow. */
  let followAlongOrientPending = true;

  function followAlongTo(id: string): void {
    if (!id) return;
    if (followAlongVisited.has(id)) return;   // already pointed at this one
    const target = document.getElementById(id);
    if (!target) return;
    followAlongVisited.add(id);
    clearFollowAlong();
    followAlongEl = target;
    // One-shot fade animation — class removes itself after the keyframes
    // finish. No continuous pulse; the gesture is "look here for a moment"
    // and then the voice carries the reader.
    target.classList.add('acolyte-following-voice');
    // Scroll policy — do NOT yank the reader around. They might be
    // exploring while the voice talks. Rules:
    //  1. On the FIRST ref of the speech, orient them by scrolling — but
    //     only if the section is fully offscreen. If any part is visible,
    //     trust they can already see it (or hear which one we mean).
    //  2. On subsequent refs, never scroll. Just glow. The reader chooses
    //     whether to follow with the keyboard / mouse.
    if (followAlongOrientPending && isOffscreen(target)) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    followAlongOrientPending = false;
  }

  function isOffscreen(el: HTMLElement): boolean {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return r.bottom < 0 || r.top > vh;
  }

  function clearFollowAlong(): void {
    if (followAlongEl) {
      followAlongEl.classList.remove('acolyte-following-voice');
      followAlongEl = null;
    }
    // Note: visited-set is NOT cleared here — it's cleared at the START
    // of each new speech in speakAssistantMessage, so multiple replays
    // of the same answer each get their own first-mention behavior.
  }

  /** Mark a bubble as no-longer-streaming and flush any queued speak. */
  function finalizeStreamingBubble(node: HTMLElement | null): void {
    if (!node) return;
    (node as any).dataset.streaming = '';
    if ((node as any).dataset.pendingSpeak === '1') {
      (node as any).dataset.pendingSpeak = '';
      const btn = node.querySelector('.acolyte-msg-speak') as HTMLElement | null;
      if (btn) speakAssistantMessage(node, btn);
    }
  }

  function maybeAutoSpeak(node: HTMLElement): void {
    if (!cfg.voice?.autoSpeak) return;
    const btn = node.querySelector('.acolyte-msg-speak') as HTMLElement | null;
    if (btn) speakAssistantMessage(node, btn);
  }

  /* ───── Voice input (Web Speech API) ───── */

  function getSpeechRecognitionCtor(): any {
    return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || null;
  }

  function toggleVoiceInput(): void {
    const SR = getSpeechRecognitionCtor();
    if (!SR) {
      note('Voice input not supported in this browser. Try Chrome, Edge, Safari, or Android.');
      micBtnEl.style.opacity = '0.4';
      return;
    }
    if (state.voiceActive && state.voiceRec) {
      try { state.voiceRec.stop(); } catch { /* ignore */ }
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    state.voiceBaseline = (inputEl.value || '').replace(/\s+$/, '');
    rec.onstart = () => {
      state.voiceActive = true;
      micBtnEl.classList.add('listening');
      micBtnEl.title = 'Listening… click to stop';
    };
    rec.onresult = (ev: any) => {
      let finalText = '';
      let interimText = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      if (finalText) state.voiceBaseline = (state.voiceBaseline ? state.voiceBaseline + ' ' : '') + finalText.trim();
      const combined = state.voiceBaseline + (interimText ? (state.voiceBaseline ? ' ' : '') + interimText : '');
      inputEl.value = combined;
      inputEl.scrollTop = inputEl.scrollHeight;
    };
    rec.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') note('Mic permission denied. Allow it in the address bar.');
      else if (e.error === 'no-speech') note('No speech detected.');
      else if (e.error !== 'aborted') note('Voice error: ' + e.error);
    };
    rec.onend = () => {
      state.voiceActive = false;
      micBtnEl.classList.remove('listening');
      micBtnEl.title = 'Voice input (Web Speech API)';
    };
    state.voiceRec = rec;
    try { rec.start(); } catch (e: any) { note('Voice failed: ' + e.message); }
  }

  /* ───── Drill-down tool block ───── */

  interface ToolCallHandle {
    finish(result: string, isError?: boolean, fromCache?: boolean): void;
  }
  function appendToolCall(name: string, args: any, opts: { label?: string } = {}): ToolCallHandle {
    const verbose = !!cfg.tools?.verbose;
    const label = opts.label ?? 'tool';
    let argText = '';
    try { argText = typeof args === 'string' ? args : JSON.stringify(args, null, 2); }
    catch { argText = String(args); }
    const oneLine = (typeof args === 'string'
      ? args
      : Object.keys(args ?? {}).map(k => `${k}=${JSON.stringify(args[k]).slice(0, 50)}`).join(', ')
    ).slice(0, 80);

    const wrap = el('div', { class: 'acolyte-tool-call' + (verbose ? ' expanded' : '') });
    const header = el('button', {
      class: 'atc-head',
      onclick: () => wrap.classList.toggle('expanded')
    }, [
      el('span', { class: 'atc-arrow' }, ['▸']),
      el('span', { class: 'atc-tag' }, [label]),
      el('span', { class: 'atc-name' }, [name]),
      el('span', { class: 'atc-args-preview' }, [`(${oneLine}${oneLine.length >= 80 ? '…' : ''})`]),
      el('span', { class: 'atc-status' }, ['…running'])
    ]);
    const body = el('div', { class: 'atc-body' }, [
      el('div', { class: 'atc-section-label' }, ['REQUEST']),
      el('pre', { class: 'atc-pre' }, [argText]),
      el('div', { class: 'atc-section-label' }, ['RESPONSE']),
      el('pre', { class: 'atc-pre atc-result' }, ['(waiting…)'])
    ]);
    wrap.append(header, body);
    messagesBox.appendChild(wrap);
    messagesBox.scrollTop = messagesBox.scrollHeight;

    const started = performance.now();
    return {
      finish(result: string, isError = false, fromCache = false) {
        const dur = Math.round(performance.now() - started);
        const statusElx = header.querySelector('.atc-status');
        if (statusElx) {
          statusElx.textContent = `${isError ? '✗' : '✓'} ${dur} ms${fromCache ? ' · 📦 cached' : ''}`;
          statusElx.className = 'atc-status ' + (isError ? 'err' : 'ok');
        }
        const resultEl = body.querySelector('.atc-result');
        if (resultEl) resultEl.textContent = result || '(empty)';
        if (isError) wrap.classList.add('errored');
      }
    };
  }

  /* ───── Sources footer ───── */

  function appendSourcesFooter(bubble: HTMLElement, hits: { score: number; passage: any }[]): void {
    if (!bubble || !hits?.length) return;
    const verbose = !!cfg.tools?.verbose;
    const wrap = el('div', { class: 'acolyte-sources' + (verbose ? ' expanded' : '') });
    const summary = hits.slice(0, 3).map(h => (h.passage.sectionTitle || '').slice(0, 24)).join(' · ');
    const head = el('button', {
      class: 'src-head',
      onclick: () => wrap.classList.toggle('expanded')
    }, [
      el('span', { class: 'src-arrow' }, ['▸']),
      el('span', { class: 'src-tag' }, ['📚 sources']),
      el('span', { class: 'src-count' }, [`${hits.length} passages`]),
      el('span', { class: 'src-summary' }, [summary + (hits.length > 3 ? ' · …' : '')])
    ]);
    const body = el('div', { class: 'src-body' });
    hits.forEach((h, i) => {
      const url = (h.passage as any).pageUrl as string | undefined;
      const isCrossPage = !!url && !url.startsWith('#') && !sameDoc(url);
      const originLabel = isCrossPage ? prettyOrigin(url!) : null;
      const card = el('button', {
        class: 'src-card' + (isCrossPage ? ' cross-page' : ''),
        title: isCrossPage
          ? `Open ${originLabel} → ${h.passage.sectionTitle ?? ''}`
          : 'Jump to ' + (h.passage.sectionTitle ?? ''),
        onclick: () => jumpToSource(h)
      }, [
        el('div', { class: 'src-card-head' }, [
          el('span', { class: 'src-num' }, [String(i + 1)]),
          el('span', { class: 'src-title' }, [h.passage.sectionTitle ?? '']),
          el('span', { class: 'src-score' }, [`score ${h.score.toFixed(2)}`]),
          el('span', { class: 'src-jump' }, [isCrossPage ? '↗' : '↗'])
        ]),
        ...(isCrossPage ? [el('div', { class: 'src-origin' }, [
          el('span', { class: 'src-origin-icon' }, ['📄']),
          el('span', null, [originLabel ?? ''])
        ])] : []),
        el('div', { class: 'src-text' }, [
          (h.passage.text ?? '').slice(0, 320) + ((h.passage.text ?? '').length > 320 ? '…' : '')
        ])
      ]);
      body.appendChild(card);
    });
    wrap.append(head, body);
    bubble.appendChild(wrap);
  }

  function jumpToSource(hit: { passage: any }): void {
    const url = hit.passage.pageUrl as string | undefined;
    // Cross-page hit → navigate to that page (carries the anchor, if any).
    if (url && !sameDoc(url)) {
      window.location.href = url;
      return;
    }
    const sid = hit.passage.sectionId;
    if (!sid) return;
    const target = document.getElementById(sid);
    if (!target) return;
    if (panel.classList.contains('size-full')) {
      panel.classList.remove('size-full');
      panel.style.width = '';
      try { localStorage.setItem('acolyte-panel-size', ''); } catch { /* ignore */ }
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('acolyte-src-flash');
    setTimeout(() => target.classList.remove('acolyte-src-flash'), 1600);
  }

  /** True if `url` refers to the page the widget is mounted in (anchors
   *  count as same-doc). */
  function sameDoc(url: string): boolean {
    try {
      const u = new URL(url, window.location.href);
      return u.origin === window.location.origin && u.pathname === window.location.pathname;
    } catch { return true; }
  }

  /** Compact label for the page a cross-page citation came from.
   *  /modules/05-optimizers.html → "Module 5 — Optimizers" */
  function prettyOrigin(url: string): string {
    try {
      const u = new URL(url, window.location.href);
      const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
      const stem = last.replace(/\.html?$/i, '').replace(/^\d+[-_]/, m => `Module ${m.replace(/[^0-9]/g, '')} — `);
      return stem.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || last;
    } catch { return url; }
  }

  /* ───── Width controls ───── */

  function cyclePanelSize(): void {
    let next: string;
    if (panel.classList.contains('size-full'))      next = 'narrow';
    else if (panel.classList.contains('size-wide')) next = 'full';
    else                                            next = 'wide';
    panel.classList.remove('size-wide', 'size-full');
    panel.style.width = '';
    if (next === 'wide') panel.classList.add('size-wide');
    if (next === 'full') panel.classList.add('size-full');
    try {
      localStorage.setItem('acolyte-panel-size', next === 'narrow' ? '' : next);
      localStorage.removeItem('acolyte-panel-width');
    } catch { /* ignore */ }
    note(`Width: ${next}`);
  }

  function wireResizeHandle(handle: HTMLElement, panelEl: HTMLElement): void {
    let dragging = false, startX = 0, startW = 0;
    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      if (panelEl.classList.contains('size-full')) return;
      dragging = true;
      startX = e.clientX;
      startW = panelEl.getBoundingClientRect().width;
      handle.classList.add('dragging');
      panelEl.style.transition = 'none';
      try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    handle.addEventListener('pointermove', (e: PointerEvent) => {
      if (!dragging) return;
      const delta = startX - e.clientX;
      const w = Math.max(320, Math.min(window.innerWidth, startW + delta));
      panelEl.style.width = w + 'px';
      panelEl.classList.remove('size-wide', 'size-full');
    });
    handle.addEventListener('pointerup', (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      panelEl.style.transition = '';
      const w = parseInt(panelEl.style.width, 10);
      try {
        localStorage.setItem('acolyte-panel-width', String(w));
        localStorage.removeItem('acolyte-panel-size');
      } catch { /* ignore */ }
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    });
  }

  /* ───── History panel + recent strip ───── */

  function buildHistoryPanel(): HTMLElement {
    return el('div', { class: 'acolyte-history-panel' }, [
      el('div', { class: 'ahp-bar' }, [
        el('strong', null, ['Past conversations']),
        el('span', { class: 'ahp-stats', id: 'acolyte-cache-stats' }, ['']),
        el('button', { class: 'acolyte-btn-ghost', onclick: () => { state.historyPanelOpen = false; historyPanelEl.classList.remove('open'); } }, ['Close'])
      ]),
      el('div', { class: 'ahp-list', id: 'acolyte-history-list' })
    ]);
  }

  async function toggleHistoryPanel(): Promise<void> {
    state.historyPanelOpen = !state.historyPanelOpen;
    historyPanelEl.classList.toggle('open', state.historyPanelOpen);
    if (state.historyPanelOpen) await refreshHistoryPanel();
  }

  async function refreshHistoryPanel(): Promise<void> {
    const listEl = historyPanelEl.querySelector('#acolyte-history-list') as HTMLElement;
    const statsEl = historyPanelEl.querySelector('#acolyte-cache-stats') as HTMLElement;
    listEl.innerHTML = '';
    try {
      const stats = await db.cacheStats();
      statsEl.textContent = stats.count
        ? `Cache: ${stats.count} entries · ${stats.hits} hits · ${Math.round(stats.bytes / 1024)} KB`
        : 'Cache: empty';
    } catch { statsEl.textContent = ''; }
    const convos = await db.listConversations(50);
    if (!convos.length) {
      listEl.appendChild(el('div', { class: 'ahp-empty' }, ['No past conversations yet.']));
      return;
    }
    convos.forEach(c => {
      const row = el('div', {
        class: 'ahp-item',
        onclick: () => loadConversation(c.id)
      }, [
        el('div', { class: 'ahp-title' }, [c.title || '(no title)']),
        el('div', { class: 'ahp-meta' }, [
          `${c.provider || 'ollama'} · ${c.model || '?'} · ${c.messageCount} msg · ` +
          new Date(c.updatedAt).toLocaleString()
        ]),
        el('button', {
          class: 'ahp-del', title: 'Delete',
          onclick: (e: Event) => {
            e.stopPropagation();
            db.deleteConversation(c.id).then(refreshHistoryPanel);
          }
        }, ['×'])
      ]);
      listEl.appendChild(row);
    });
  }

  async function loadConversation(id: number): Promise<void> {
    const conv = await db.getConversation(id);
    if (!conv) return;
    state.convId = id;
    state.history = (conv.messages || []).slice() as ChatMessage[];
    messagesBox.innerHTML = '';
    state.history.forEach(m => {
      if (m.role === 'system') return;
      appendMsg(m.role as any, m.content);
    });
    state.historyPanelOpen = false;
    historyPanelEl.classList.remove('open');
    refreshRecentStrip();
    note(`Loaded "${conv.title || 'conversation'}"`);
  }

  async function refreshRecentStrip(): Promise<void> {
    if (cfg.storage?.historyEnabled === false) { recentStripEl.innerHTML = ''; return; }
    try {
      const convos = await db.listConversations(6);
      recentStripEl.innerHTML = '';
      if (!convos.length) return;
      recentStripEl.appendChild(el('span', { class: 'ars-label' }, ['Recent:']));
      convos.forEach(c => {
        const chip = el('button', {
          class: 'ars-chip' + (state.convId === c.id ? ' current' : ''),
          title: `${c.model || '?'} · ${new Date(c.updatedAt).toLocaleString()}`,
          onclick: () => loadConversation(c.id)
        }, [(c.title || '…').slice(0, 32)]);
        recentStripEl.appendChild(chip);
      });
    } catch { /* ignore */ }
  }

  function setMsgContent(node: HTMLElement, text: string, role: string): void {
    let visible = text || '';
    if (role === 'assistant') visible = tts.stripSpeakBlock(visible);
    // Write into .acolyte-msg-body if present (post-refactor bubbles);
    // fall back to the bubble itself for older callers.
    const body = (node.querySelector(':scope > .acolyte-msg-body') as HTMLElement | null) ?? node;
    if (role === 'assistant' || role === 'tool') {
      body.innerHTML = renderMarkdown(visible);
      renderMathIn(body);
    } else {
      body.textContent = visible;
    }
  }

  /* ───── Provider probe / status + inline model picker ───── */

  async function probe(): Promise<void> {
    const llm = cfg.llm;
    const label = providerLabel(llm);
    try {
      const models = await listAvailableModels(llm);
      if (!(llm as any).model && models.length) (llm as any).model = models[0].name;
      modelPickerEl.innerHTML = '';
      if (models.length) {
        for (const m of models) {
          const opt = document.createElement('option');
          opt.value = m.name; opt.textContent = m.name;
          if (m.name === (llm as any).model) opt.selected = true;
          modelPickerEl.appendChild(opt);
        }
        modelPickerEl.disabled = false;
        modelPickerEl.title = `${label} · ${(llm as any).model ?? '?'} — click to switch`;
        modelPickerEl.classList.remove('err');
      } else {
        const opt = document.createElement('option');
        opt.value = ''; opt.textContent = `${label} · unreachable`;
        modelPickerEl.appendChild(opt);
        modelPickerEl.disabled = true;
        modelPickerEl.classList.add('err');
      }
    } catch {
      modelPickerEl.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = `${label} · error`;
      modelPickerEl.appendChild(opt);
      modelPickerEl.classList.add('err');
    }
  }

  function onModelChange(name: string): void {
    if (!name) return;
    (cfg.llm as any).model = name;
    saveStoredSettings(config, { llm: { ...cfg.llm } } as Partial<AcolyteConfig>);
    modelPickerEl.title = `${providerLabel(cfg.llm)} · ${name} — click to switch`;
    note(`Switched to ${name}`);
  }

  function note(text: string): void {
    const box = messagesBox;
    if (!box) return;
    const m = el('div', { class: 'acolyte-msg system-note' });
    m.textContent = text;
    box.appendChild(m);
    box.scrollTop = box.scrollHeight;
    setTimeout(() => m.remove(), 2500);
  }

  /* ───── Settings panel ───── */

  function toggleSettings(): void {
    settingsOpen = !settingsOpen;
    settingsEl.classList.toggle('open', settingsOpen);
    if (settingsOpen) refreshSettingsPanel();
  }

  function buildSettingsPanel(): HTMLElement {
    return el('div', { class: 'acolyte-settings', id: 'acolyte-settings' });
  }

  function refreshSettingsPanel(): void {
    settingsEl.innerHTML = '';
    const llm: any = cfg.llm;
    const v = cfg.voice ?? {};
    const t = cfg.tools ?? {};
    const s = cfg.storage ?? {};

    const providerSelect = el('select', { id: 'as-provider', class: 'acolyte-input2' }, [
      ['ollama', 'Ollama (local LAN)'],
      ['openai-compatible', 'OpenAI-compatible (proxies / Gemini)'],
      ['openai', 'OpenAI (cloud)'],
      ['anthropic', 'Anthropic Claude (cloud)']
    ].map(([id, label]) => {
      const o = document.createElement('option');
      o.value = id; o.textContent = label;
      if (id === llm.provider) o.selected = true;
      return o;
    })) as HTMLSelectElement;

    settingsEl.append(
      el('div', { class: 'as-section-title' }, ['Provider']),
      el('label', { class: 'as-row' }, ['Provider ', providerSelect]),
      el('label', { class: 'as-row' }, ['Host / base URL ',
        el('input', { id: 'as-baseurl', type: 'text', class: 'acolyte-input2',
          value: llm.host ?? llm.baseUrl ?? '',
          placeholder: 'http://localhost:11434 or http://localhost:8767/gemini/v1beta/openai' })
      ]),
      el('label', { class: 'as-row' }, ['Model ',
        el('input', { id: 'as-model', type: 'text', class: 'acolyte-input2',
          value: llm.model ?? '', placeholder: '(auto)' })
      ]),
      el('label', { class: 'as-row' }, ['API key ',
        el('input', { id: 'as-apikey', type: 'password', class: 'acolyte-input2',
          value: llm.apiKey ?? '', placeholder: 'leave blank if proxy supplies it' })
      ]),

      el('div', { class: 'as-section-title' }, ['Persona']),
      el('label', { class: 'as-row' }, ['Persona ',
        (() => {
          const sel = el('select', { id: 'as-persona', class: 'acolyte-input2' }, [
            ['teacher', 'Teacher (default)'],
            ['docs', 'Docs assistant'],
            ['business', 'Business support'],
            ['bare', 'Bare (minimal)']
          ].map(([id, label]) => {
            const o = document.createElement('option');
            o.value = id; o.textContent = label;
            if (id === (typeof cfg.persona === 'string' ? cfg.persona : 'teacher')) o.selected = true;
            return o;
          })) as HTMLSelectElement;
          return sel;
        })()
      ]),

      el('div', { class: 'as-section-title' }, ['Voice (text-to-speech)']),
      el('label', { class: 'as-row' }, ['Engine ',
        (() => {
          const sel = el('select', { id: 'as-voice-engine', class: 'acolyte-input2' }, [
            ['webspeech', 'Web Speech API (default — instant, OS voices)'],
            ['kokoro',    'Kokoro neural TTS (~80 MB first load, natural voice, offline after)'],
            ['auto',      'Auto (Kokoro if WebGPU is available, else Web Speech)']
          ].map(([code, label]) => {
            const o = document.createElement('option');
            o.value = code; o.textContent = label;
            if (code === (v.engine ?? 'webspeech')) o.selected = true;
            return o;
          })) as HTMLSelectElement;
          return sel;
        })()
      ]),
      el('div', { class: 'as-checkboxes' }, [
        el('label', null, [
          el('input', { id: 'as-voice-auto', type: 'checkbox', ...(v.autoSpeak ? { checked: 'checked' } : {}) }),
          ' Auto-speak every reply'
        ])
      ]),
      el('div', { class: 'as-row-2col' }, [
        el('label', null, ['Accent ',
          (() => {
            const sel = el('select', { id: 'as-voice-accent', class: 'acolyte-input2' }, [
              ['en-GB','British'], ['en-US','American'], ['en-AU','Australian'], ['en-IN','Indian']
            ].map(([code, label]) => {
              const o = document.createElement('option');
              o.value = code; o.textContent = label;
              if (code === (v.accent ?? 'en-GB')) o.selected = true;
              return o;
            })) as HTMLSelectElement;
            return sel;
          })()
        ]),
        el('label', null, ['Gender ',
          (() => {
            const sel = el('select', { id: 'as-voice-gender', class: 'acolyte-input2' }, [
              ['male','Male'], ['female','Female']
            ].map(([code, label]) => {
              const o = document.createElement('option');
              o.value = code; o.textContent = label;
              if (code === (v.gender ?? 'male')) o.selected = true;
              return o;
            })) as HTMLSelectElement;
            return sel;
          })()
        ])
      ]),
      el('label', { class: 'as-row' }, ['Speech rate ',
        el('input', { id: 'as-voice-rate', type: 'number', class: 'acolyte-input2',
          min: '0.5', max: '2', step: '0.1', value: String(v.rate ?? 1.0) })
      ]),

      el('div', { class: 'as-section-title' }, ['Tools']),
      el('div', { class: 'as-checkboxes' }, [
        el('label', null, [
          el('input', { id: 'as-tool-gem', type: 'checkbox', ...(t.geminiResearch?.apiKey ? { checked: 'checked' } : {}) }),
          ' Gemini grounded research'
        ]),
        el('label', null, [
          el('input', { id: 'as-tool-ctx7', type: 'checkbox', ...(t.context7?.enabled !== false ? { checked: 'checked' } : {}) }),
          ' Context7 live docs'
        ]),
        el('label', null, [
          el('input', { id: 'as-tool-deep', type: 'checkbox', ...(t.deepAnalysis?.apiKey ? { checked: 'checked' } : {}) }),
          ' Gemini deep analysis'
        ]),
        el('label', null, [
          el('input', { id: 'as-tool-verbose', type: 'checkbox', ...(t.verbose ? { checked: 'checked' } : {}) }),
          ' Verbose tool drill-down (auto-expand)'
        ])
      ]),

      el('div', { class: 'as-section-title' }, ['References & RAG']),
      el('div', { class: 'as-checkboxes' }, [
        el('label', null, [
          el('input', { id: 'as-rag-cards', type: 'checkbox',
            ...((cfg.rag?.showSourceCards !== false) ? { checked: 'checked' } : {}) }),
          ' Show source-citation cards under each answer (📚)'
        ]),
        el('label', null, [
          el('input', { id: 'as-rag-cross', type: 'checkbox',
            ...((cfg.rag?.crossPageReferences) ? { checked: 'checked' } : {}) }),
          ' Use cross-page references (pull passages from other pages of this site, and let citations link there)'
        ])
      ]),

      el('div', { class: 'as-section-title' }, ['Storage (IndexedDB)']),
      el('div', { class: 'as-checkboxes' }, [
        el('label', null, [
          el('input', { id: 'as-cache', type: 'checkbox', ...(s.cacheEnabled !== false ? { checked: 'checked' } : {}) }),
          ' Cache LLM responses (instant repeats)'
        ]),
        el('label', null, [
          el('input', { id: 'as-history', type: 'checkbox', ...(s.historyEnabled !== false ? { checked: 'checked' } : {}) }),
          ' Persist conversation history'
        ]),
        el('label', null, [
          el('input', { id: 'as-memory', type: 'checkbox', ...(s.memoryEnabled !== false ? { checked: 'checked' } : {}) }),
          ' Cross-session memory'
        ])
      ]),
      el('div', { class: 'as-row-2col' }, [
        el('button', { class: 'acolyte-btn-ghost',
          onclick: () => { toggleSettings(); toggleHistoryPanel(); } }, ['📚 Past conversations']),
        el('button', { class: 'acolyte-btn-ghost',
          onclick: cyclePanelSize }, ['⛶ Cycle width'])
      ]),
      el('div', { class: 'as-row-2col' }, [
        el('button', { class: 'acolyte-btn-ghost',
          onclick: () => db.clearCache().then(() => note('Cache cleared.')) }, ['🗑 Clear cache']),
        el('button', { class: 'acolyte-btn-ghost',
          onclick: () => { if (confirm('Delete ALL past conversations?')) db.clearConversations().then(() => note('History cleared.')); } }, ['🗑 Clear history'])
      ]),

      el('div', { class: 'as-actions' }, [
        el('button', { class: 'acolyte-btn', onclick: applySettings }, ['Save & test']),
        el('button', { class: 'acolyte-btn-ghost', onclick: resetSettings }, ['Reset to deployment defaults']),
        el('button', { class: 'acolyte-btn-ghost', onclick: toggleSettings }, ['Close'])
      ])
    );
  }

  function applySettings(): void {
    const get = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    const checked = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.checked ?? false;

    const provider = (get('as-provider') as HTMLSelectElement).value as any;
    const baseurl  = (get('as-baseurl') as HTMLInputElement).value.trim();
    const model    = (get('as-model') as HTMLInputElement).value.trim();
    const apikey   = (get('as-apikey') as HTMLInputElement).value.trim();
    const persona  = (get('as-persona') as HTMLSelectElement).value as any;
    const accent   = (get('as-voice-accent') as HTMLSelectElement).value as any;
    const gender   = (get('as-voice-gender') as HTMLSelectElement).value as any;
    const rate     = parseFloat((get('as-voice-rate') as HTMLInputElement).value) || 1.0;
    const engine   = (get('as-voice-engine') as HTMLSelectElement | null)?.value as any || 'webspeech';

    // Build the new llm subconfig — host for Ollama, baseUrl for the others
    const llm: any = { provider, model: model || undefined };
    if (provider === 'ollama') llm.host = baseurl || 'http://localhost:11434';
    else                       llm.baseUrl = baseurl || undefined;
    if (apikey) llm.apiKey = apikey;

    const patch: Partial<AcolyteConfig> = {
      llm,
      persona,
      voice: { ...cfg.voice, accent, gender, rate, engine, autoSpeak: checked('as-voice-auto') },
      rag: { ...cfg.rag,
        showSourceCards:     checked('as-rag-cards'),
        crossPageReferences: checked('as-rag-cross')
      },
      tools: {
        ...cfg.tools,
        context7:       { enabled: checked('as-tool-ctx7') },
        verbose:        checked('as-tool-verbose'),
        // keys stay where they were (or empty — proxy handles them)
        geminiResearch: checked('as-tool-gem')  ? { ...(cfg.tools?.geminiResearch ?? {}) } : undefined,
        deepAnalysis:   checked('as-tool-deep') ? { ...(cfg.tools?.deepAnalysis   ?? {}) } : undefined
      },
      storage: {
        ...cfg.storage,
        cacheEnabled:   checked('as-cache'),
        historyEnabled: checked('as-history'),
        memoryEnabled:  checked('as-memory')
      }
    };

    cfg = deepMergeCfg(cfg, patch);
    saveStoredSettings(config, patch);
    if (patch.voice) tts.update(patch.voice);
    if (patch.tools) tools.update(patch.tools as any);
    probe();
    note('Settings saved.');
  }

  function resetSettings(): void {
    if (!confirm('Reset all settings to deployment defaults? This clears your saved preferences but does not delete conversation history.')) return;
    clearStoredSettings(config);
    cfg = JSON.parse(JSON.stringify(config));   // back to the original mount() config
    refreshSettingsPanel();
    probe();
    note('Settings reset.');
  }

  /* ───── Send loop ───── */

  async function send(question: string): Promise<void> {
    const q = (question ?? '').trim();
    if (!q || state.busy) return;
    tts.cancel();
    inputEl.value = '';
    appendMsg('user', q);
    state.history.push({ role: 'user', content: q });

    state.busy = true;
    // Visible "Thinking…" bubble. The animated dots in CSS make it clear
    // generation is in flight; the bubble is removed when the first
    // delta arrives (or replaced with the error message on failure).
    const thinking = el('div', { class: 'acolyte-msg assistant thinking' }, ['Thinking']) as HTMLElement;
    messagesBox.appendChild(thinking);
    messagesBox.scrollTop = messagesBox.scrollHeight;

    const context = await buildContextBlock(q);
    // RAG + memory are passed INTO the system-prompt assembly so the
    // rag_passages / memory_recall blocks can inject them in their proper
    // place (instead of dangling at the end of the system prompt).
    const system = buildSystemPrompt(q, context, '');
    const convo: ChatMessage[] = [
      { role: 'system', content: system },
      ...state.history
    ];

    try {
      let bubble: HTMLElement | null = null;
      const onDelta = (_d: string, full: string) => {
        if (!bubble) {
          thinking.remove();
          bubble = appendMsg('assistant', '');
          (bubble as any).dataset.streaming = '1';
        }
        setMsgContent(bubble, full, 'assistant');
        updateAssistantRaw(bubble, full);
        messagesBox.scrollTop = messagesBox.scrollHeight;
      };
      const toolSchemas = tools.schemas();
      const res = await sendChat(cfg.llm, convo, {
        onDelta,
        ...(toolSchemas.length ? { tools: toolSchemas } : {})
      });
      if (!bubble) thinking.remove();

      // Native tool calls?
      if (res.toolCalls?.length) {
        state.history.push({ role: 'assistant', content: res.text, tool_calls: res.toolCalls });
        for (const tc of res.toolCalls) {
          const fn = tc.function;
          const tcBlock = appendToolCall(fn.name, fn.arguments, { label: 'native' });
          let result = '';
          let errored = false;
          try { result = await tools.run(fn.name, fn.arguments); }
          catch (e: any) { result = `Tool error: ${e.message}`; errored = true; }
          tcBlock.finish(result, errored);
          state.history.push({
            role: 'tool',
            content: result,
            tool_name: fn.name,
            tool_call_id: tc.id
          });
        }
        // Second turn for the final answer. The closure captures the
        // bubble via a holder so TS narrowing isn't fighting us.
        const holder: { node: HTMLElement | null } = { node: null };
        const onDelta2 = (_d: string, full: string) => {
          if (!holder.node) {
            holder.node = appendMsg('assistant', '');
            (holder.node as any).dataset.streaming = '1';
          }
          setMsgContent(holder.node, full, 'assistant');
          updateAssistantRaw(holder.node, full);
          messagesBox.scrollTop = messagesBox.scrollHeight;
        };
        const convo2: ChatMessage[] = [{ role: 'system', content: system }, ...state.history];
        const res2 = await sendChat(cfg.llm, convo2, { onDelta: onDelta2 });
        if (!holder.node) holder.node = appendMsg('assistant', res2.text);
        else updateAssistantRaw(holder.node, res2.text);
        finalizeStreamingBubble(holder.node);
        appendSourcesFooter(holder.node, state.lastRagHits);
        maybeAutoSpeak(holder.node);
        state.history.push({ role: 'assistant', content: res2.text });
        await persistAndRefresh(q, res2.text);
      } else {
        const finalBubble: HTMLElement = bubble
          ? (setMsgContent(bubble, res.text, 'assistant'), updateAssistantRaw(bubble, res.text), bubble)
          : appendMsg('assistant', res.text);
        finalizeStreamingBubble(finalBubble);
        appendSourcesFooter(finalBubble, state.lastRagHits);
        maybeAutoSpeak(finalBubble);
        state.history.push({ role: 'assistant', content: res.text });
        await persistAndRefresh(q, res.text);
      }
    } catch (e: any) {
      thinking.remove();
      appendMsg('assistant', `⚠ ${e.message}`);
    } finally {
      state.busy = false;
    }
  }

  /** Lazily create / append to the persisted conversation row, then refresh
   *  the recent-chats strip so it reflects the latest title + timestamp. */
  async function persistAndRefresh(userMsg: string, assistantMsg: string): Promise<void> {
    if (cfg.storage?.historyEnabled === false) return;
    try {
      if (!state.convId) {
        const conv = await db.newConversation({
          title: 'Untitled',
          provider: cfg.llm.provider,
          model: (cfg.llm as any).model ?? ''
        });
        state.convId = conv.id!;
      }
      await db.appendMessage(state.convId, { role: 'user',      content: userMsg });
      await db.appendMessage(state.convId, { role: 'assistant', content: assistantMsg });
      refreshRecentStrip();
    } catch { /* persistence is best-effort */ }
  }

  /* ───── Public API ───── */

  buildPanel();
  if (cfg.ui?.autoMount !== false) { /* already mounted */ }

  const handle: AcolyteHandle = {
    open:  () => toggle(true),
    close: () => toggle(false),
    toggle: () => toggle(),
    send: async (msg) => { toggle(true); await send(msg); },
    setPersona: (p) => { cfg = { ...cfg, persona: p }; if (state.open && !state.history.length) renderWelcome(); },
    configure: (patch) => {
      cfg = { ...cfg, ...patch };
      if (patch.voice) tts.update(patch.voice);
      if (patch.tools) tools.update(patch.tools);
      if (patch.rag)   { rag.rebuild(); }
      probe();
    },
    unmount: () => {
      pluginHost.runOnClose();
      fab.remove();
      panel.remove();
    }
  };

  // Kick off plugin init AFTER the handle exists. refreshRAG just forces
  // the next retrieve to rebuild any cached passages.
  pluginHost.initAll(handle, { refreshRAG: async () => { rag.rebuild(); } }).catch(e =>
    console.error('[acolyte] plugin init batch failed:', e));

  return handle;
}
