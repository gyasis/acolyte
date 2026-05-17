# Acolyte — Memory Bank

A single index of project state. Update this whenever a non-trivial
decision is made, a new doc is added, or a major piece lands. Future
sessions read this first to know where things stand.

> **Read in order:** `CONSTITUTION.md` → this file → `README.md` →
> the specific `docs/` page for the area you are working on.

---

## Status snapshot

**Version:** 0.1.0 (pre-release, private)
**Last major work:** Plugin system + cross-page RAG plugin shipped.
Memory bank + docs structure stood up. Decoupled mentally from the SIO
test page.

**What works today:**
- Multi-provider LLM dispatch (Anthropic, OpenAI, Ollama, OpenAI-compatible)
- All providers accept `baseUrl` + `headers` overrides (proxy / aggregator support)
- Streaming responses (NDJSON for Ollama, SSE for cloud)
- Page-aware BM25 RAG with auto-detect (`<main>` → `<article>` → `<section>` → `<body>`, segmented by `<h1>`/`<h2>`/`<h3>`)
- Four built-in personas: `teacher`, `docs`, `business`, `bare`
- IndexedDB-backed response cache, tool-result cache, and conversation history
- Cross-session memory injection at send time
- Web Speech text-to-speech with male British English auto-pick (configurable)
- Tools: Gemini grounded research, Context7 docs, Gemini deep analysis
- Markdown + LaTeX rendering on the written answer
- **Plugin system** — hooks (`beforeSend`, `afterResponse`, `onToolCall`, `onMessageRender`, `onPersonaChange`, `onClose`) + capability registration (providers, tools, personas, RAG sources) + UI slots (header buttons, message actions, footer note, panel sections)
- **Cross-page RAG plugin** — first concrete plugin; fetches other pages of the same site, caches in IndexedDB, contributes passages to the RAG query
- Built and typed (ESM 367 KB raw / ~120 KB gzipped + CJS + `.d.ts`)

**What's known but not yet built:**
- CSS theme modes: `inherit` / `light` / `dark` / `custom` (config exists in spirit, full implementation pending)
- Settings panel UI (currently config is only set at `mount()` time)
- History panel + recent-chats strip UI
- Drill-down tool blocks with timing and verbose toggle
- Source-card click-to-jump (cross-page navigation when source is on another page)
- Voice input (mic button using Web Speech recognition)
- Framework wrappers (`@acolyte/react`, `@acolyte/vue`, `@acolyte/svelte`)

**What lives in test pages, not in acolyte:**
- The SIO dspy-course at `~/Documents/code/SIO/dspy-course/` is a sample
  page used to verify the widget works end-to-end. It currently embeds
  an OLDER copy of the chat code in its own `chat/` folder. That older
  copy will be replaced by an `import { mount } from 'acolyte'` call
  pointing at this package's `dist/` output. Acolyte's repo must not
  reference SIO; SIO is a downstream consumer.

---

## Where things live

