/**
 * Manifest loader.
 *
 * Supports two config file formats:
 *   - JSON (data-config="acolyte.json" or just .config.json)
 *   - YAML (data-config="acolyte.yaml" or .yml)
 *
 * YAML parsing is lazy — js-yaml is loaded from CDN only when a YAML
 * file is requested. Costs ~25 KB gzipped on YAML deployments, $0 on
 * JSON deployments.
 *
 * The manifest format layers TWO concerns into one file:
 *   - `available` — what the settings UI should EXPOSE (drives dropdowns)
 *   - `defaults`  — what the widget USES at first run
 *   - `locked`    — settings paths the user cannot override
 *
 * Bare format (no manifest sections) is treated as a flat `defaults` —
 * preserves backwards compatibility with the simple JSON config we
 * shipped first.
 */

import type { AcolyteConfig } from '../types.js';

declare global {
  interface Window { jsyaml?: { load(src: string): unknown }; }
}

const YAML_CDN = 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js';

async function loadYAMLParserOnce(): Promise<{ load(src: string): unknown }> {
  if (typeof window === 'undefined') throw new Error('YAML loader requires a browser');
  if (window.jsyaml) return window.jsyaml;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = YAML_CDN;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load js-yaml from CDN'));
    document.head.appendChild(s);
  });
  if (!window.jsyaml) throw new Error('js-yaml loaded but window.jsyaml not set');
  return window.jsyaml;
}

/** Fetch + parse a config file, picking YAML or JSON by extension. */
export async function loadConfigFile(url: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(url);
  if (!r.ok) return null;
  const text = await r.text();
  if (/\.ya?ml(\?|$)/i.test(url)) {
    try {
      const yaml = await loadYAMLParserOnce();
      return yaml.load(text) as Record<string, unknown>;
    } catch (e) {
      console.warn('[acolyte] YAML parse failed, returning null:', e);
      return null;
    }
  }
  try { return JSON.parse(text); }
  catch (e) {
    console.warn('[acolyte] JSON parse failed:', e);
    return null;
  }
}

/**
 * Split a raw manifest object into:
 *   - the runtime AcolyteConfig (merged `defaults:` + any top-level fields)
 *   - the `available` + `locked` manifest sections preserved separately
 *
 * Backwards-compat: when neither `available:` nor `defaults:` exists at
 * the top level, the entire object is treated as the runtime config.
 */
export function splitManifest(raw: Record<string, unknown>): AcolyteConfig {
  if (!raw || typeof raw !== 'object') return {} as AcolyteConfig;
  const hasManifestKeys = 'defaults' in raw || 'available' in raw || 'locked' in raw;

  if (!hasManifestKeys) {
    // Treat the whole file as a flat runtime config. Guarantee llm so the
    // type contract holds even if the deployer's JSON omits it.
    const flat = { ...raw } as Partial<AcolyteConfig>;
    if (!flat.llm) flat.llm = { provider: 'ollama', host: 'http://localhost:11434' };
    return flat as AcolyteConfig;
  }

  // Pull `defaults` up to the top level, preserve `available` + `locked`
  const defaults = (raw.defaults as Record<string, unknown>) ?? {};
  const merged: AcolyteConfig = {
    ...defaults,
    available: raw.available as AcolyteConfig['available'],
    locked:    raw.locked    as string[] | undefined
  } as AcolyteConfig;

  // Top-level keys that aren't section names get merged in too — lets a
  // deployer write `keysEndpoint: ...` at the root without burying it in
  // `defaults:`. Sections themselves are excluded.
  for (const k of Object.keys(raw)) {
    if (k === 'defaults' || k === 'available' || k === 'locked') continue;
    if (k.startsWith('_')) continue;   // comment-style keys
    (merged as any)[k] = (merged as any)[k] ?? raw[k];
  }

  // Manifest-only configs (just `available:` + `locked:`) need a fallback
  // llm. We pick a safe local default; the deployer can override either in
  // `defaults:` or via the settings panel.
  if (!merged.llm) {
    merged.llm = { provider: 'ollama', host: 'http://localhost:11434' };
  }
  return merged;
}

/**
 * Returns true if the given dotted path is in the locked list.
 * Example: isLocked(cfg, 'llm.provider') → true if 'llm.provider' is locked.
 */
export function isLocked(cfg: AcolyteConfig, path: string): boolean {
  return Array.isArray(cfg.locked) && cfg.locked.indexOf(path) !== -1;
}
