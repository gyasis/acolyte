# Agent-assist (shadow chat / human takeover)

A reusable preset for putting a **human operator** behind the Acolyte widget:
the AI answers by default, but an operator can watch live, **invisibly take
over** a conversation (their typed reply reaches the visitor as if it came
from the assistant), and hand back to the AI — all from a chat app like
Telegram. The visitor never sees a UI change.

This doc is the **install contract**. The browser half ships in Acolyte (the
generic `agentAssist` plugin); the server half is a small, per-deployment
adapter you drop into your host app. Only secrets differ between deployments.

```
┌ browser ───────────────┐   ┌ your server ─────────────────┐   ┌ operator ┐
│ Acolyte widget         │   │ /api/agent-assist/events     │   │ Telegram │
│  agentAssist plugin ───┼──▶│   → session store + relay ───┼──▶│ supergroup│
│  (emits 3 events)      │   │ /api/agent-assist/operator ◀─┼───│  (topics) │
│                        │   │ /api/chat/completions proxy  │   │ /take …  │
│  chat ─────────────────┼──▶│   ↳ splices operator reply   │   └──────────┘
└────────────────────────┘   └──────────────────────────────┘
```

## 1. The browser half — the `agentAssist` plugin (built-in)

`agentAssist` is a generic, backend-agnostic plugin. It knows nothing about
Telegram — it just POSTs three lifecycle events to a configurable endpoint:

| Event | When | Payload |
|---|---|---|
| `session_start` | first user message of a conversation | `{ sessionId, ts, page:{url,title,path,referrer} }` |
| `user_message` | every user turn | `{ sessionId, ts, text }` |
| `assistant_response` | every assistant reply (incl. cached) | `{ sessionId, ts, text, elapsedMs, fromCache }` |

Enable it in config (JSON name-based or a JS factory):

```jsonc
// acolyte.config.json
"plugins": [
  { "name": "agentAssist", "endpoint": "/api/agent-assist/events" }
]
```
```js
// or, manual mount
import { mount, agentAssist } from 'acolyte';
mount({ /* … */, plugins: [ agentAssist({ endpoint: '/api/agent-assist/events' }) ] });
```

Options: `endpoint` (default `/api/agent-assist/events`), `headers` (e.g. a
shared token), `enabled` (kill-switch). Posts are fire-and-forget, ordered,
and never block the visitor's reply; a down backend is silently tolerated.

**Session correlation.** Acolyte mints a stable `sessionId` per conversation
and forwards it as the OpenAI **`user`** body field on the chat request
itself. So your chat proxy can match a live LLM call to its agent-assist
session (and splice in an operator reply) by reading `body.user` — no extra
plumbing. (Relies on the `beforeSend`/`afterResponse` plugin hooks, which the
widget fires around every send.)

## 2. The server half — the adapter (per-deployment)

Implement three endpoints in your host app (reference: SvelteKit version in
the twicedata-new repo, `src/lib/server/agent-assist/` + `src/routes/api/`):

- `POST /api/agent-assist/events` — receive plugin events; on `session_start`
  create one operator **forum topic** per session; relay each turn into it.
- `POST /api/agent-assist/operator` — your chat-app webhook (or long-poll
  consumer in dev); handles `[Take over]`/`[Mute]`/`[Leave AI]` buttons and
  free-text operator replies (stored as the session's pending reply).
- extend `POST /api/chat/completions` — read `body.user` (the sessionId); if
  the session is in `human` mode with a pending operator reply, return THAT
  as the SSE response instead of calling the LLM; otherwise behave normally.

Session state (mode = `ai|human|muted`, topic mapping, pending reply,
transcript) lives in a tiny store — a JSON/in-memory map for a prototype,
SQLite (`better-sqlite3`) for production durability across restarts.

## 3. Install anti-patterns (hard-won — do NOT skip)

These are the failures that cost real debugging time on the first deploy. A
modern hardened host site breaks the widget in non-obvious ways:

- **❌ Static `<script>` for the widget under a strict CSP.** If the host
  sets `script-src 'strict-dynamic' 'nonce-…'`, a hand-written
  `<script src="/acolyte/index.js">` gets **no nonce and is blocked**
  silently. → **Inject the script from already-trusted module code**
  (e.g. a framework `onMount`/client hook): `'strict-dynamic'` then
  propagates trust to it. Same pattern analytics loaders already use.

- **❌ Letting the widget call the LLM cross-origin under CSP.** A direct
  browser→LLM call (Ollama on a LAN box, `api.openai.com`, etc.) is refused
  by `connect-src 'self'` and surfaces as **"provider unreachable" / "failed
  to fetch."** → **Route the chat through a same-origin proxy** (`provider:
  'openai-compatible'`, `baseUrl: '/api'`). `connect-src 'self'` allows it,
  the API key stays server-side, AND that proxy is the exact splice point
  agent-assist needs for takeover. (This is why agent-assist *requires* the
  proxy path, not a direct provider.)

- **❌ Wrong / stale LLM host.** Pin the real endpoint in env, not a
  remembered dev port. For local Ollama through the proxy, point the proxy's
  upstream at Ollama's **OpenAI-compatible** endpoint (`…:11434/v1`) and run
  the proxy in a no-auth mode (no OpenAI key needed locally).

- **❌ `crossPageRAG` with absolute cross-origin URLs under CSP.** A sitemap
  of `https://prod-domain/…` URLs fails `connect-src` in local dev (different
  origin) and floods the console. → Use same-origin/relative page lists in
  dev, or disable `crossPageRAG` locally.

## 4. Configuration — keys + modes per source

All deployment-specific values are **env vars** (never committed). Two modes:

| Var | Dev (local Ollama) | Prod (OpenAI + Telegram) |
|---|---|---|
| `OPENAI_BASE_URL` | `http://<ollama-host>:11434/v1` | `https://api.openai.com/v1` |
| `OPENAI_API_KEY` | *(unset)* | `sk-…` |
| `ACOLYTE_PROXY_NO_AUTH` | `1` (no key needed) | *(unset)* |
| `ACOLYTE_PROXY_ALLOWED_MODELS` | `gemma4:latest` | `gpt-4o-mini,gpt-4o` |
| `AGENT_ASSIST_ENABLED` | `1` | `1` |
| `TELEGRAM_BOT_TOKEN` | from @BotFather | from @BotFather |
| `TELEGRAM_OPERATOR_GROUP_ID` | `-100…` (Topics-enabled supergroup) | `-100…` |
| `AGENT_ASSIST_AUTO_RELEASE_MINUTES` | `10` | `10` |

The adapter degrades gracefully: with no `TELEGRAM_*` set, events are still
stored + logged (observable), the visitor's chat is unaffected — so you can
stand up the pipeline before wiring the operator channel.

## 5. One-time Telegram operator setup (~3 min)

1. @BotFather → `/newbot` → save the token.
2. Create a group → add the bot → enable **Topics** (upgrades to supergroup).
3. Promote the bot to **admin** with **Manage Topics**.
4. Send one message in the group, then read the supergroup `chat_id` from
   `getUpdates` → set `TELEGRAM_OPERATOR_GROUP_ID`.

Keep tokens out of screenshots/chat logs; `/revoke` + reissue if exposed.

## Cross-references
- Plugin system: `docs/plugins.md` · Config loading: `docs/config.md`
- Reference server adapter: twicedata-new `src/lib/server/agent-assist/`
- The `agentAssist` plugin source: `src/plugins/agentAssist.ts`
