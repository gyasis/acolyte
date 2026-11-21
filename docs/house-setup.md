# House setup — how our own apps connect Acolyte to a model

This page shows the two setups that our apps use (Chiron and the Kodi Watch Board). Read it before
you add Acolyte to a new app. For hosted Ollama Cloud paths in general, see `ollama-cloud.md`.

## Rule 1: the browser never calls the model directly

Mount Acolyte with a **same-origin** `baseUrl` that your own server handles. The server forwards
the call. This is necessary because:

- the Atelier governor (`http://<mac>:8799`) does not answer a CORS preflight, so a browser cannot
  call it from another origin;
- the upstream address and any key stay on the server, out of the page and out of the repo;
- the server can correct each call before it goes upstream (see Rule 3).

Keep the upstream address in server config, not in the page. Chiron reads `~/.chiron/ask.json`
(an environment variable can override it). The Watch Board reads `WATCHBOARD_LLM_BASE` /
`WATCHBOARD_LLM_MODEL`.

## Setup A: Acolyte as a chat front end to a model (Chiron · Ask)

```js
mount({
  llm: { provider: 'ollama', host: '/ask/llm', model: 'gemma4:31b-cloud' },   // or openai-compatible + baseUrl
  ...
});
```

The server route `/ask/llm/{path}` forwards to the configured upstream, usually the governor at
`http://<mac>:8799/llm/ollama`. Reference: `chiron/skill/server/app.py` (`_ask_cfg`,
`ask_config`, `ask_llm_proxy`). `/ask/config.json` gives the page the model list for the picker:
`/api/tags` for an ollama upstream, `/models` for an OpenAI-compatible upstream.

## Setup B: Acolyte as the front end to a PromptChain agent

Use this when the answer comes from a fixed pipeline (search, find, rank, format), not from one
model call. **The chain is the backend.** Acolyte does not know about it.

1. Serve the chain at `POST <base>/chat/completions` in the OpenAI shape, and `GET <base>/models`.
2. Mount Acolyte with `provider: 'openai-compatible'`, `baseUrl: '<base>'`, `model: '<chain name>'`.
3. In the chain, end with a Python function step that builds the reply. Then each reply has the
   same structure, whatever the agent step does.
4. To show more than text (cards, a grid), put the data in a fenced block with a unique language
   tag in the reply. Do not let the model write HTML.
5. In a plugin's `onMessageRender`, replace that block with your own DOM.

Reference: Chiron's tutor (`chiron/skill/server/tutor_server.py`, the `/v1/chat/completions`
"OpenAI face" over `tutor_chain.py`), and the Watch Board movie finder
(`kodi-deck/watchboard/server.py` `_finder`, `identify.py`, the movie-finder plugin in
`index.html`).

Notes for Setup B:

- Acolyte sends `stream: true`. Reply as SSE: one `chat.completion.chunk` with the full text, then
  `data: [DONE]`. Send the data block in **one** chunk. Acolyte creates the message bubble empty
  and draws it again for each delta, so `onMessageRender` first sees an empty body. Watch the
  node with a `MutationObserver` and replace the block when it arrives.
- Set `rag: { enabled: false }` if the page is not the knowledge source. Otherwise Acolyte searches
  the page, sends the passages to your chain and shows a sources footer.
- Acolyte sends its whole history. Take only the `user` turns you need; ignore the system prompt.

## Rule 2: which upstream

| Upstream | Address | When |
|---|---|---|
| Atelier governor | `http://<mac>:8799/llm/ollama` (native) or `…/llm/ollama/v1` (OpenAI shape) | Default for our apps. Local and cloud models; admission control; `llm-snitch` sees the calls |
| LiteLLM gateway | `http://127.0.0.1:37400/v1` | Chiron's fallback when no config exists |
| Ollama Cloud direct | `https://ollama.com/v1` + `OLLAMA_API_KEY` (server side only) | Cloud models when the governor is not used |

Do not call raw ollama `:11434`. It has no admission control, and `llm-snitch` does not see it.

Send `X-Governor-Max-Seconds: <your read timeout>` to the governor. After that time no client is
waiting for the answer.

## Rule 3: correct these in the server

| Problem | Correction | Where Chiron does it |
|---|---|---|
| Acolyte's ollama client sends `options.num_predict: -1`. Ollama **cloud** models reject it (`max_tokens must be positive`) | Remove `num_predict` when it is `<= 0` | `ask_llm_proxy` |
| Ollama's default context is 131K, which fills swap on the Mac | Set `options.num_ctx` from the prompt size | `fail_fast.num_ctx_for` |
| A thinking model reasons before it answers, and a grounded answer can go past the timeout | Send `think: false` on `/api/chat`, but only when `/api/show` lists `thinking`. Some models (a `keep_thinking` list) move the reasoning into the answer when you do this, so leave those on | `_ask_model_thinks` |
| A browser reload leaves the old call running | Cancel the upstream call when the client disconnects, one call per tab | `ask_proxy.forward` |

For a PromptChain agent (Setup B):

- Call the model through litellm's `openai/` route with `api_base` set to the OpenAI-shaped
  upstream. With `minimax-m3.1-flash:cloud`, the `ollama_chat/` route drops tool results, and the
  agent searches again and again.
- Set `max_internal_steps` on the `AgenticStepProcessor`. This limits the loop.
- Limit the size of each tool result (number of rows, characters per snippet) and ask for a short
  output schema. Do not set `max_tokens` on a thinking model: the thinking uses the budget first and
  the answer comes back empty.
- Set `enable_summarization=False` unless you want its default summarizer (a paid OpenAI model).

## Plugins: what works

- `tools: [{ schema, run }]` — the widget sends plugin tools to the model together with the
  built-in tools, and runs them when the model calls them.
- `onMessageRender(node, msg)` — runs when the widget creates a bubble. During a stream the content is
  empty at that time (see Setup B).
- A plugin object needs a `version` field. Without it, Acolyte looks up the `name` as a built-in
  plugin.
- `rag.showSourceCards: false` hides the sources footer.
- `rag.auto` is declared in `types.ts` but the widget does not read it. Use `rag.enabled`.
