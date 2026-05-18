# Acolyte

> **A drop-in web chat widget that reads the page with you.**
> Page-aware RAG, multi-provider LLMs, voice in + out (with neural TTS),
> a teacher persona that *points* at the page as it speaks, a plugin
> system, and a YAML-driven settings manifest. One-line install. Works
> in plain HTML, React, Svelte, Vue.

```html
<script type="module" src="/acolyte/index.js"
        data-config="acolyte.config.json"></script>
```

That's the whole install. Drop two lines on any page, supply a JSON or
YAML config next to it, and you have a page-aware chat assistant.

---

## Why this exists

Most embeddable chat widgets are a black box. They restate the page
back to you in slower words. Acolyte does the opposite: it assumes the
reader can already see the page and treats their time as expensive.
Every answer is **supplementary, ancillary, or net-new** information —
never a re-reading. This is enforced in the system prompt as the
project's single non-negotiable rule (see `CONSTITUTION.md`).

The mechanical consequences of that one rule shape the whole codebase:

- A **persona system** so a teacher chat behaves differently from a
  customer-support chat without code changes — only prompt-block
  composition.
- **Page-aware RAG** so the answer can name what the reader is looking
  at instead of regurgitating it.
- A **SPEAK block** in every response carrying *commentary about* the
  visible answer — read aloud by a voice that points at the relevant
  sections as it speaks ("voice-follow", see below).
- **Plugins** as the only extension surface so a new provider, persona,
  or tool drops in cleanly.

---

## Feature matrix

| Capability                          | Status | Notes                                                 |
|-------------------------------------|:------:|-------------------------------------------------------|
| Anthropic / OpenAI / Ollama / any OpenAI-compatible | ✅ | Streaming SSE, tool-call round-trip       |
| Page-aware RAG (BM25 over DOM)      | ✅     | Lazy-indexed, zero deps                                |
| Cross-page RAG plugin               | ✅     | Index a sitemap / explicit list / same-origin links    |
| Streaming responses                 | ✅     | All providers                                          |
| Native tool calls                   | ✅     | gemini_research, context7, deepAnalysis ship built-in  |
| Settings panel + inline model picker| ✅     | Dropdowns auto-populate from provider                  |
| Manifest YAML / JSON config         | ✅     | `available` / `defaults` / `locked` sections           |
| Personas (4 built-in + custom)      | ✅     | teacher, docs, business, bare                          |
| Composable prompt blocks            | ✅     | purpose, speak_commentary, math_latex, …               |
| Markdown rendering + KaTeX math     | ✅     | Inlined; no extra CDN                                  |
| Voice OUT — Web Speech              | ✅     | Default; uses OS-shipped voices                        |
| Voice OUT — Kokoro neural TTS       | ✅     | Opt-in; WebGPU when available                          |
| Voice IN — mic button (Web Speech)  | ✅     | Per-message + sticky listen                            |
| Voice-follow (SPEAK points at page) | ✅     | Inline `<ref id>` markers, scroll-only-if-offscreen    |
| Per-message 🔊 button with queue    | ✅     | Queues mid-stream until SPEAK block completes          |
| Source-citation cards (📚)          | ✅     | Same-page jump or cross-page navigate                  |
| History panel + recent-chats strip  | ✅     | Per-session, per-namespace                             |
| Response cache (IndexedDB)          | ✅     | Coarse key: provider+model+lastQ+system; 1000× speedup |
| Tool-result cache (IndexedDB)       | ✅     | Skip-on-hit, cost-saver for paid tools                 |
| Plugin system v0.2                  | ✅     | Hooks, RAG-source providers, UI slots                  |
| Width controls (narrow / wide / full)| ✅    | Cycled via header button or keyboard                   |
| IndexedDB cache + history namespace | ✅     | Multiple widgets coexist on one page                   |
| LaTeX in answers / no LaTeX in voice| ✅     | KaTeX renders, SPEAK paraphrases the formula           |
| Tiny CORS+keys proxy in Python      | ✅     | Optional. Loopback bind by default                     |

---

## Install

```bash
npm i acolyte
```

Or load directly from a CDN:

```html
<script type="module">
  import { mount } from 'https://cdn.jsdelivr.net/npm/acolyte/dist/index.js';
  mount({ llm: { provider: 'ollama' } });
</script>
```

Or the auto-mount form (no JS to write):

```html
<script type="module"
        src="https://cdn.jsdelivr.net/npm/acolyte/dist/index.js"
        data-config="acolyte.config.json"></script>
```

The script reads its `data-config` attribute, fetches that file, and
calls `mount()` for you on `DOMContentLoaded`.

---

## Minimal use

```ts
import { mount } from 'acolyte';

mount({
  llm: { provider: 'ollama', host: 'http://localhost:11434', model: 'qwen3:32b' }
});
```

