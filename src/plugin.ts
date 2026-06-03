/**
 * Acolyte plugin system.
 *
 * A plugin is an object with optional fields. Each field plugs into a
 * specific extension point — behavioral hooks (intercept message flow),
 * capability registration (providers, tools, personas, RAG sources), or
 * UI slots. Plugins are pure: zero coupling between them, zero coupling
 * to widget internals beyond the documented hook signatures.
 *
 * The widget's PluginHost is what actually owns the registry, hook
 * dispatch, and capability merging. Plugins call into it via the
 * `PluginContext` passed to `init()`.
 */

import type {
  AcolyteHandle,
  CustomPersona,
  LLMConfig,
  RAGContent
} from './types.js';
import type { ToolDescriptor } from './tools/index.js';

/* ───── Hook payload shapes ───── */

export interface SendContext {
  /** Stable per-conversation identifier (created at mount). Read-only.
   *  Lets a plugin tag outbound events so a backend can group a session. */
  sessionId: string;
  /** The full message array about to go to the LLM. Mutable. */
  messages: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }[];
  /** The user's just-sent question (last user message). Read-only. */
  question: string;
  /** Provider config currently in use. Read-only. */
  llm: LLMConfig;
  /** Cache key components — plugins MAY add fields under `extra` to
   *  influence cache keying (e.g. add a region/locale segment). */
  cacheKey: { provider: string; model: string; lastMessage: string; contextKey: string; extra?: Record<string, string> };
}

export interface ResponseContext {
  /** Stable per-conversation identifier (matches the SendContext). */
  sessionId: string;
  question: string;
  responseText: string;
  /** Wall-clock ms from send to response. */
  elapsedMs: number;
  /** Whether the response came from the cache. */
  fromCache: boolean;
  /** Tool calls executed during this turn (if any). */
  toolCalls?: { name: string; args: Record<string, unknown>; result: string; ms: number }[];
}

export interface ToolCallContext {
  name: string;
  args: Record<string, unknown>;
  /** Set this to short-circuit and return a result without running the tool. */
  shortCircuit?: string;
}

/* ───── Capability registration shapes ───── */

export interface PluginProvider {
  /** Unique name. Becomes a valid value for `llm.provider`. */
  name: string;
  /** Sends a chat. Same signature as built-in providers. */
  send(messages: SendContext['messages'], opts: { onDelta?: (delta: string, full: string) => void; tools?: unknown[]; temperature?: number }): Promise<{ text: string; toolCalls?: unknown[] }>;
  /** Optional: list available models. */
  listModels?(): Promise<string[]>;
}

export interface PluginTool {
  schema: ToolDescriptor;
  run(args: Record<string, unknown>): Promise<string>;
}

export interface PluginPersona {
  name: string;
  persona: CustomPersona;
}

/**
 * A plugin can supply extra RAG content from any source — a sitemap, an
 * API, another page of the same site, a remote search index. The host
 * widget merges these alongside the built-in DOM-scraped passages.
 */
export interface RAGSourceProvider {
  /** Unique source ID, surfaced in citation cards. */
  name: string;
  /** Returns an array of RAG-able content sections. May be empty. */
  fetch(opts: { query?: string; signal?: AbortSignal }): Promise<RAGContent[]>;
  /** If true, fetch() is called on every retrieve (live search).
   *  If false, fetch() is called once on init and the result is cached. */
  perQuery?: boolean;
  /** Optional: a human-readable URL the source card can link to. */
  pageUrl?(section: RAGContent): string | undefined;
  /**
   * Marks this source as supplying passages from OTHER pages of the site
   * (not the page the user is on). The widget skips these sources when
   * `cfg.rag.crossPageReferences === false`, so deployers can keep
   * customer-facing chats focused on the current page.
   */
  crossPage?: boolean;
}

/* ───── UI extension shapes ───── */

export interface PluginButton {
  /** Short text or emoji shown in the button. */
  icon: string;
  /** Tooltip / aria-label. */
  title: string;
  /** Click handler. Receives the AcolyteHandle so the plugin can drive
   *  the widget (open(), send(), setPersona(), etc.). */
  onClick(handle: AcolyteHandle): void | Promise<void>;
}

export interface PluginMessageAction {
  icon: string;
  title: string;
  /** Called when the user clicks the action on a specific assistant message. */
  onClick(opts: { messageText: string; messageNode: HTMLElement; handle: AcolyteHandle }): void | Promise<void>;
}

export interface PluginPanelSection {
  title: string;
  /** Element factory — returns the DOM nodes to render inside the section. */
  render(handle: AcolyteHandle): HTMLElement;
  /** Initially expanded? Default false. */
  defaultOpen?: boolean;
}

/* ───── The Plugin type itself ───── */

export interface AcolytePlugin {
  /** Unique plugin name. Must be present. */
  name: string;
  version?: string;

  /** Called once after the widget is mounted. Use it to register
   *  capabilities at runtime, kick off background work, or attach state. */
  init?(handle: AcolyteHandle, ctx: PluginContext): void | Promise<void>;

