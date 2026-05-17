/**
 * Public configuration surface for Acolyte.
 *
 * All fields are optional with sensible defaults — the minimum useful
 * call is `mount({})` (defaults to Ollama at localhost, teacher persona,
 * auto-RAG over the page DOM).
 *
 * Design principle: every config knob has a default that produces a
 * "works on first run" experience. The user only sets what they want
 * to override.
 */

/* ───── LLM provider ───── */

export interface AnthropicConfig {
  provider: 'anthropic';
  apiKey: string;
  model?: string;            // default: 'claude-sonnet-4-7'
  baseUrl?: string;          // default: 'https://api.anthropic.com'
  headers?: Record<string, string>;
  maxTokens?: number;        // auto-sized per model if unset
}

export interface OpenAIConfig {
  provider: 'openai';
  apiKey: string;
  model?: string;            // default: 'gpt-5-mini'
  baseUrl?: string;          // default: 'https://api.openai.com/v1'
  headers?: Record<string, string>;
  maxTokens?: number;
}

export interface OllamaConfig {
  provider: 'ollama';
  host?: string;             // default: 'http://localhost:11434'
  model?: string;            // auto-picks first available if unset
  headers?: Record<string, string>;
}

export interface OpenAICompatibleConfig {
  /**
   * Any OpenAI /v1/chat/completions-compatible endpoint. Use this for
   * proxies / aggregators / self-hosted servers: LiteLLM, OpenRouter,
   * Anyscale, Together, Groq, vLLM, llama.cpp, etc.
   */
  provider: 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
}

export type LLMConfig =
  | AnthropicConfig
  | OpenAIConfig
  | OllamaConfig
  | OpenAICompatibleConfig;

/* ───── Persona ───── */

export type BuiltInPersona = 'teacher' | 'docs' | 'business' | 'bare';

export interface CustomPersona {
  /** The opening sentence describing who the assistant is. */
  role: string;
  /** Personality dial. */
  tone?: 'warm' | 'professional' | 'concise' | 'playful' | 'academic';
  /**
   * 'commentary' — TTS describes what the screen shows (default for teacher).
   * 'verbatim'   — TTS reads the answer (kept similar to text).
   * 'off'        — no SPEAK block; voice-out disabled for this persona.
   */
  speakStyle?: 'commentary' | 'verbatim' | 'off';
  /**
   * 'strict'      — refuses to answer outside the supplied RAG/context.
   * 'permissive'  — answers from world knowledge when RAG misses.
   */
  grounding?: 'strict' | 'permissive';
  /** Behaviour on out-of-scope questions. */
  refusalPolicy?: 'redirect' | 'apologize' | 'answer';
  /** First message the assistant shows when the chat opens. */
  greeting?: string;
  /**
   * Explicit ordered list of prompt-block IDs to include after the `role`.
   * When omitted, the widget picks a sensible default from speakStyle +
   * grounding (see `src/prompts/blocks.ts → defaultBlocksFor`).
   * This is how a domain customizes the system prompt without code changes —
   * swap blocks in/out, or add custom blocks via the plugin system.
   */
  promptBlocks?: string[];
  /** Extra text appended to the system prompt (after all blocks). */
  extras?: string;
}

/* ───── RAG ───── */

export interface RAGContent {
  id: string;
  title: string;
  text: string;
  meta?: Record<string, unknown>;
}

export interface RAGConfig {
  enabled?: boolean;                 // default: true
  /** Mode 1: auto-scan the DOM. */
  auto?: boolean;                    // default: true
  /** Mode 2: explicit selector for the root container to scan. */
  selector?: string;
  /** Mode 3: provide content directly — overrides DOM scanning. */
  sections?: RAGContent[];
  /** Mode 4: fetch a sidecar JSON at mount time. */
  sourceUrl?: string;
  /** Minimum characters to treat a chunk as a passage. Default 80. */
  minPassageLength?: number;
  /** Max number of passages to retrieve per query. Default 5. */
  topK?: number;
  /** Cosine / BM25 score floor under which hits are dropped. Default 0. */
  scoreFloor?: number;
  /**
   * Whether to display source-citation cards under each assistant answer
   * (the 📚 sources footer). Default true.
   */
  showSourceCards?: boolean;
  /**
   * Whether to include passages from OTHER pages of the same site in the
   * retrieval (via the crossPageRAG plugin). For learning / docs sites
   * this is useful — for business / customer-facing chat where you don't
   * want the agent linking the user away, leave this off.
   * Default false (opt-in).
   */
  crossPageReferences?: boolean;
}

/* ───── Tools ───── */

export interface ToolsConfig {
  /** Direct Gemini grounded research. Needs Google AI Studio key. */
  geminiResearch?: { apiKey?: string; model?: string };
  /** Context7 library docs. No key required. */
  context7?: { enabled?: boolean };
  /** Deep Gemini analysis. */
  deepAnalysis?: { apiKey?: string; model?: string };
  /** Verbose tool drill-downs (auto-expand). */
  verbose?: boolean;
}

/* ───── UI ───── */

export interface UIConfig {
  /** CSS color string for the accent. Defaults to inheriting host page tokens. */
  accent?: string;
  /** Which side of the viewport the panel slides in from. */
  position?: 'right' | 'left';
  /** Keyboard shortcut to toggle. Default: 'mod+k' (cmd/ctrl + K). */
  keyboardShortcut?: string;
  /** Auto-mount the FAB on init. False = caller controls mounting. */
  autoMount?: boolean;
  /** Floating-action-button icon (emoji or short text). */
  fabIcon?: string;
  /** Where to inject the FAB + panel. Default 'body'. */
  targetSelector?: string;
  /** Initial panel width. */
  defaultWidth?: 'narrow' | 'wide' | 'full';
  /** Whether to inject the bundled stylesheet at mount time. Default true. */
  autoInjectCss?: boolean;
}

