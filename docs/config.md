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

## Branded topbar (`ui.topbar`)

Acolyte's chat panel ships with its own internal header (model picker,
settings gear, history, close). On desktop the visitor still sees the
host site's chrome behind the narrow side panel — but on mobile the
panel goes fullscreen, and the visitor loses every visual cue that
they're still on your site. `ui.topbar` solves that by rendering an
optional brand strip *above* Acolyte's header inside the panel.

### Minimum config

```jsonc
{
  "ui": {
    "topbar": {
      "label": "● Brand  ·  Assistant",
      "visibility": "mobile",
      "bg": "#fbf3e5",
      "color": "#a8623a"
    }
  }
}
```

| Field | Type | What it does |
|---|---|---|
| `label` | string | Text rendered in the strip. Use a unicode bullet, em-dash, etc. for visual flourish. Ignored if `html` is set. |
| `html` | string | Raw HTML — overrides `label`. Use for SVG logos, multi-color layouts, or any custom markup. Host supplies trusted markup; Acolyte does NOT sanitize. |
| `visibility` | `'mobile'` &#124; `'always'` &#124; `'never'` | Default `'mobile'` — only renders at ≤640px viewport (fullscreen mode). `'always'` for sites that want the brand at every viewport. `'never'` is the same as omitting the field. |
| `bg` | CSS color | Background color of the strip. Defaults to the same cream tone as Acolyte's header. |
| `color` | CSS color | Text color. Defaults to `--acolyte-accent`. |

### Where it renders

The topbar is a real `<div class="acolyte-topbar acolyte-topbar--{visibility}">`
inserted as the FIRST child of `.acolyte-panel`, before the resize
handle and the existing Acolyte header. It participates in the panel's
flex column layout. Safe-area-inset-top padding is built in, so it
clears the iPhone notch automatically.

The CSS classes — `.acolyte-topbar`, `.acolyte-topbar--mobile`,
`.acolyte-topbar--always`, `.acolyte-topbar--never` — are stable
selectors you can target from host CSS if you want to override the
default styling without re-implementing the renderer.

### Logo + multi-color layout (HTML form)

For anything more than a one-color text strip, use `html`:

```jsonc
{
  "ui": {
    "topbar": {
      "html": "<svg width=\"16\" height=\"16\" viewBox=\"0 0 16 16\"><circle cx=\"8\" cy=\"8\" r=\"5\" fill=\"#a8623a\"/></svg><span>Brand · Assistant</span>",
      "visibility": "always",
      "bg": "#fbf3e5"
    }
  }
}
```

Wrap the contents in spans or use a flex layout via inline `style="..."`
attributes; the parent `<div>` is `display: flex` so children align
horizontally by default.

### Why not just style `.acolyte-header` instead?

Three reasons:

1. **The Acolyte header is functional** — it carries the model picker,
   gear, close button. Stuffing brand identity in there crowds the
   functional controls.
2. **Per-locale branding** — host sites with multiple language
   deployments want different strings per locale. Driving the strip
   from config is cleaner than maintaining a CSS override per locale.
3. **Per-client deployment** — when Acolyte ships into multiple client
   sites, each one has its own brand. Config-driven beats CSS-hack
   beats fork-the-source. Topbar config keeps Acolyte as a generic
   engine and pushes branding to the deployment layer.

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
