/**
 * Acolyte — drop-in page-aware chat widget.
 *
 * Three ways to load the widget on any page (in priority order):
 *
 *   1. Data-attributes on the script tag (most plug-and-play):
 *      <script type="module" src="acolyte.js"
 *              data-llm-provider="ollama"
 *              data-llm-host="http://localhost:8767"
 *              data-persona="teacher"></script>
 *
 *   2. External JSON config file:
 *      <script type="module" src="acolyte.js" data-config="acolyte.config.json"></script>
 *
 *   3. Global config object (set before the script):
 *      <script>window.AcolyteConfig = { llm: {...}, persona: 'teacher' };</script>
 *      <script type="module" src="acolyte.js"></script>
 *
 *   4. Manual mount() — for framework integrations:
 *      import { mount } from 'acolyte';
 *      mount({ llm: {...} });
 *
 * Patterns 1–3 trigger auto-mount on DOMContentLoaded. Pattern 4 is fully
 * manual — pass `data-acolyte-no-auto="true"` on the script tag if you
 * want to suppress auto-mount and call `mount()` yourself later.
 */

import type {
  AcolyteConfig,
  AcolyteHandle,
  BuiltInPersona,
  CustomPersona
} from './types.js';
import { createWidget } from './widget.js';
import { personas } from './personas/index.js';

declare const __ACOLYTE_CSS__: string;

/** Inject the bundled stylesheet once per page. */
function injectCss(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('acolyte-styles')) return;
  const style = document.createElement('style');
  style.id = 'acolyte-styles';
  style.textContent = __ACOLYTE_CSS__;
  document.head.appendChild(style);
}

export function mount(config: AcolyteConfig): AcolyteHandle {
  if (typeof window === 'undefined') {
    throw new Error('Acolyte.mount() must be called in a browser context.');
  }
  const ui = config.ui ?? {};
  if (ui.autoInjectCss !== false) injectCss();
  return createWidget(config);
}

/* ─────────────────────────────────────────────────────────────────────
 * Auto-init machinery
 * ────────────────────────────────────────────────────────────────────*/

/**
 * Turn flat dash-keyed data attributes into a nested AcolyteConfig.
 * Examples:
 *   data-llm-provider="ollama"        →  { llm: { provider: 'ollama' } }
 *   data-llm-host="http://..."         →  { llm: { host: 'http://...' } }
 *   data-persona="teacher"             →  { persona: 'teacher' }
 *   data-rag-auto="true"               →  { rag: { auto: true } }
 *   data-ui-accent="#2D8B55"           →  { ui: { accent: '#2D8B55' } }
 *   data-voice-enabled="false"         →  { voice: { enabled: false } }
 * Anything starting with `data-acolyte-` (e.g. data-acolyte-no-auto) is
 * a meta hint for the loader itself, not a config field.
 */
function parseDataAttrs(el: HTMLElement): Partial<AcolyteConfig> {
  const out: Record<string, any> = {};
  for (const attr of Array.from(el.attributes)) {
    if (!attr.name.startsWith('data-')) continue;
    if (attr.name.startsWith('data-acolyte-')) continue;
    if (attr.name === 'data-config') continue;
    const path = attr.name.slice(5).split('-');         // drop 'data-' + split
    let cursor = out;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      cursor[k] ??= {};
      cursor = cursor[k];
    }
    cursor[path[path.length - 1]] = coerceValue(attr.value);
  }
  return out as Partial<AcolyteConfig>;
}

function coerceValue(s: string): unknown {
  if (s === 'true')  return true;
  if (s === 'false') return false;
  if (s === 'null')  return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try { return JSON.parse(s); } catch { /* fall through */ }
  }
  return s;
}

/** Find the script tag this module was loaded from. */
function findOwnScript(): HTMLScriptElement | null {
  if (typeof document === 'undefined') return null;
  const cs = (document as any).currentScript as HTMLScriptElement | undefined;
  if (cs) return cs;
  // ESM modules don't expose currentScript; fall back to looking for
  // any <script> whose src contains 'acolyte'.
  const scripts = Array.from(document.querySelectorAll('script[src]')) as HTMLScriptElement[];
  return scripts.find(s => /acolyte/i.test(s.src)) ?? null;
}

/** Merge a Partial<AcolyteConfig> into a base config (deep merge for objects). */
function deepMerge(base: any, patch: any): any {
  if (patch == null) return base;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out: any = { ...base };
  for (const k of Object.keys(patch)) {
    out[k] = (typeof patch[k] === 'object' && !Array.isArray(patch[k]) && patch[k] !== null)
      ? deepMerge(base?.[k], patch[k])
      : patch[k];
  }
  return out;
}

/**
 * Try to mount automatically using one of the three patterns above.
 * Resolves to the widget handle on success, or null if no config was found.
 */