/* ───── Voice ───── */

export interface VoiceConfig {
  enabled?: boolean;                   // default: true
  autoSpeak?: boolean;                 // default: false
  accent?: 'en-GB' | 'en-US' | 'en-AU' | 'en-IN' | string;   // default 'en-GB'
  gender?: 'male' | 'female';          // default 'male'
  rate?: number;                       // 0.5 .. 2.0, default 1.0
  /** Override the auto-picker with a specific OS voice name. */
  voiceName?: string;
  /**
   * Which TTS engine to use:
   *  - 'webspeech' (default): SpeechSynthesis API, OS-shipped voices, 0 KB,
   *      quality varies by OS.
   *  - 'kokoro':   In-browser Kokoro neural TTS via @huggingface/transformers.
   *      ~80 MB model download on first use (cached forever), excellent
   *      natural prosody, no API key, fully offline after load.
   *      Falls back to webspeech if WebGPU is unavailable.
   *  - 'auto':     Try kokoro if WebGPU is detected, else webspeech.
   */
  engine?: 'webspeech' | 'kokoro' | 'auto';
  /** Kokoro-specific voice id. Ignored if engine !== 'kokoro'. */
  kokoroVoice?: string;
}

/* ───── Storage ───── */

export interface StorageConfig {
  /** IndexedDB database name. Use a unique value if multiple Acolyte
   *  instances might run side-by-side. Default 'acolyte-chat'. */
  dbName?: string;
  cacheEnabled?: boolean;
  historyEnabled?: boolean;
  memoryEnabled?: boolean;
  /**
   * Time-to-live in milliseconds for cached entries. 0 = never expire.
   * Default 0.
   */
  cacheTTLMs?: number;
}

/* ───── Top-level config ───── */

// Forward-declare for the optional plugins array. The runtime contract
// is defined in src/plugin.ts; we import-type-only here to avoid a cycle.
import type { AcolytePlugin } from './plugin.js';

/* ───── Manifest (available / defaults / locked) ───── */

export interface ManifestProviderOption {
  id: 'ollama' | 'openai' | 'anthropic' | 'openai-compatible' | string;
  label: string;
  host?: string;
  baseUrl?: string;
  /** Explicit list of model ids the user can pick. */
  models?: string[] | 'auto';
}

export interface ManifestPersonaOption {
  id: BuiltInPersona | string;
  label: string;
  /** Optional inline persona definition (overrides built-in if id collides). */
  persona?: CustomPersona;
}

export interface AcolyteManifest {
  /**
   * Optional manifest layer. When this is present in `acolyte.yaml/json`,
   * the widget surfaces the listed options in its Settings panel
   * (provider dropdown, model dropdown, persona dropdown). Anything NOT
   * listed here is hidden from the user.
   *
   * If the manifest is omitted, ALL built-in providers/personas/features
   * are exposed (backwards-compatible with the bare config format).
   */
  available?: {
    providers?: ManifestProviderOption[];
    personas?: ManifestPersonaOption[];
    features?: {
      voice?: boolean;
      voiceInput?: boolean;
      voiceOutput?: boolean;
      rag?: boolean;
      crossPageRAG?: boolean;
      tools?: boolean;
      history?: boolean;
      crossSessionMemory?: boolean;
      settingsPanel?: boolean;
      skinSelector?: boolean;
    };
  };
  /**
   * Settings paths the deployer wants to prevent end-users from changing.
   * Path syntax: `llm.provider`, `storage.dbName`, `voice.engine`, etc.
   * The settings panel will render these as read-only.
   */
  locked?: string[];
}

export interface AcolyteConfig extends AcolyteManifest {
  /** Required at mount time. Manifest configs that omit it get a default
   *  filled in by splitManifest(). */
  llm: LLMConfig;
  /** Built-in shorthand or a custom persona object. */
  persona?: BuiltInPersona | CustomPersona;
  rag?: RAGConfig;
  tools?: ToolsConfig;
  ui?: UIConfig;
  voice?: VoiceConfig;
  storage?: StorageConfig;
  /** Optional plugins — see src/plugin.ts for the AcolytePlugin shape. */
  plugins?: AcolytePlugin[];
  /**
   * Optional: URL that returns a JSON object of API keys. Acolyte fetches
   * it at mount time and merges keys into `llm.apiKey` + tool configs only
   * if those slots are empty (user-typed values always win). Keep keys out
   * of the page and out of git this way.
   *
   * Expected response shape:
   *   { openaiKey?: string, anthropicKey?: string, geminiKey?: string, tavilyKey?: string }
   */
  keysEndpoint?: string;
}

/* ───── Public API ───── */

export interface AcolyteHandle {
  /** Open the chat panel. */
  open(): void;
  /** Close the chat panel. */
  close(): void;
  /** Toggle open/close. */
  toggle(): void;
  /** Send a message programmatically. */
  send(message: string): Promise<void>;
  /** Swap the persona at runtime. */
  setPersona(persona: BuiltInPersona | CustomPersona): void;
  /** Update any subset of the config in place. */
  configure(patch: Partial<AcolyteConfig>): void;
  /** Remove the widget from the DOM and clear listeners. */
  unmount(): void;
}
