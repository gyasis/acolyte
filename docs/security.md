# Security

How Acolyte handles API keys, what the proxy exposes, and how to reason
about the threat model before deploying.

---

## TL;DR for the impatient

- API keys live in `server/.env` (gitignored).
- The proxy reads them at startup and serves them at `GET /chat-config`.
- The proxy binds to `127.0.0.1` by default — only the local machine
  can fetch keys.
- The widget never embeds keys in HTML or source. It fetches them at
  mount time from the proxy.
- Nothing in the published `dist/` bundle carries any secret.

If you stick to the defaults you are safe. The rest of this doc is
about what changes when you deviate.

---

## Where keys live, end to end

```
┌──────────────┐   1. read on startup    ┌──────────────────┐
│ server/.env  │ ───────────────────────▶│ cors-proxy.py    │
│ (gitignored) │                          │ (Python, local)  │
└──────────────┘                          └────────┬─────────┘
                                                   │
                              2. GET /chat-config  │
                                  (loopback only)  ▼
                                          ┌──────────────────┐
                                          │ Acolyte widget   │
                                          │ (browser)        │
                                          └────────┬─────────┘
                                                   │
                            3. authed LLM request  ▼
                                          ┌──────────────────┐
                                          │ Anthropic /      │
                                          │ OpenAI /         │
                                          │ Gemini /         │
                                          │ Ollama upstream  │
                                          └──────────────────┘
```

Three rules:

1. **Source-level**: no key, no IP, no token in `src/`, `dist/`, HTML, or
   the published npm package. Period. The repo enforces this via
   `.gitignore`; verify with `grep -rE 'sk-[A-Za-z0-9]{20,}' src/` after
   any large refactor.
2. **Process-level**: the proxy reads `.env` once at startup. Existing
   process env wins over `.env` so CI / systemd can override without
   touching the file.
3. **Wire-level**: the only endpoint that returns keys is
   `GET /chat-config`. It returns only the keys in `ENV_KEY_MAP` —
   currently `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `TAVILY_API_KEY`.
   Nothing else from `os.environ` is dumpable.

---

## What `/chat-config` returns

Whatever subset of these keys is set in the proxy's env, mapped to
widget-side field names:

| Env var              | Widget field      | Used by                          |
|----------------------|-------------------|----------------------------------|
| `GEMINI_API_KEY`     | `geminiKey`       | Gemini OpenAI-compat, geminiResearch tool, deepAnalysis tool |
| `ANTHROPIC_API_KEY`  | `anthropicKey`    | Anthropic provider               |
| `OPENAI_API_KEY`     | `openaiKey`       | OpenAI provider (when wired)     |
| `TAVILY_API_KEY`     | `tavilyKey`       | Tavily search tool (optional)    |

Missing env vars produce missing fields. The widget treats every field
as optional and falls back to manual entry in the settings panel.

If you need to expose more secrets, edit `ENV_KEY_MAP` in
`server/cors-proxy.py`. Treat any addition as a security review.

---

## The `LISTEN_HOST` decision

By default the proxy binds to `127.0.0.1`. That means:

- Only the local machine can hit `/chat-config`.
- A laptop on a public/coffee-shop WiFi cannot be probed.
- A container can still reach the proxy if it shares the host's network
  namespace, but a sibling container on a separate bridge cannot.

If you set `LISTEN_HOST=0.0.0.0` (e.g., for shared LAN dev work), the
proxy prints a loud warning at startup:

```
[proxy] WARNING: binding to 0.0.0.0 exposes /chat-config (API keys) to anyone on the LAN
```

When this is on, **anyone on your network who knows the port reads your
keys**. The CORS-`*` header means it works from any browser, any origin.
Combined: this is a key-exfiltration surface.

Mitigations if you really need LAN binding:

- Put the proxy behind a network ACL that allows only your dev box.
- Edit `_serve_config()` to require a shared token from `Authorization:
  Bearer <X>` header. Five lines of Python.
- Use SSH tunneling instead — `ssh -L 8767:localhost:8767 user@box`
  gives you the LAN access without exposing `/chat-config`.

---

## What's gitignored (and why)

```
node_modules/            # vendored deps; huge, regenerable
dist/                    # build output; regenerable
.DS_Store                # macOS noise
*.log                    # runtime logs
.env                     # any project-level env file
.env.local               # Vite/Next-style local overrides
.env.production          # never commit these
config.local.js          # ad-hoc per-deployment override
*.tsbuildinfo            # TS incremental build artifact
.cache/                  # ditto
server/.env              # the proxy's secrets
server/__pycache__/      # Python bytecode
server/*.pyc
```

The `.env.example` files **are tracked** — they're templates with empty
values. They document which variables exist without leaking what they
hold.

---

## Key rotation

There is no Acolyte-side state to clear. To rotate:

1. Revoke the old key with the provider (Anthropic console, OpenAI
   dashboard, Google AI Studio).
2. Update `server/.env` with the new value.
3. Restart `cors-proxy.py`.

The widget will fetch the new value from `/chat-config` on the next
page load. No browser cache clears needed unless you cached `/chat-config`
yourself — by default the proxy doesn't set `Cache-Control`.

---

## Threat model

| Threat                                       | Mitigation                                                |
|----------------------------------------------|-----------------------------------------------------------|
| Key checked into git                         | `.gitignore` + grep audit; CI pre-commit hook recommended |
| Key leaks via XSS on the host page          | Widget reads from `/chat-config`, but a successful XSS could still call the proxy. Treat the proxy as part of the trust boundary. |
| Key exfiltrated by a coffee-shop attacker    | `LISTEN_HOST=127.0.0.1` default; CORS-aware                |
| Key in a server log                          | Proxy does not log request/response bodies                |
| Key in a browser cache                       | `/chat-config` has no `Cache-Control: public`; treat fetches as session-scoped |
| Tampered `dist/` served from a CDN           | Use Subresource Integrity (`integrity="sha384-…"`) on the `<script>` tag for production deployments |
| Malicious npm dependency                     | `package-lock.json` pins everything; review `npm audit` before bumps |

Things this widget does **not** defend against:

- A compromised browser (no in-browser KMS exists).
- A host page that intentionally captures messages — Acolyte runs in
  the host's JS context.
- A user copy-pasting their own keys into the settings panel and then
  leaving the laptop unlocked.

---

## Verifying a build is clean

Before publishing or before a security review:

```bash
# 1. Source-level grep — no real keys or private IPs
grep -rE '(sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|tvly-[A-Za-z0-9]{20,})' src/ server/ docs/ examples/ README.md
grep -rE '\b(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]+\.[0-9]+' src/ examples/

# 2. Bundle-level — keys should never make it into dist/
npm run build
grep -E '(sk-[A-Za-z0-9]{20,}|AIza)' dist/*.js dist/*.cjs

# 3. Git-history — nothing leaked in a past commit
git log -p | grep -iE 'sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}'

# 4. Proxy bind
python3 server/cors-proxy.py &
sleep 1
ss -tlnp | grep ':8767 '   # should show 127.0.0.1, not 0.0.0.0
```

All four commands should produce zero matches (or, for #4, the loopback
address). Anything else is a leak.