That's it. The widget appears as a floating chat button bottom-right,
auto-scans the page for content, and is ready to chat.

---

## Providers

```ts
// Anthropic
mount({ llm: { provider: 'anthropic', apiKey: 'sk-ant-…', model: 'claude-sonnet-4-7' } });

// OpenAI
mount({ llm: { provider: 'openai',    apiKey: 'sk-…',     model: 'gpt-5-mini'       } });

// Ollama (local or LAN)
mount({ llm: { provider: 'ollama',    host:   'http://<your-ollama-host>:11434', model: 'qwen3:32b' } });

// Any OpenAI-compatible endpoint (LiteLLM, OpenRouter, vLLM, llama.cpp, Groq, Together, Gemini OpenAI-compat, …)
mount({
  llm: {
    provider: 'openai-compatible',
    baseUrl:  'http://localhost:4000/v1',
    model:    'mistral-large',
    apiKey:   'sk-…'   // optional depending on backend
  }
});
```

Every provider accepts a `baseUrl` and `headers` override — point at a
proxy to bypass CORS, route through a gateway, or hit any custom
hosting. The OpenAI-compatible adapter is what you use when, say, you
want to call Gemini via its OpenAI-compatible URL
(`https://generativelanguage.googleapis.com/v1beta/openai/`).

**Tool-call round-trip is fully wired.** When the model emits
`tool_calls` over SSE, Acolyte accumulates them, runs the tool,
re-injects the result with the correct `tool_call_id` + `name`, and
streams the second turn. Verified against Gemini and Anthropic.

---

## Personas

Built-in:

| Persona  | Use case                                                              |
|----------|-----------------------------------------------------------------------|
| `teacher` (default) | Course / tutorial pages. Hybrid narrator + SPEAK commentary. Voice points at the page.  |
| `docs`              | API / library docs. Strict citation grounding.                              |
| `business`          | Marketing / sales chat. Warm brand voice, no scrolling at the reader.       |
| `bare`              | Minimal. No role-play. Just page-RAG + answers.                              |

Use one by name, or define your own:

```ts
mount({
  llm: { provider: 'ollama' },
  persona: {
    role: 'You are a customer support agent for Acme Corp.',
    tone: 'professional',
    speakStyle: 'verbatim',      // 'commentary' | 'verbatim' | 'off'
    grounding: 'strict',         // 'strict' | 'permissive'
    greeting: 'Hi! How can I help?',
    promptBlocks: ['purpose', 'grounding_strict', 'formatting_terse']
  }
});
```

The `promptBlocks` array names the composable building blocks that
make up the system prompt. See `docs/personas.md` for the full block
registry (`purpose`, `speak_commentary`, `math_latex`,
`grounding_permissive`, `grounding_strict`, `tools`, `rag_passages`,
`memory_recall`, `formatting`, `formatting_terse`).

---

## Page-aware RAG

By default, Acolyte scans the host page for `<main>`, `<article>`,
then `<section>` blocks, and segments by `<h1>`/`<h2>`/`<h3>`.
Retrieval is BM25 in the browser — no embeddings, no sidecar JSON,
no setup.

```ts
mount({
  llm: { provider: 'ollama' },
  rag: {
    auto: true,                              // (default)
    // selector: '#docs-root',               // OR explicit selector
    // sections: [ { id, title, text }, … ], // OR provide content directly
    // sourceUrl: '/rag-content.json',       // OR fetch a sidecar JSON
    topK: 6,
    scoreFloor: 0,
    showSourceCards: true,                   // 📚 footer under each answer
    crossPageReferences: false               // see plugins below
  }
});
```

Each retrieved passage gets a stable DOM id. If the heading didn't
have one, the scanner stamps `acolyte-h-N` back onto the element so
voice-follow has something to scroll to.

### Cross-page RAG plugin

For multi-page sites, the `crossPageRAG` plugin fetches additional
pages, indexes them, and adds them to the BM25 pool. Source cards
from those passages become navigation links.

```ts
import { mount, crossPageRAG } from 'acolyte';

mount({
  llm: { provider: 'ollama' },
  rag: { crossPageReferences: true },
  plugins: [
    crossPageRAG({
      pages: ['/01-intro.html', '/02-concepts.html', '/03-api.html'],
      maxPages: 20,
      maxAgeMs: 24 * 60 * 60 * 1000,  // 1-day cache
      contentSelector: 'main, article, body'
    })
  ]
});
```

Or, from a JSON/YAML config (no JS entry point needed):

```yaml
plugins:
  - name: crossPageRAG
    pages:
      - /01-intro.html
      - /02-concepts.html
```

---

## Voice — out, in, and pointing

