# Configuration & loading patterns

Acolyte is plug-and-play first, programmable second. You should never
have to write JavaScript to put it on a page. Four ways to load:

## Pattern A — external JSON config (recommended)

```html
<script type="module" src="acolyte.js" data-config="acolyte.config.json"></script>
```

```json
// acolyte.config.json
{
  "llm": { "provider": "ollama", "host": "http://localhost:8767" },
  "persona": "teacher",
  "rag": { "auto": true },
  "ui": { "accent": "#2D8B55" }
}
```

Why this is the default: the host HTML touches nothing about the widget.
Editing config is editing a JSON file in version control. Stage / unstage
just like any other file. Multiple environments can ship different JSONs.

## Pattern B — data attributes on the script tag

```html
<script type="module" src="acolyte.js"
        data-llm-provider="ollama"
        data-llm-host="http://localhost:8767"
        data-persona="teacher"
        data-rag-auto="true"
        data-ui-accent="#2D8B55"></script>
```

Dash-paths become nested keys:

| Attribute             | Equivalent JSON path  |
|-----------------------|------------------------|
| `data-llm-provider`   | `llm.provider`         |
| `data-llm-host`       | `llm.host`             |
| `data-persona`        | `persona`              |
| `data-rag-auto`       | `rag.auto`             |
| `data-rag-selector`   | `rag.selector`         |
| `data-ui-accent`      | `ui.accent`            |
| `data-voice-enabled`  | `voice.enabled`        |
| `data-storage-db-name`| `storage.dbName`       |

Values are coerced: `"true"`/`"false"` → boolean, numeric strings →
number, `{...}`/`[...]` → parsed JSON, anything else → string.

For complex shapes (e.g. a `sections` array), use Pattern A.

## Pattern C — global config object

```html
<script>
  window.AcolyteConfig = {
    llm: { provider: 'ollama', host: 'http://localhost:8767' },
    persona: 'teacher',
    rag: { auto: true },
    plugins: [/* runtime plugins */]
  };
</script>
<script type="module" src="acolyte.js"></script>
```

Useful when the config needs JS-only values (functions, plugin instances,
DOM references).

## Pattern D — manual mount() call

```html
<script type="module">
  import { mount } from 'acolyte';
  const handle = mount({
    llm: { provider: 'ollama', host: 'http://localhost:8767' },
    persona: 'teacher'
  });
  // ... do stuff with handle.open(), handle.send(), etc.
</script>
```

For framework wrappers (React/Vue/Svelte) and any scenario where you
need the returned `handle` to drive the widget programmatically.

## Mixing patterns

If the loader finds **more than one** source of config, they merge
deep-left-to-right:

```
A: window.AcolyteConfig     ← lowest priority
B: data-config JSON         ← overrides A
C: data-* attributes        ← overrides B
```

So you can ship sensible defaults in JSON and let one page override the
accent color with `data-ui-accent="#ff5500"`.

## Opting out of auto-mount

If you want the script loaded but no auto-mount (e.g. you'll call
`mount()` from your own code after some auth flow):

```html
<script type="module" src="acolyte.js" data-acolyte-no-auto="true"></script>
<script type="module">
  import { mount } from 'acolyte';
  // ... later ...
  mount({ llm: { ... } });
</script>
```

## What the loader looks for

On `DOMContentLoaded` (or immediately if the DOM is already loaded),
acolyte:

1. Finds the script tag it was loaded from (via `document.currentScript`
   or by matching `script[src*="acolyte"]`).
2. Skips if `data-acolyte-no-auto="true"`.
3. Reads `window.AcolyteConfig` if present.
4. Fetches `data-config` JSON if present, merges over (3).
5. Reads `data-*` attributes, merges over (4).
6. If the resulting config has an `llm` block, calls `mount()`.
7. Otherwise: silently waits for a manual `mount()` call.

The console will log a warning if `data-config` fails to fetch, but
auto-mount never throws — bad configs just result in no widget
appearing, with the reason logged.
