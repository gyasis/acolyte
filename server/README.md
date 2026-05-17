# acolyte/server — optional CORS proxy for Ollama

A tiny Python (stdlib-only) HTTP proxy that adds CORS headers and
forwards `/api/*` to an upstream Ollama. Use it if:

- Your Ollama runs on a different machine on your LAN, AND
- You can't or don't want to set `OLLAMA_ORIGINS=*` on that machine

The acolyte widget itself has zero source dependency on this script —
it just hits an HTTP URL you point it at. The proxy is a convenience.

## Quick start

```bash
cd acolyte/server
cp .env.example .env                      # create the config (see below)
# edit .env — at minimum set OLLAMA_UPSTREAM
python3 cors-proxy.py
# now serving on :8767, forwarding to whatever OLLAMA_UPSTREAM points at
```

In your acolyte config (`acolyte.config.json` or `data-llm-host` attr):

```json
{ "llm": { "provider": "ollama", "host": "http://localhost:8767" } }
```

## `.env` (gitignored — never commit)

```env
# Where to forward /api/* requests
OLLAMA_UPSTREAM=http://192.168.1.10:11434

# Port the proxy listens on (default 8767)
LISTEN_PORT=8767

# Optional — keys surfaced to the widget via GET /chat-config
# The widget reads these on mount and seeds settings the user hasn't
# already typed manually. None are required.
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
TAVILY_API_KEY=
```

## What endpoints does it expose

| Path             | Behavior |
|------------------|----------|
| `/api/*`         | Proxied to `$OLLAMA_UPSTREAM`, chunked passthrough preserves streaming |
| `/chat-config`   | Returns `{geminiKey, anthropicKey, tavilyKey}` from env (whatever is set) |
| `OPTIONS *`      | Returns 204 with `Access-Control-Allow-*: *` for CORS preflight |

## Why this isn't part of the widget bundle

The widget runs in the browser. This proxy runs as a separate process,
typically on the same machine that serves the host page. They are
independently deployable — you can replace this proxy with nginx, a
Cloudflare Worker, or anything else that handles CORS and forwards to
Ollama.

## Production alternatives

- **Set `OLLAMA_ORIGINS=*`** on the Ollama host and skip the proxy entirely.
- **Cloudflare Worker** — same shape, runs at the edge.
- **nginx** — `proxy_pass` + `add_header Access-Control-Allow-Origin`.
- **caddy** — `reverse_proxy` + a `header` directive.

All four make the widget happy. The Python script here is just the
zero-setup option for "I have Ollama on one box and a static page on another".