```ts
mount({
  llm: { provider: 'ollama' },
  voice: {
    enabled: true,
    autoSpeak: false,            // play every reply automatically
    accent: 'en-GB',
    gender: 'male',
    rate: 1.0,
    engine: 'auto',              // 'webspeech' | 'kokoro' | 'auto'
    kokoroVoice: 'bm_george'     // override Kokoro voice id
  }
});
```

### Two engines

- **Web Speech** (default) — `speechSynthesis` API. 0 KB, uses
  OS-shipped voices, quality varies by OS.
- **Kokoro neural TTS** (opt-in) — `kokoro-js` loaded from CDN on
  first use. ~80 MB ONNX model, cached forever after download.
  WebGPU when available, WASM-q8 fallback. Excellent prosody, fully
  offline after first load. 13 voices (American + British, male +
  female).

`engine: 'auto'` picks Kokoro when WebGPU is detected, otherwise Web
Speech. If Kokoro fails to load mid-session, the widget transparently
falls back to Web Speech for that utterance.

### Voice IN

Per-message mic button + a sticky listen toggle live in the composer
row. Uses `SpeechRecognition` with continuous + interim results, so
you see the partial transcript appear in the input as you talk.

### Voice-follow (the SPEAK pointer)

Every assistant response includes a hidden `[[SPEAK]] … [[/SPEAK]]`
block carrying *commentary about* the answer, not a re-reading. When
the model wants to point the reader at a specific section of the page,
it inserts an inline marker:

```
[[SPEAK]]
<ref id="optimizer-decision-tree">Look at this decision tree — the
trick is to walk top-down and stop at the first yes.
[[/SPEAK]]
```

The TTS engine splits speech by these markers, fires an `onRef(id)`
callback before each spoken segment, and the widget:

- **Scrolls only if** that section is fully offscreen, **and only
  on the first ref of the speech** — so the reader keeps control of
  their viewport.
- **Glows** the section with a soft fade (3.4 s, one shot) — a
  pointing finger, not a flashing alarm.
- **Dedupes** repeat refs to the same id within one speech.

See `docs/voice-follow.md` for the full mechanism and authoring tips.

---

## Tools

```ts
mount({
  llm: { provider: 'ollama' },
  tools: {
    geminiResearch: { apiKey: 'AIza…' },   // Google-grounded research
    context7:       { enabled: true },      // Live library docs (no key)
    deepAnalysis:   { apiKey: 'AIza…' },    // Long-form Gemini analysis
    verbose:        false                    // auto-expand tool drill-downs
  }
});
```

Tool calls render as inline drill-down blocks with timing and a
`📦 cached` badge on repeat hits. The tool-result cache (keyed by
`toolName + sha256(args)`) skips re-running the same query in the
same session — useful when `gemini_research` costs $0.03 per call.

Add custom tools via the plugin system (`docs/plugins.md`).

---

## Manifest config — pick what users can change

A single `acolyte.yaml` (or `.json`) file can declare *what the
settings UI exposes* alongside the runtime config:

```yaml
# acolyte.yaml — single source of truth for one deployment

keysEndpoint: http://localhost:8767/chat-config

defaults:
  llm:
    provider: openai-compatible
    baseUrl:  http://localhost:8767/gemini/v1beta/openai
    model:    gemini-2.5-flash
  persona: teacher

available:
  providers:
    - id: openai-compatible
      label: "Gemini (fast)"
      baseUrl: http://localhost:8767/gemini/v1beta/openai
      models: [ gemini-2.5-flash, gemini-2.5-pro ]
    - id: ollama
      label: "Local Ollama"
      host: http://localhost:11434
      models: auto
  personas:
    - { id: teacher,  label: "Teacher" }
    - { id: docs,     label: "Docs" }
  features:
    voice: true
    crossPageRAG: false

locked:
  - llm.provider          # users can pick a model but not switch providers
  - voice.engine
```

Three sections, three concerns:

- `defaults:` — what the widget USES at first run.
- `available:` — what the settings UI EXPOSES (dropdowns).
- `locked:` — settings paths the user cannot override.

See `docs/manifest.md` for the full schema.

---

## Settings panel

A built-in settings drawer (gear icon in the header) lets users tweak
without code:

- Provider + model (driven by `available.providers`)
- Persona
- Voice engine, accent, gender, rate
- RAG: source-card visibility, cross-page references toggle
- Storage: clear cache, clear history
- Width: narrow / wide / full

Everything respects the manifest's `locked` list — locked fields
render disabled.

---

## Plugins

Plugins are objects that ship hooks, capabilities, or UI slots. The
shape lives in `src/plugin.ts`; here is a minimal one:

```ts
import { mount, type AcolytePlugin } from 'acolyte';

const myPlugin: AcolytePlugin = {
  name: 'my-plugin',
  version: '1.0.0',
  hooks: {
    beforeSend: ({ messages }) => {
      // mutate or replace messages
    },
    afterResponse: ({ response }) => {
      // record metrics, etc.
    }
  }
};

mount({ llm: { provider: 'ollama' }, plugins: [myPlugin] });
```

