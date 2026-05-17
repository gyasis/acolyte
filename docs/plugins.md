# Plugin system

How to extend acolyte without modifying the core. Plugins are TypeScript
objects with optional fields. Each field plugs into a specific extension
point — behavioral hooks, capability registration, or UI slots.

## Anatomy of a plugin

```ts
import type { AcolytePlugin } from 'acolyte';

const myPlugin: AcolytePlugin = {
  name: 'my-plugin',         // required, must be unique
  version: '0.1.0',

  // ─── Lifecycle ──────────────────────────────────────────────
  init(handle, ctx) {
    ctx.log('initialized');                  // namespaced console log
    await ctx.storage.set('lastInit', Date.now());
  },
  onClose() { /* release timers, sockets, etc. */ },

  // ─── Behavioral hooks (intercept the chat flow) ────────────
  async beforeSend(ctx) {
    ctx.messages.push({ role: 'system', content: 'extra: user locale = en-GB' });
    return ctx;
  },
  async afterResponse(ctx) {
    analytics.track('chat_response', { elapsedMs: ctx.elapsedMs });
  },
  async onToolCall(ctx) {
    if (ctx.name === 'delete_user') ctx.shortCircuit = 'denied by policy';
  },
  onMessageRender(node, msg) {
    // attach an action button to assistant bubbles
    if (msg.role === 'assistant') node.appendChild(translateBtn());
  },

  // ─── Capability registration (declarative) ─────────────────
  providers: [{ name: 'whatsapp', send: customSend, listModels: async () => ['live-agent'] }],
  tools:     [{ schema: ..., run: async (args) => '...' }],
  personas:  [{ name: 'sales',   persona: { role: 'You are a sales rep…', ... } }],
  ragSources:[{ name: 'wiki',    fetch: async ({ query }) => fetchWiki(query) }],

  // ─── UI slots ──────────────────────────────────────────────
  ui: {
    headerButtons:  [{ icon: '📞', title: 'Call human', onClick: handle => handle.send('connect me to a human') }],
    messageActions: [{ icon: '🌐', title: 'Translate',  onClick: ({ messageText }) => alert(translate(messageText)) }],
    footerNote:     'Powered by my-plugin',
    panelSections:  [{ title: 'Quick links', render: () => buildLinksEl() }]
  }
};

// In the host page:
import { mount } from 'acolyte';
mount({ llm: { provider: 'ollama' }, plugins: [myPlugin] });
```

## Hook reference

| Hook                  | When it fires                                | Mutable? | Use cases                                  |
|-----------------------|----------------------------------------------|----------|--------------------------------------------|
| `init(handle, ctx)`   | Once after mount, before first paint         | side-fx  | Setup, register UI, kick off background    |
| `beforeSend(ctx)`     | Before each LLM call                         | yes      | Inject system context, filter, redirect    |
| `afterResponse(ctx)`  | After response (including streaming finish)  | no       | Analytics, persistence, logging            |
| `onToolCall(ctx)`     | Before tool runs                             | yes      | Audit, deny, transform args, short-circuit |
| `onMessageRender(node, msg)` | After a chat bubble is inserted       | yes (DOM)| Inject buttons, badges, citations          |
| `onPersonaChange(p)`  | When `handle.setPersona()` is called         | side-fx  | Reload prompts, swap branding              |
| `onClose()`           | When `handle.unmount()` is called            | side-fx  | Cleanup                                    |

### Hook dispatch order

Plugins are stored in the order they were passed to `mount()` (or added
via `host.add()`). Each hook fires across all plugins in that order.

If a plugin's hook throws, it is **caught and logged**; other plugins
continue. This isolation is intentional — one bad plugin should not
break the widget.

## Capability registration

### Providers

A plugin can ship a new LLM adapter. The widget treats it just like a
built-in.

```ts
providers: [{
  name: 'cohere',
  async send(messages, opts) {
    const r = await fetch('https://api.cohere.com/v1/chat', { ... });
    return { text: ... };
  },
  async listModels() { return ['command-r-plus']; }
}]
```

Once a plugin registers a provider named `'cohere'`, users can do
`llm: { provider: 'cohere', model: 'command-r-plus', apiKey: '...' }`.

### Tools

Add new function-call tools the LLM can invoke.

```ts
tools: [{
  schema: {
    type: 'function',
    function: {
      name: 'crm_lookup',
      description: 'Find a customer by email.',
      parameters: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] }
    }
  },
  async run(args) {
    const r = await fetch(`/api/crm/${args.email}`);
    return JSON.stringify(await r.json());
  }
}]
```

The widget appends this to the prompt's tool list automatically.

### Personas

Add named personas. Users select via `persona: 'sales'` in config.

```ts
personas: [{
  name: 'sales',
  persona: {
    role: 'You are a friendly sales rep for Acme Corp.',
    tone: 'warm', speakStyle: 'commentary', grounding: 'permissive', refusalPolicy: 'redirect',
    greeting: 'Hi! How can I help you find the right plan today?'
  }
}]
```

### RAG sources

The single most important plugin slot. Add new sources of grounding
content — other pages, external indexes, search APIs, anything.

```ts
ragSources: [{
  name: 'helpdesk',
  perQuery: true,                              // re-fetch on every chat query
  async fetch({ query }) {
    const r = await fetch(`/api/help/search?q=${query}`);
    const items = await r.json();
    return items.map((i, idx) => ({
      id: `help-${idx}`, title: i.title, text: i.body, meta: { url: i.url }
    }));
  },
  pageUrl(section) { return (section.meta as any)?.url; }
}]
```

Returned sections get merged into the BM25 query with built-in DOM
passages. Hits carry the source name + `pageUrl` so the UI can render
them with citation links.

## UI slot reference

### `headerButtons`

Extra icon buttons in the chat header (next to ⚙).

```ts
{ icon: '📞', title: 'Call human', onClick: (handle) => handle.send('I need a human') }
```

### `messageActions`

Buttons attached to each rendered assistant message.

```ts
{ icon: '🌐', title: 'Translate', onClick: ({ messageText, messageNode, handle }) => { ... } }
```

### `footerNote`

Branding strip below the input. String or element factory.

```ts
footerNote: 'Powered by acme.co'
// or
footerNote: (handle) => buildBrandEl(handle)
```

### `panelSections`

Collapsible sections inside the panel (above the input row).

```ts
{ title: 'Lead form', render: (handle) => buildLeadFormEl(handle) }
```

## Plugin context (`ctx` arg to `init()`)

```ts
{
  log: (...args) => void,                                    // namespaced console
  storage: {
    get<T>(key): Promise<T | undefined>,                    // namespaced kv store
    set<T>(key, value): Promise<void>,
    delete(key): Promise<void>
  },
  refreshRAG: () => Promise<void>                           // re-run all RAG sources
}
```

## Built-in plugins

| Plugin           | What it does                                          | Import |
|------------------|-------------------------------------------------------|--------|
| `crossPageRAG`   | Fetches other pages of the same site, indexes them    | `import { crossPageRAG } from 'acolyte';` |

(More built-ins to come: `handoff`, `analytics`, `leadCapture`, `voiceCustom`.)

## Plugin lifecycle reminders

- **Plugins do not communicate with each other directly.** All state
  goes through the widget (via hooks) or via plugin-private storage.
- **Plugins must not call `unmount()`.** Only the host page does that.
- **Hooks should be fast.** A slow `beforeSend` blocks every chat
  message. If you need to do heavy work, do it in `init()` and cache
  the result.
- **Failures are isolated, not silent.** Every error is logged with the
  plugin's name. Watch the console while developing.