  /* ─── behavioral hooks ─── */
  /** Modify the outgoing message bundle. Return the (possibly new) context. */
  beforeSend?(ctx: SendContext): SendContext | Promise<SendContext>;
  /** Observe responses (analytics, persistence, etc.). Cannot mutate the response. */
  afterResponse?(ctx: ResponseContext): void | Promise<void>;
  /** Fires before a tool call runs. Set `ctx.shortCircuit` to return a
   *  cached / synthetic result without actually calling the tool. */
  onToolCall?(ctx: ToolCallContext): void | Promise<void>;
  /** Fires after an assistant bubble is rendered. The plugin may attach
   *  extra DOM (action buttons, badges, citations, etc.) to `node`. */
  onMessageRender?(node: HTMLElement, msg: { role: string; content: string }): void;
  /** Fires when the persona is swapped at runtime. */
  onPersonaChange?(p: CustomPersona): void;
  /** Fires when the widget unmounts. Use it to release resources. */
  onClose?(): void;

  /* ─── declarative capabilities ─── */
  providers?: PluginProvider[];
  tools?: PluginTool[];
  personas?: PluginPersona[];
  ragSources?: RAGSourceProvider[];

  /* ─── UI slots ─── */
  ui?: {
    headerButtons?: PluginButton[];
    messageActions?: PluginMessageAction[];
    footerNote?: string | ((handle: AcolyteHandle) => HTMLElement);
    panelSections?: PluginPanelSection[];
  };
}

/* ───── Plugin runtime context (handed to plugin.init) ───── */

export interface PluginContext {
  /** Log namespaced to this plugin (prefixed with [plugin-name]). */
  log(...args: unknown[]): void;
  /** Persist plugin-private state in IndexedDB under this plugin's namespace. */
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** Programmatically refresh RAG sources (useful if the plugin loads
   *  content async after init). */
  refreshRAG(): Promise<void>;
}

/* ───── PluginHost — widget-side runtime ───── */

export class PluginHost {
  private plugins: AcolytePlugin[] = [];
  private storageMaps = new Map<string, Map<string, unknown>>();

  add(plugin: AcolytePlugin): void {
    if (this.plugins.find(p => p.name === plugin.name)) {
      console.warn(`[acolyte] plugin "${plugin.name}" already registered; replacing`);
      this.plugins = this.plugins.filter(p => p.name !== plugin.name);
    }
    this.plugins.push(plugin);
  }

  async initAll(handle: AcolyteHandle, helpers: { refreshRAG: () => Promise<void> }): Promise<void> {
    for (const p of this.plugins) {
      if (!p.init) continue;
      const ctx: PluginContext = {
        log: (...args) => console.log(`[acolyte:${p.name}]`, ...args),
        storage: this.storageFor(p.name),
        refreshRAG: helpers.refreshRAG
      };
      try { await p.init(handle, ctx); }
      catch (e) { console.error(`[acolyte:${p.name}] init failed:`, e); }
    }
  }

  private storageFor(plugin: string): PluginContext['storage'] {
    if (!this.storageMaps.has(plugin)) this.storageMaps.set(plugin, new Map());
    const m = this.storageMaps.get(plugin)!;
    return {
      async get<T>(k: string): Promise<T | undefined> { return m.get(k) as T | undefined; },
      async set(k, v) { m.set(k, v); },
      async delete(k) { m.delete(k); }
    };
  }

  async runBeforeSend(ctx: SendContext): Promise<SendContext> {
    let acc = ctx;
    for (const p of this.plugins) {
      if (!p.beforeSend) continue;
      try { acc = await p.beforeSend(acc); }
      catch (e) { console.error(`[acolyte:${p.name}] beforeSend failed:`, e); }
    }
    return acc;
  }

  async runAfterResponse(ctx: ResponseContext): Promise<void> {
    for (const p of this.plugins) {
      if (!p.afterResponse) continue;
      try { await p.afterResponse(ctx); }
      catch (e) { console.error(`[acolyte:${p.name}] afterResponse failed:`, e); }
    }
  }

  async runOnToolCall(ctx: ToolCallContext): Promise<ToolCallContext> {
    for (const p of this.plugins) {
      if (!p.onToolCall) continue;
      try { await p.onToolCall(ctx); }
      catch (e) { console.error(`[acolyte:${p.name}] onToolCall failed:`, e); }
      if (ctx.shortCircuit !== undefined) break;
    }
    return ctx;
  }

  runOnMessageRender(node: HTMLElement, msg: { role: string; content: string }): void {
    for (const p of this.plugins) {
      if (!p.onMessageRender) continue;
      try { p.onMessageRender(node, msg); }
      catch (e) { console.error(`[acolyte:${p.name}] onMessageRender failed:`, e); }
    }
  }

  runOnClose(): void {
    for (const p of this.plugins) {
      try { p.onClose?.(); } catch (e) { console.error(`[acolyte:${p.name}] onClose failed:`, e); }
    }
  }

  /* ─── capability accessors ─── */
  allProviders(): PluginProvider[]    { return this.plugins.flatMap(p => p.providers ?? []); }
  allTools(): PluginTool[]            { return this.plugins.flatMap(p => p.tools ?? []); }
  allPersonas(): PluginPersona[]      { return this.plugins.flatMap(p => p.personas ?? []); }
  allRAGSources(): RAGSourceProvider[] { return this.plugins.flatMap(p => p.ragSources ?? []); }

  allHeaderButtons(): PluginButton[]  { return this.plugins.flatMap(p => p.ui?.headerButtons ?? []); }
  allMessageActions(): PluginMessageAction[] { return this.plugins.flatMap(p => p.ui?.messageActions ?? []); }
  allPanelSections(): PluginPanelSection[]   { return this.plugins.flatMap(p => p.ui?.panelSections ?? []); }
  footerNotes(): (string | ((h: AcolyteHandle) => HTMLElement))[] {
    return this.plugins.flatMap(p => (p.ui?.footerNote ? [p.ui.footerNote] : []));
  }
}
