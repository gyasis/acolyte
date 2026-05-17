# Acolyte

> A drop-in web chat widget that reads the page with you. Page-aware RAG, multi-provider LLMs, voice in + out, persona system. One-liner install. Works in plain HTML, React, Svelte, Vue.

## Install

```bash
npm i acolyte
```

Or via CDN (no install):

```html
<script type="module">
  import { mount } from 'https://cdn.jsdelivr.net/npm/acolyte/dist/acolyte.js';
  mount({ llm: { provider: 'ollama' } });
</script>
```

## Minimal use

```ts
import { mount } from 'acolyte';

mount({
  llm: { provider: 'ollama', host: 'http://localhost:11434', model: 'qwen3:32b' }
});
```

That's it. The widget appears as a floating chat button bottom-right, auto-scans the page for content, and is ready to chat.

## Providers

```ts
// Anthropic
mount({ llm: { provider: 'anthropic', apiKey: 'sk-ant-…', model: 'claude-sonnet-4-7' } });

// OpenAI
mount({ llm: { provider: 'openai',    apiKey: 'sk-…',     model: 'gpt-5-mini'       } });

// Ollama (local or LAN)
mount({ llm: { provider: 'ollama',    host:   'http://<your-ollama-host>:11434', model: 'qwen3:32b' } });

// Any OpenAI-compatible endpoint (LiteLLM, OpenRouter, vLLM, llama.cpp, Groq, Together, …)
mount({
  llm: {
    provider: 'openai-compatible',
    baseUrl:  'http://localhost:4000/v1',
    model:    'mistral-large',
    apiKey:   'sk-…'   // optional depending on backend
  }
});
```

Every provider accepts a `baseUrl` and `headers` override — point at a proxy to bypass CORS, route through a gateway, or hit any custom hosting.

## Personas

Built-in:

| Persona  | Use case |
|---|---|
| `teacher` (default) | Course / tutorial pages — narrator-with-commentary voice |
| `docs`              | API / library docs — strict citation grounding |
| `business`          | Marketing / sales chat — warm brand voice |
| `bare`              | Minimal — no role-play, just page-RAG |

Override per-instance:

```ts
mount({
  llm: { provider: 'ollama' },
  persona: {
    role: 'You are a customer support agent for Acme Corp.',
    tone: 'professional',
    speakStyle: 'verbatim',
    grounding: 'strict',
    greeting: 'Hi! How can I help?'
  }
});
```

## RAG (page-aware)

By default, Acolyte scans the host page for `<main>`, `<article>`, then `<section>` blocks and segments by `<h1>`/`<h2>`/`<h3>`. Retrieval is BM25 in the browser — no embeddings, no sidecar JSON, no setup.

```ts
mount({
  llm: { provider: 'ollama' },
  rag: {
    auto: true                                  // (default)
    // selector: '#docs-root',                  // OR explicit selector
    // sections: [ { id, title, text }, ... ],  // OR explicit content
    // sourceUrl: '/rag-content.json',          // OR fetch sidecar
    // topK: 5, scoreFloor: 0
  }
});
```

## Voice

```ts
mount({
  llm: { provider: 'ollama' },
  voice: {
    enabled: true,
    autoSpeak: false,            // play every reply automatically
    accent: 'en-GB',             // 'en-GB' | 'en-US' | 'en-AU' | 'en-IN' | string
    gender: 'male',
    rate: 1.0
  }
});
```

Auto-picks the best matching OS voice. Voice-IN (mic) is wired in the next release; voice-OUT works today.

## Tools

```ts
mount({
  llm: { provider: 'ollama' },
  tools: {
    geminiResearch: { apiKey: 'AIza…' },        // Google-grounded research
    context7:       { enabled: true },           // Live library docs (no key)
    deepAnalysis:   { apiKey: 'AIza…' }          // Long-form Gemini analysis
  }
});
```

Tool support depends on the LLM. Ollama models with native tool-calling templates (qwen3, mistral family, devstral, gpt-oss, qwq) use the proper `tools` API. Other models can still call tools via a text protocol fallback.

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

## Framework examples

See `examples/` for HTML, React, Svelte, Vue starters. Acolyte is framework-agnostic — it only needs a DOM and a `mount()` call.

## Storage

Cache + history + cross-session memory all live in IndexedDB (`acolyte-chat` database by default). Clear them via:

```ts
handle.configure({ storage: { cacheEnabled: false, historyEnabled: false } });
```

Or namespace per-page so two Acolyte widgets don't collide:

```ts
mount({ llm: {...}, storage: { dbName: 'mysite-chat' } });
```

## Build from source

```bash
npm i
npm run build       # produces dist/acolyte.js (ESM) + dist/acolyte.cjs (CJS) + dist/acolyte.d.ts
npm run typecheck
```

## License

MIT
