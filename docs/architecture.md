# Architecture

How the pieces fit. Read this before changing anything in `src/`.

## Bird's-eye

```
       ┌──────────────────────────────────────────────────────┐
       │                  Host web page                       │
       │  ┌──────────┐                          ┌──────────┐  │
       │  │ <article>│                          │ FAB 💬   │  │
       │  │  content │                          └─────┬────┘  │
       │  │ to RAG   │                                │       │
       │  └──────────┘                                ▼       │
       │                                  ┌────────────────┐  │
       │                                  │  Acolyte panel │  │
       │                                  └────────────────┘  │
       └──────────────────────────┬───────────────────────────┘
                                  │ mount(config)
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                       Acolyte runtime                        │
   │                                                              │
   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
   │  │ Providers    │  │ RAG engine   │  │ TTS engine   │        │
   │  │ (LLM dispatch│  │ (BM25 over   │  │ (SpeechSyn   │        │
   │  │  + streaming)│  │  page DOM)   │  │  + persona   │        │
   │  └──────────────┘  └──────────────┘  │  voice pick) │        │
   │         │                │           └──────────────┘        │
   │         │                │                                   │
   │  ┌──────▼────────────────▼──────────────────────────────┐    │
   │  │              Widget UI engine                        │    │
   │  │  (chat loop, system prompt assembly, rendering)      │    │
   │  └────┬─────────────────┬─────────────────────┬─────────┘    │
   │       │                 │                     │              │
   │       ▼                 ▼                     ▼              │
   │  ┌──────────┐  ┌────────────────┐  ┌────────────────────┐   │
   │  │ Personas │  │ Tools          │  │ PluginHost         │   │
   │  │ (teacher,│  │ (gemini_research│  │ (hooks + caps +    │   │
   │  │  docs,…) │  │  context7, …)  │  │  UI slots)          │   │
   │  └──────────┘  └────────────────┘  └─────────┬──────────┘   │
   │                                              │              │
   │  ┌──────────────────────────────┐  ┌─────────▼──────────┐   │
   │  │ IndexedDB (ChatDB)           │  │ Plugins            │   │
   │  │  - conversations             │  │ (crossPageRAG, …)  │   │
   │  │  - response cache            │  └────────────────────┘   │
   │  │  - tool-result cache         │                           │
   │  └──────────────────────────────┘                           │
   └─────────────────────────────────────────────────────────────┘
```

## Module responsibilities

| Module | Owns | Does not own |
|---|---|---|
| `src/widget.ts` | UI engine, system prompt assembly, chat loop, render pipeline | Provider transport, RAG retrieval, tool execution |
| `src/providers/index.ts` | LLM adapters with streaming, native function-calling | Prompt content, history shape |
| `src/internal/rag.ts` | BM25 retrieval, DOM segmentation, passage indexing | Where content comes from (plugins supply that) |
| `src/internal/db.ts` | IndexedDB conversations + cache stores | Cache policy (widget decides what/when to cache) |
| `src/internal/tts.ts` | SpeechSynthesis + voice picker + SPEAK block parsing | When to speak (widget decides) |
| `src/tools/index.ts` | Built-in tool implementations (Gemini, Context7) | Tool dispatch (widget orchestrates) |
| `src/personas/*` | System-prompt building blocks per use case | Provider selection, RAG behaviour |
| `src/plugin.ts` | PluginHost runtime + plugin type contracts | Any specific plugin (those go in `src/plugins/`) |

## Data flow — one user message, end to end

```
1. User types question, hits send
   │
   ▼
2. widget.send(q)
   │
   ├─→ append user bubble
   ├─→ push to state.history
   │
3. Cache lookup
   │   key = SHA256(provider + model + lastUserMsg + activeContextKey)
   ├─→ HIT: return cached response, badge "📦 cached"
   └─→ MISS: continue
   │
4. Build system prompt
   │
   ├─→ persona.role + grounding rules + speak rules + tools list + math rules
   ├─→ + RAG passages (from RAG engine + plugin sources)
   ├─→ + cross-session memory (from ChatDB.searchConversations)
   │
5. PluginHost.runBeforeSend(ctx)
   │   plugins may modify messages, add system context, etc.
   │
6. providers.send(llm, messages, { onDelta, tools })
   │
   ├─→ Streaming: NDJSON (Ollama) or SSE (Anthropic/OpenAI)
   ├─→ onDelta fires per token → widget updates the bubble incrementally
   ├─→ Native tool_calls returned → widget executes via tools.run() or plugin tools
   │
7. PluginHost.runAfterResponse(ctx)
   │   plugins observe (analytics, persistence, etc.)
   │
8. Persist
   │
   ├─→ ChatDB.cachePut(provider, model, messages, response, contextKey)
   ├─→ ChatDB.appendMessage(convId, {role, content})
   │
9. Voice (optional)
   │
   ├─→ Extract [[SPEAK]] block via tts.extractSpeakBlock()
   ├─→ If autoSpeak or user clicks 🔊 → tts.speak(text)
```

## Lifecycle

```
mount(config)
  │
  ├─→ create ChatDB(config.storage.dbName)
  ├─→ create RAGEngine(config.rag)
  ├─→ create TTSEngine(config.voice)
  ├─→ create Tools(config.tools)
  ├─→ create PluginHost
  │   └─→ for each plugins[]: host.add(plugin)
  │
  ├─→ buildPanel() — inject FAB + panel into DOM
  ├─→ install keyboard shortcuts
  │
  └─→ PluginHost.initAll(handle, helpers)
       └─→ for each plugin: plugin.init?.(handle, ctx)

(running…)
  ├─→ user opens panel → probe() shows provider status
  ├─→ user sends message → flow above
  ├─→ user closes panel
  ├─→ user clicks new conversation → state.history = []

unmount()
  │
  ├─→ PluginHost.runOnClose()
  ├─→ remove FAB + panel from DOM
  └─→ release listeners
```

## What's intentionally simple

- **No virtual DOM, no framework.** A small `el()` helper builds nodes
  directly. Easier to embed in any host, smaller bundle.
- **One file per concern.** Each module is self-contained — easier to
  refactor or replace.
- **No reactive state library.** A flat `state` object inside `widget.ts`
  drives all UI updates. The widget re-renders the relevant fragment
  when state changes; no diff engine needed.
- **No global event bus.** Plugins register hooks via the `PluginHost`
  contract. Plugins don't communicate with each other except through
  the widget.

See `docs/plugins.md` for the plugin system in detail.