export async function autoMount(): Promise<AcolyteHandle | null> {
  if (typeof window === 'undefined') return null;

  const script = findOwnScript();
  // Opt-out — explicit caller-driven mode
  if (script?.dataset?.acolyteNoAuto === 'true') return null;

  let config: any = {};

  // (a) global config var
  const g = (window as any).AcolyteConfig;
  if (g && typeof g === 'object') config = deepMerge(config, g);

  // (b) external config file — JSON or YAML; manifest sections are
  //     understood automatically. See src/internal/manifest.ts.
  const cfgUrl = script?.dataset?.config;
  if (cfgUrl) {
    try {
      const { loadConfigFile, splitManifest } = await import('./internal/manifest.js');
      const raw = await loadConfigFile(cfgUrl);
      if (raw) config = deepMerge(config, splitManifest(raw));
    } catch (e) {
      console.warn('[acolyte] data-config load failed:', e);
    }
  }

  // (c) data attributes on the script tag
  if (script) config = deepMerge(config, parseDataAttrs(script));

  // (d) `keysEndpoint` — fetch the proxy's /chat-config and merge any
  //     keys it serves into the llm config. Lets users keep keys in
  //     the proxy's .env (out of the page and out of git).
  if (config.keysEndpoint) {
    try {
      const r = await fetch(config.keysEndpoint);
      if (r.ok) {
        const remote = await r.json();
        config.llm = config.llm ?? {};
        if (config.llm.provider === 'openai'    && remote.openaiKey)    config.llm.apiKey = config.llm.apiKey ?? remote.openaiKey;
        if (config.llm.provider === 'anthropic' && remote.anthropicKey) config.llm.apiKey = config.llm.apiKey ?? remote.anthropicKey;
        // OpenAI-compatible endpoints pointing at Gemini's compat URL pick
        // up the geminiKey automatically. Other compat endpoints (groq,
        // anyscale, etc.) need an explicit apiKey or env wiring.
        if (config.llm.provider === 'openai-compatible' && /generativelanguage|\/gemini\//i.test(config.llm.baseUrl ?? '') && remote.geminiKey) {
          config.llm.apiKey = config.llm.apiKey ?? remote.geminiKey;
        }
        if (remote.geminiKey || remote.tavilyKey) {
          config.tools = config.tools ?? {};
          if (remote.geminiKey && !config.tools.geminiResearch?.apiKey) config.tools.geminiResearch = { ...(config.tools.geminiResearch ?? {}), apiKey: remote.geminiKey };
          if (remote.geminiKey && !config.tools.deepAnalysis?.apiKey)   config.tools.deepAnalysis   = { ...(config.tools.deepAnalysis   ?? {}), apiKey: remote.geminiKey };
        }
      }
    } catch (e) {
      console.warn('[acolyte] keysEndpoint fetch failed:', e);
    }
  }

  // Nothing was supplied — caller must call mount() manually.
  if (!config.llm) return null;

  // Resolve JSON-declared plugins. A YAML/JSON config can't carry function
  // references, so deployers list plugins by name with their options inline:
  //   "plugins": [{ "name": "crossPageRAG", "pages": ["/01.html", ...] }]
  // Plugin objects already constructed in JS (manual mount path) pass through
  // untouched.
  const pluginSpecs = (config as any).plugins;
  if (Array.isArray(pluginSpecs) && pluginSpecs.length) {
    const resolved: any[] = [];
    for (const spec of pluginSpecs) {
      if (spec && typeof spec === 'object' && typeof spec.name === 'string' && !spec.version) {
        const factory = BUILT_IN_PLUGINS[spec.name];
        if (factory) {
          const { name: _omit, ...opts } = spec;
          resolved.push(factory(opts));
        } else {
          console.warn('[acolyte] unknown plugin name in config:', spec.name);
        }
      } else {
        resolved.push(spec);   // already an AcolytePlugin instance
      }
    }
    (config as any).plugins = resolved;
  }

  return mount(config as AcolyteConfig);
}

/** Built-in plugins addressable by name from a JSON/YAML config. */
const BUILT_IN_PLUGINS: Record<string, (opts: any) => any> = {};

// Self-trigger on load, but only if we're in a browser AND there's a script
// tag we can identify (so importing as a library doesn't auto-mount).
if (typeof window !== 'undefined') {
  const start = () => { autoMount().catch(err => console.warn('[acolyte] autoMount failed:', err)); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    // Use a microtask so consumers using `import { mount }` get to run
    // their own code before we try to auto-mount.
    queueMicrotask(start);
  }
}

export function resolvePersona(
  p: BuiltInPersona | CustomPersona | undefined
): CustomPersona {
  if (!p) return personas.teacher;
  if (typeof p === 'string') return personas[p] ?? personas.teacher;
  return p;
}

export { personas };
export type {
  AcolyteConfig,
  AcolyteHandle,
  BuiltInPersona,
  CustomPersona,
  LLMConfig,
  RAGConfig,
  RAGContent,
  ToolsConfig,
  UIConfig,
  VoiceConfig,
  StorageConfig
} from './types.js';

// Plugin API — types + built-in plugins
export type {
  AcolytePlugin,
  PluginContext,
  PluginProvider,
  PluginTool,
  PluginPersona,
  RAGSourceProvider,
  PluginButton,
  PluginMessageAction,
  PluginPanelSection,
  SendContext,
  ResponseContext,
  ToolCallContext
} from './plugin.js';
import { crossPageRAG } from './plugins/crossPageRAG.js';
export { crossPageRAG };
import { agentAssist } from './plugins/agentAssist.js';
export { agentAssist };
export type { AgentAssistConfig } from './plugins/agentAssist.js';
import { semanticRAG } from './plugins/semanticRAG.js';
export { semanticRAG };
export type { SemanticRAGConfig } from './plugins/semanticRAG.js';

// Register built-in plugins for JSON/YAML name-based plugin loading.
BUILT_IN_PLUGINS.crossPageRAG = crossPageRAG;
BUILT_IN_PLUGINS.agentAssist = agentAssist;
BUILT_IN_PLUGINS.semanticRAG = semanticRAG;
