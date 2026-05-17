/**
 * Settings persistence + provider-aware model catalogs.
 *
 * Storage: localStorage under a key namespaced by `storage.dbName` so two
 * acolyte instances on the same origin don't collide. We deliberately do
 * NOT store API keys here — those come from the proxy /chat-config at
 * runtime, never from the user's typed config. Settings UI may show key
 * input fields, but if the user pastes one it's session-only (in-memory)
 * unless the deployment explicitly opts in to localStorage for keys.
 */

import type { AcolyteConfig, LLMConfig } from '../types.js';

const KEY_PREFIX = 'acolyte-settings:';
const FALLBACK_NS = 'acolyte';

export function settingsKey(cfg: AcolyteConfig): string {
  const ns = cfg.storage?.dbName ?? FALLBACK_NS;
  return KEY_PREFIX + ns;
}

export function loadStoredSettings(cfg: AcolyteConfig): Partial<AcolyteConfig> {
  try {
    const raw = localStorage.getItem(settingsKey(cfg));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function saveStoredSettings(cfg: AcolyteConfig, patch: Partial<AcolyteConfig>): void {
  try { localStorage.setItem(settingsKey(cfg), JSON.stringify(patch)); }
  catch { /* quota / private mode — ignore */ }
}

export function clearStoredSettings(cfg: AcolyteConfig): void {
  try { localStorage.removeItem(settingsKey(cfg)); } catch { /* ignore */ }
}

/* ───── Model catalogs ─────────────────────────────────────────────── */

/**
 * Per-provider model list. For Ollama we discover at runtime (`/api/tags`).
 * For cloud providers we ship a known-good preset list; deployers can
 * override via the manifest YAML when that lands.
 */
export const MODEL_PRESETS: Record<string, string[]> = {
  anthropic: [
    'claude-haiku-4-5',
    'claude-sonnet-4-7',
    'claude-sonnet-4-6',
    'claude-opus-4-7'
  ],
  openai: [
    'gpt-5-mini',
    'gpt-5',
    'gpt-4o-mini',
    'gpt-4o'
  ],
  // openai-compatible: figured out from baseUrl (Gemini detected → Gemini list)
  gemini_compat: [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash-exp',
    'gemini-1.5-flash',
    'gemini-1.5-pro'
  ]
};

export interface ModelInfo { name: string; }

/** Returns the model list for the current provider config. */
export async function listAvailableModels(llm: LLMConfig): Promise<ModelInfo[]> {
  if (llm.provider === 'ollama') {
    try {
      const host = llm.host ?? 'http://localhost:11434';
      const r = await fetch(host.replace(/\/$/, '') + '/api/tags');
      if (!r.ok) return [];
      const data = await r.json() as { models?: { name: string }[] };
      // Hide embedding-only models from the picker
      return (data.models ?? [])
        .filter(m => !/embed/i.test(m.name))
        .map(m => ({ name: m.name }));
    } catch { return []; }
  }
  if (llm.provider === 'anthropic') return MODEL_PRESETS.anthropic.map(name => ({ name }));
  if (llm.provider === 'openai')    return MODEL_PRESETS.openai.map(name => ({ name }));
  if (llm.provider === 'openai-compatible') {
    if (/generativelanguage|\/gemini\//i.test(llm.baseUrl ?? '')) {
      return MODEL_PRESETS.gemini_compat.map(name => ({ name }));
    }
    // Unknown compat endpoint — just return the configured one if any
    return llm.model ? [{ name: llm.model }] : [];
  }
  return [];
}

/** Pretty label for the status pill / heading. */
export function providerLabel(llm: LLMConfig): string {
  switch (llm.provider) {
    case 'ollama': return 'Ollama';
    case 'anthropic': return 'Anthropic';
    case 'openai': return 'OpenAI';
    case 'openai-compatible':
      if (/generativelanguage|\/gemini\//i.test(llm.baseUrl ?? '')) return 'Gemini';
      return 'compat';
    default: return String((llm as { provider: string }).provider);
  }
}
