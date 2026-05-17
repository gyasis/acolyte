# Acolyte — Project Constitution

A short, opinionated statement of what this project is, what it is not, and
the rules that govern decisions. Read this before adding anything to the
codebase.

## Identity

**Acolyte is a drop-in web chat widget that reads the page with you.**

Not a framework. Not a backend. Not a server. Not a SaaS. It is a single
TypeScript package that ships a chat panel any web page can embed — vanilla
HTML, React, Svelte, Vue, anything. The widget knows about the content of
the host page (page-aware RAG), can talk to any LLM (Anthropic / OpenAI /
Ollama / OpenAI-compatible proxies), holds conversation history in the
browser, speaks responses out loud, and is extended by plugins.

## Purpose — the one principle that drives every other decision

**Acolyte does NOT repeat the page back to the reader.**

The reader can already see the page. Reading it aloud, summarizing it,
or restating its content adds zero value and wastes their time. Instead,
the widget's job is to supply **supplementary, ancillary, or net-new
information** *grounded in* what the reader sees:

- **Supplementary** — explain a concept the page mentions but doesn't
  expand on. Define a term. Walk through the intuition.
- **Ancillary** — context the page doesn't include. Related topics.
  Historical background. Comparisons with adjacent ideas. Where this
  fits in the bigger picture.
- **Net-new** — answer questions the page does not. Apply the page's
  content to the reader's specific situation. Pull in live data via tools.
  Cross-reference with other pages on the site.

Every system prompt, every persona, every plugin, every retrieval result
flows from this principle. The page is the floor under the conversation;
the widget is the room above it. If a reply could be replaced by
"reread paragraph 3 of the page", the widget failed.

This is why:
- The SPEAK style defaults to **commentary**, not verbatim restatement
- The grounding mode `'permissive'` is preferred for tutorial / docs
  use cases (free the model to teach beyond the page when relevant)
- Cross-page RAG, web search, and deep-analysis tools exist (to reach
  for net-new info when the page is silent)
- The default persona is `teacher` — a teacher does not read the
  textbook aloud, they explain it
- Personas like `bare` and `verbatim` SPEAK style exist for use cases
  where this principle should be overridden (e.g., genuine read-aloud
  accessibility tools) — but they are explicit opt-outs, not defaults

## What we are NOT

- **Not a backend service.** The widget runs entirely in the browser.
  An optional Python CORS proxy ships in `cors-proxy.py`, but it is a
  shim — never a runtime requirement of the widget itself.
- **Not coupled to any specific consuming project.** The SIO course at
  `~/Documents/code/SIO/dspy-course/` is a *test page* that demonstrates
  the widget in a real page; it is NOT the project. Acolyte's repo does
  not reference SIO, and SIO must not embed acolyte's source files
  directly — it should consume acolyte's built `dist/` only.
- **Not tied to any one LLM provider.** Provider adapters live behind
  a uniform interface. Adding a new provider (Cohere, Mistral, custom
  WebSocket) is a plugin.
- **Not tied to any one UI framework.** The widget mounts via plain
  DOM. Framework wrappers (React/Vue/Svelte) are thin shims that call
  `mount(config)` from a lifecycle hook.

## Core principles

0. **Supplement, never restate.** See the Purpose section above. This is
   the principle every other principle answers to.
1. **Static-friendly.** Everything must work in a plain HTML page served
   from a CDN. No build step required for the consumer; we ship a single
   ES module + CSS file.
2. **Configuration > hardcoding.** Every default must be overridable.
   Provider URLs, persona prompts, API keys, RAG content sources, voice
   choices, storage namespace — all configurable at `mount()` time.
3. **Plugins for extensibility.** Anything that one consumer might want
   that another might not goes through the plugin system, not into the
   core. Cross-page RAG, handoff to human, analytics, lead capture,
   alternate TTS engines — all plugins.
4. **The host page owns the look.** The widget's default CSS uses
   custom properties (`--acolyte-accent`, etc.) so a host page can theme
   it by setting those vars. A `theme: 'inherit'` mode pulls the host
   page's tokens automatically.
5. **No secrets in source.** API keys never appear in any committed
   file. Keys come from one of three runtime sources:
   (a) env via the optional proxy's `/chat-config`,
   (b) a gitignored `config.local.js`,
   (c) the user typing them into the settings panel.
6. **Privacy by default.** No telemetry, no analytics, no remote logging.
   IndexedDB stays local. Plugins that send data outward must say so in
   their docs.

## Dependencies (pinned in `package.json`)

| Package      | Purpose                                | Why this one |
|--------------|----------------------------------------|--------------|
| `marked`     | Markdown → HTML                        | Standard, small, fast |
| `dompurify`  | HTML sanitization for LLM output       | The de-facto choice; XSS-safe |
| `katex`      | Math rendering ($…$ and $$…$$)        | Server-render-capable, smaller than MathJax |

**Dev:** `tsup` (bundling), `typescript` (5.5+), `@types/dompurify`.

**Runtime requirements**

- Node 20+ for dev
- Browser: Chrome 90+ / Safari 15+ / Firefox 90+ (WebSpeech, async iterators, BigInt)
- Optional: Python 3.9+ for `cors-proxy.py` if you need it

## Versioning & releases

- Semver. 0.x while the public API may shift.
- Private repo for now. We do not publish to npm until the API stabilizes.
- Consumers depend on acolyte via `npm i /path/to/acolyte` (local file
  dep) or by pulling the prebuilt `dist/` into their site.

## Decisions that are locked in

- TypeScript source, dual ESM + CJS output via `tsup`.
- Single bundled output file (no peer deps). Heavier install but zero
  install friction for consumers.
- IndexedDB for storage — never Redis, never localStorage for anything
  larger than settings.
- Plugin hooks dispatch in registration order. Failures in one plugin
  are isolated and logged; they do not break others.
- Persona system controls *behavior*, not *appearance*. Theming is a
  separate concern (see `docs/styling.md`).

## Out of scope (forever, or for a long time)

- Hosted SaaS version of acolyte
- A server-side rendering story (acolyte is browser-side by design)
- Mobile app SDKs (web view is sufficient)
- Replacing the LLM with a built-in model (use a provider)

## Conventions for contributors

- Source TypeScript only. No JS in `src/`.
- DOM access via the `el()` helper in `src/widget.ts`. No JSX.
- Public API surface lives in `src/types.ts`. Add to it; do not break it.
- Every public function has a JSDoc comment.
- Every plugin hook has a JSDoc explaining when it fires and what side
  effects are allowed.
- No new external runtime deps without a constitution amendment.