```
~/Documents/code/acolyte/                ← THIS REPO
├── CONSTITUTION.md                       ← principles + dependencies + scope
├── MEMORY.md                             ← this file
├── README.md                             ← consumer-facing intro
├── package.json                          ← npm metadata; dual ESM + CJS exports
├── tsconfig.json                         ← strict TS
├── tsup.config.ts                        ← build config
├── docs/
│   ├── architecture.md                   ← how the pieces fit
│   ├── plugins.md                        ← plugin system reference
│   ├── providers.md                      ← provider config + custom endpoints
│   ├── personas.md                       ← persona system
│   ├── rag.md                            ← RAG modes (auto / selector / explicit / sidecar / cross-page)
│   ├── security.md                       ← key handling, no-secrets-in-source policy
│   ├── styling.md                        ← CSS themes + host-page inheritance
│   └── testing.md                        ← how to test using the SIO test page
├── src/
│   ├── index.ts                          ← public API entry
│   ├── types.ts                          ← full AcolyteConfig + sub-types
│   ├── widget.ts                         ← UI engine + chat loop
│   ├── plugin.ts                         ← plugin system + PluginHost
│   ├── styles.css                        ← scoped .acolyte-* CSS
│   ├── katex-shim.d.ts
│   ├── providers/index.ts                ← Anthropic/OpenAI/Ollama/compat adapters
│   ├── personas/
│   │   ├── teacher.ts (default)
│   │   ├── docs.ts
│   │   ├── business.ts
│   │   ├── bare.ts
│   │   └── index.ts
│   ├── internal/
│   │   ├── db.ts                         ← IndexedDB wrapper
│   │   ├── rag.ts                        ← BM25 retrieval + DOM auto-detect
│   │   └── tts.ts                        ← SpeechSynthesis + voice picker
│   ├── tools/index.ts                    ← Gemini research, Context7, deep analysis
│   └── plugins/                          ← built-in plugins
│       └── crossPageRAG.ts               ← multi-page RAG source provider
├── examples/
│   ├── html/
│   │   ├── index.html                    ← one-line script-tag integration
│   │   └── acolyte.config.json           ← all config lives here, not in HTML
│   ├── react/                            ← TODO
│   ├── svelte/                           ← TODO
│   └── vue/                              ← TODO
├── server/                               ← optional Python CORS proxy
│   ├── cors-proxy.py                     ← reads .env, forwards to Ollama
│   ├── .env.example                      ← template for the gitignored .env
│   └── README.md                         ← how to run it
└── dist/                                 ← built; gitignored

~/Documents/code/SIO/dspy-course/        ← TEST PAGE (separate project)
└── Old embedded chat. To migrate, replace its <script> tags with the
   acolyte one-line loader pointing at acolyte/dist/index.js.
```

---

## Recent decisions

- **2026-05-17 — DSPy course migrated to acolyte.** First real
  integration test. The course's `_base.html` lost its 6 embedded chat
  scripts + 5 CDN deps; replaced with a single `<script type="module"
  src="acolyte/index.js" data-config="acolyte.config.json">` loader.
  Symlink `dspy-course/acolyte → acolyte/dist` keeps it always fresh.
  Claude skin retained, acolyte accent set to terracotta (`#CC785C`)
  for visual harmony. See `docs/testing.md` for the full topology.
- **2026-05-17 — Decoupled from SIO.** The SIO course is now treated
  strictly as a downstream consumer / test page. Acolyte's repo and
  docs no longer reference SIO paths. cors-proxy copied into
  `acolyte/server/` so the project is fully self-contained.
- **2026-05-17 — Plugin system shipped.** Hooks + capability
  registration + UI slots. First plugin (`crossPageRAG`) validates the
  design. See `docs/plugins.md`.
- **2026-05-17 — Security audit.** All hardcoded private IPs removed
  from source. `cors-proxy.py` reads `OLLAMA_UPSTREAM` from `.env`.
  No API keys in any committed file. See `docs/security.md`.
- **2026-05-16 — Persona system.** Four built-in (`teacher`, `docs`,
  `business`, `bare`) plus custom. Persona controls behavior + SPEAK
  style + grounding policy. See `docs/personas.md`.
- **2026-05-16 — KaTeX adopted for math.** SPEAK rules say "describe
  what the formula captures" — never read symbols aloud.
- **2026-05-16 — Project named.** `acolyte` — chosen for the
  apprentice-narrator framing.

---

## Open questions

- Should the React/Vue/Svelte wrappers be sub-packages
  (`@acolyte/react`) or kept inside this repo as separate entry points?
  Leaning sub-packages once the API stabilizes.
- Plugin discovery / registry — eventually we may want a
  `plugins.acolyte.dev` style index. Out of scope for v0.x.
- Should the cors-proxy ship as a standalone npm package
  (`@acolyte/cors-proxy`)? Probably yes once we move to a public release.
