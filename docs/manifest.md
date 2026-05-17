# Acolyte manifest config — `acolyte.yaml` (or `.json`)

> **Principle:** every setting lives in this file. Source code never
> hardcodes a model name, a host, a key, or a feature flag. The dev edits
> ONE file; the widget consumes it; the settings UI builds its dropdowns
> from the same source of truth.

## Why this exists

Two concerns the user has historically wanted in one file:

1. **Defaults** — what the widget actually uses when it first loads
2. **Manifest** — what the widget *makes available* in its settings UI
   (which providers / models / personas / features the deployer wants the
   end user to be able to pick)

They are the same file. The settings UI dropdowns are populated from the
`available:` section. The pre-selected values come from the `defaults:`
section. End users can change selections (saved in IndexedDB) — but only
within the bounds set by `available:`.

## File location

`acolyte.yaml` (or `.json`) sits next to the page that loads acolyte:

```html
<script type="module" src="acolyte/index.js" data-config="acolyte.yaml"></script>
```

YAML is preferred for hand-editing; JSON works for tools / programmatic
generation. Acolyte detects the format from the file extension.

## Top-level shape

```yaml
# acolyte.yaml — single source of truth for one deployment

# 1) Where to get API keys at runtime (never inline them here)
keysEndpoint: "http://localhost:8767/chat-config"

# 2) What the dev wants this deployment to EXPOSE
available:
  providers:
    - id: openai
      label: OpenAI
      models:
        - id: gpt-4o-mini   ; label: "GPT-4o mini (fast)"   ; default: true
        - id: gpt-4o        ; label: "GPT-4o"
        - id: gpt-5-mini    ; label: "GPT-5 mini"
        - id: gpt-5         ; label: "GPT-5"
    - id: anthropic
      label: Anthropic Claude
      models:
        - id: claude-haiku-4-5    ; label: "Haiku 4.5 (fast)"  ; default: true
        - id: claude-sonnet-4-7   ; label: "Sonnet 4.7"
        - id: claude-opus-4-7     ; label: "Opus 4.7"
    - id: ollama
      label: Local Ollama
      host: "http://localhost:8767"   # via the cors-proxy
      models: auto                     # ← discover via /api/tags at mount

  personas:
    - id: teacher    ; label: "Teacher (default)"
    - id: docs       ; label: "Docs assistant"
    - id: business   ; label: "Business support"
    - id: bare       ; label: "Bare (no persona)"
    # custom personas:
    - id: sales
      label: "Sales rep"
      role: "You are a friendly sales rep for Acme Corp..."
      tone: warm
      speakStyle: commentary
      grounding: permissive

  features:
    voice:            true
    voiceInput:       true     # 🎤 mic button
    voiceOutput:      true     # 🔊 per-message
    rag:              true     # page-aware retrieval
    crossPageRAG:    false     # multi-page indexing (plugin)
    tools:            true     # function calling
    history:          true     # IndexedDB persistence
    crossSessionMemory: true   # past-conversation memory
    settingsPanel:    true     # let user override defaults in-browser
    skinSelector:     false    # don't expose theme swap to users

# 3) What the widget USES at first run (overridable by user via settings UI)
defaults:
  llm:
    provider: openai
    model: gpt-4o-mini
  persona: teacher
  ui:
    accent: "#CC785C"
    position: right
    keyboardShortcut: "mod+k"
  voice:
    accent: en-GB
    gender: male
    rate: 1.0
    autoSpeak: false
  rag:
    auto: true
    topK: 5
  storage:
    dbName: "acolyte-mydeployment"

# 4) Tool toggles + endpoints (keys come from keysEndpoint)
tools:
  geminiResearch:
    enabled: true
    model: gemini-2.5-flash
  context7:
    enabled: true
  deepAnalysis:
    enabled: true
    model: gemini-1.5-flash-latest
  verbose: false

# 5) Plugins to load (path-or-name; same shape as the `plugins: []` array)
plugins:
  - crossPageRAG:
      pages: ["/", "/about", "/pricing"]
      maxPages: 20

# 6) Optional: hard locks — dev can prevent the user from ever changing certain things
locked:
  - llm.provider          # user can pick OpenAI's models but cannot switch to Ollama
  - storage.dbName        # always the same DB
```

## How the widget reads it

```
auto-mount sequence:
  1. Fetch the data-config URL  →  raw YAML/JSON
  2. Parse into Manifest
  3. Apply `defaults.*`         →  initial settings state
  4. Load saved overrides       ←  IndexedDB (only for fields NOT in `locked`)
  5. Build the runtime AcolyteConfig
  6. Render the settings panel using `available.*` to drive dropdowns
  7. Mount the widget
```

## YAML vs JSON tradeoff

| | YAML | JSON |
|---|---|---|
| Human-friendly | ✅ comments, multiline strings, no quotes needed | ❌ |
| Parse overhead in browser | needs `js-yaml` (~30 KB gzipped) | native |
| Round-trip safe (editing without breaking) | ⚠ indentation matters | ✅ |
| Used in CI / scripts | ✅ | ✅ |

**Default:** support both. If `data-config` ends in `.yaml` or `.yml`, lazy-load `js-yaml`. Otherwise parse as JSON.

## Migration from the current minimal `acolyte.config.json`

The current file is the `defaults` section flattened. To migrate, wrap it:

```jsonc
// before — flat
{ "llm": { "provider": "openai", "model": "gpt-4o-mini" }, "persona": "teacher" }

// after — with manifest sections
{
  "available": { ... what the user can choose from ... },
  "defaults":  { "llm": { "provider": "openai", "model": "gpt-4o-mini" }, "persona": "teacher" }
}
```

Backwards-compatible: if no `available:` section exists, the widget treats
the file as just `defaults` (current behavior).

## What this unlocks

| Feature (queued) | Reads from manifest |
|---|---|
| Settings panel UI | `available.*` → dropdown options; `locked` → which fields are read-only |
| Provider toggle pill in header | `available.providers[]` |
| Inline model picker dropdown | `available.providers[*].models[]` |
| Persona switcher | `available.personas[]` |
| Feature toggles | `available.features.*` decides which UI affordances render at all |

This is what we'll build the parity UI against — the manifest is the
schema the UI knows how to render.