Available hooks: `beforeSend`, `afterResponse`, `onToolCall`,
`onMessageRender`. Plugins can also register `providers`, `tools`,
`personas`, `ragSources`, and UI slots (buttons in the composer or
header, panel sections in settings). See `docs/plugins.md`.

The built-in `crossPageRAG` is itself just a plugin you can crib from.

---

## Programmatic control

```ts
const handle = mount({ llm: { provider: 'ollama' } });

handle.open();
handle.close();
handle.toggle();

await handle.send('Walk me through this page.');

handle.setPersona('docs');
handle.configure({ ui: { accent: '#FF0080' } });
handle.unmount();
```

---

## Storage

Cache + history + cross-session memory all live in IndexedDB. Default
DB name: `acolyte-chat`. Namespace per-page so two Acolyte widgets
don't collide:

```ts
mount({ llm: {...}, storage: { dbName: 'mysite-chat', cacheEnabled: true, historyEnabled: true } });
```

### Caching behavior

- **Response cache**: keyed on `(provider, model, lastUserMsg,
  systemPrompt)`. Because the system prompt encodes persona + RAG
  passages + module context, any of those changing invalidates the
  cache automatically. Verified 1000× speedup on repeat queries.
- **Tool-result cache**: keyed on `(toolName, sha256(args))`. Same
  IndexedDB store, `TOOL:` prefix. Saves real money on paid tools.
- Both can be disabled via `storage.cacheEnabled: false` or the
  settings-panel toggle.

---

## The optional CORS+keys proxy

A tiny Python script in `server/cors-proxy.py` does three things:

1. Strips CORS pain by reverse-proxying to Ollama (or any backend).
2. Reads API keys from `.env` and surfaces them to the widget via
   `GET /chat-config` so keys live out of git and out of the page.
3. Provides path-prefix routes for upstream LLM APIs you don't want
   the browser to hit directly.

```bash
cd server
cp .env.example .env       # fill in keys
python3 cors-proxy.py
# [proxy] listening on 127.0.0.1:8767 -> http://localhost:11434
```

**Security defaults: loopback bind.** The proxy binds to `127.0.0.1`
by default — only the local machine can fetch keys via `/chat-config`.
Setting `LISTEN_HOST=0.0.0.0` exposes keys to the LAN and prints a
loud startup warning. Full threat model + audit checklist in
`docs/security.md`.

---

## Framework examples

See `examples/` for HTML, React, Svelte, Vue starters. Acolyte is
framework-agnostic — it only needs a DOM and a `mount()` call.

```html
<!-- examples/html/index.html — the simplest possible setup -->
<!doctype html>
<html><body>
  <main>
    <h1>My docs page</h1>
    <p>Content the widget will scan automatically.</p>
  </main>
  <script type="module" src="./acolyte/index.js"
          data-config="acolyte.config.json"></script>
</body></html>
```

---

## Build from source

```bash
npm i
npm run typecheck
npm run build       # produces dist/index.js (ESM) + dist/index.cjs (CJS) + dist/index.d.ts
```

CSS is inlined into the bundle at build time (`define: __ACOLYTE_CSS__`
in `tsup.config.ts`), so the consumer never imports a separate
stylesheet.

### Run the smoke test

```bash
# Terminal 1
cd examples/html
python3 -m http.server 8766 --bind 127.0.0.1

# Terminal 2 (only if you want /chat-config to surface keys)
cd server
python3 cors-proxy.py
```

Open `http://localhost:8766/` and look bottom-right for the chat
button. Full E2E protocol in `docs/testing.md`.

---

## Documentation map

| Doc                       | When to read                                                 |
|---------------------------|--------------------------------------------------------------|
| `CONSTITUTION.md`         | First — the one non-negotiable principle                     |
| `MEMORY.md`               | Project status snapshot                                       |
| `docs/architecture.md`    | Bird's-eye map of modules + data flow                        |
| `docs/config.md`          | All four config loading patterns                              |
| `docs/manifest.md`        | YAML manifest schema, `available`/`defaults`/`locked`        |
| `docs/personas.md`        | Built-in + custom personas, all prompt blocks                 |
| `docs/plugins.md`         | Plugin anatomy, hooks, capabilities, UI slots                 |
| `docs/voice-follow.md`    | The `<ref>` mechanism, authoring for voice-pointed pages     |
| `docs/security.md`        | Threat model, audit checklist, key handling                   |
| `docs/testing.md`         | E2E test topology, two-command bring-up                      |

---

## Versioning

`0.1.0` — pre-release. API surface is stable enough to build against
but expect changes labeled in the changelog before `1.0`. We follow
semver from `1.0` onward.

---

## License

MIT — see [LICENSE](./LICENSE).
