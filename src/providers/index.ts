/**
 * Provider adapters. Each adapter speaks a common shape:
 *
 *   send(messages, opts) -> { text, toolCalls? }
 *
 * but reaches its underlying LLM via whatever endpoint the user
 * configured — direct cloud, self-hosted, or proxied. The `baseUrl`
 * + `headers` config fields let any provider be routed through a
 * CORS / auth / aggregator proxy without code changes.
 */

import type {
  LLMConfig,
  AnthropicConfig,
  OpenAIConfig,
  OllamaConfig,
  OpenAICompatibleConfig
} from '../types.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: NativeToolCall[];
  /** For role:'tool' messages — the function name (becomes `name` in the
   *  wire format). Required by Gemini's OpenAI-compat endpoint. */
  tool_name?: string;
  /** For role:'tool' messages — the id of the assistant tool_call this
   *  result corresponds to (becomes `tool_call_id`). */
  tool_call_id?: string;
}

export interface NativeToolCall {
  /** Required for round-tripping the OpenAI tool-call protocol. */
  id?: string;
  type?: 'function';
  function: { name: string; arguments: Record<string, unknown> };
}

export interface SendOptions {
  stream?: boolean;
  temperature?: number;
  tools?: unknown[];                                  // OpenAI-style schema array
  onDelta?: (delta: string, full: string) => void;
}

export interface SendResult {
  text: string;
  toolCalls?: NativeToolCall[];
}

/* ───── Default endpoints per provider ───── */
const DEFAULTS = {
  anthropic:           { baseUrl: 'https://api.anthropic.com',     model: 'claude-sonnet-4-7' },
  openai:              { baseUrl: 'https://api.openai.com/v1',     model: 'gpt-5-mini'       },
  ollama:              { host:    'http://localhost:11434',         model: ''                 },
  'openai-compatible': { baseUrl: '',                                model: ''                 }
} as const;

/* ───── Anthropic ───── */

async function anthropicSend(
  cfg: AnthropicConfig,
  messages: ChatMessage[],
  opts: SendOptions = {}
): Promise<SendResult> {
  if (!cfg.apiKey) throw new Error('Anthropic apiKey required');
  const base = (cfg.baseUrl ?? DEFAULTS.anthropic.baseUrl).replace(/\/$/, '');
  const model = cfg.model ?? DEFAULTS.anthropic.model;
  const stream = opts.stream !== false;

  // Anthropic wants `system` separately from the messages array.
  let system = '';
  const cleaned: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of messages) {
    if (m.role === 'system') system += (system ? '\n\n' : '') + m.content;
    else if (m.role === 'user' || m.role === 'assistant') cleaned.push({ role: m.role, content: m.content });
  }

  const m = model.toLowerCase();
  let maxTokens = cfg.maxTokens ?? 16384;
  if (m.includes('haiku'))  maxTokens = cfg.maxTokens ?? 8192;
  if (m.includes('sonnet')) maxTokens = cfg.maxTokens ?? 64000;
  if (m.includes('opus'))   maxTokens = cfg.maxTokens ?? 32000;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': cfg.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    ...(cfg.headers ?? {})
  };

  const body = {
    model, max_tokens: maxTokens,
    temperature: opts.temperature ?? 0.3,
    system: system || undefined,
    messages: cleaned,
    stream
  };

  const r = await fetch(`${base}/v1/messages`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);

  if (!stream) {
    const data = await r.json() as { content?: { text?: string }[] };
    return { text: (data.content ?? []).map(b => b.text ?? '').join('') };
  }

  // SSE stream
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() ?? '';
    for (const ev of events) {
      const dl = ev.split('\n').find(l => l.startsWith('data:'));
      if (!dl) continue;
      const j = dl.slice(5).trim();
      if (j === '[DONE]') continue;
      try {
        const msg = JSON.parse(j);
        if (msg.type === 'content_block_delta' && msg.delta?.text) {
          full += msg.delta.text;
          opts.onDelta?.(msg.delta.text, full);
        }
      } catch { /* skip malformed */ }
    }
  }
  return { text: full };
}

/* ───── OpenAI + OpenAI-compatible ───── */

async function openaiSend(
  cfg: OpenAIConfig | OpenAICompatibleConfig,
  messages: ChatMessage[],
  opts: SendOptions = {}
): Promise<SendResult> {
  const isCompat = cfg.provider === 'openai-compatible';
  const base = (cfg.baseUrl ?? (isCompat ? '' : DEFAULTS.openai.baseUrl)).replace(/\/$/, '');
  if (!base) throw new Error('openai-compatible requires baseUrl');
  const model = cfg.model ?? (isCompat ? '' : DEFAULTS.openai.model);
  if (!model) throw new Error('model required');
  const stream = opts.stream !== false;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(cfg.apiKey ? { 'authorization': `Bearer ${cfg.apiKey}` } : {}),
    ...(cfg.headers ?? {})
  };

  // Wire-format mapper:
  //   - assistant + tool_calls → include tool_calls (with arguments
  //     re-serialized as JSON string, the format OpenAI/Gemini expect)
  //   - role:'tool' result → include both `tool_call_id` (links to the
  //     assistant's call) and `name` (function name). Gemini rejects the
  //     request with 400 "Name cannot be empty" if `name` is missing.
  const mapMessage = (m: ChatMessage): Record<string, unknown> => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content ?? '',
        tool_calls: m.tool_calls.map(tc => ({
          id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments ?? {})
          }
        }))
      };
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.tool_name    ? { name: m.tool_name }             : {})
      };
    }
    return { role: m.role, content: m.content };
  };

  const body: Record<string, unknown> = {
    model,
    messages: messages.map(mapMessage),
    temperature: opts.temperature ?? 0.3,
    stream
  };
  if (cfg.maxTokens) body.max_tokens = cfg.maxTokens;
  if (opts.tools)    body.tools = opts.tools;

  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 300)}`);

  if (!stream) {
    const data = await r.json() as { choices: { message: { content?: string; tool_calls?: NativeToolCall[] } }[] };
    const msg = data.choices?.[0]?.message ?? {};
    return { text: msg.content ?? '', toolCalls: msg.tool_calls };
  }

  // OpenAI SSE stream — must handle BOTH content deltas AND tool_call deltas.
  // OpenAI streams tool calls in two ways depending on the model:
  //   (a) Fragmented:  {tool_calls:[{index:0, id, function:{name}}]} then
  //                    {tool_calls:[{index:0, function:{arguments:'{"x'}}]}, ...
  //   (b) One-shot:    a single delta carries id + name + full arguments
  //                    (Gemini's OpenAI-compat endpoint does this).
  // We accumulate by `index` (or array position when index is absent) and
  // surface the assembled NativeToolCall[] alongside the text. Without this
  // the widget gets text:'', toolCalls:undefined for tool-only responses and
  // renders an empty bubble + sources footer ("cards only" bug).
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  const tcByIdx: Record<number, { id?: string; type?: string; name: string; args: string }> = {};
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() ?? '';
    for (const ev of events) {
      const dl = ev.split('\n').find(l => l.startsWith('data:'));
      if (!dl) continue;
      const j = dl.slice(5).trim();
      if (j === '[DONE]') continue;
      try {
        const msg = JSON.parse(j);
        const delta = msg.choices?.[0]?.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          full += delta.content;
          opts.onDelta?.(delta.content, full);
        }
        const toolCalls = delta.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            const idx = typeof tc.index === 'number' ? tc.index : i;
            const slot = tcByIdx[idx] ?? (tcByIdx[idx] = { name: '', args: '' });
            if (tc.id)            slot.id = tc.id;
            if (tc.type)          slot.type = tc.type;
            if (tc.function?.name)      slot.name = tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
          }
        }
      } catch { /* skip */ }
    }
  }
  const collected: NativeToolCall[] = Object.keys(tcByIdx)
    .map(k => Number(k)).sort((a, b) => a - b)
    .map(k => tcByIdx[k])
    .filter(s => s.name)
    .map(s => {
      let parsed: Record<string, unknown> = {};
      const raw = (s.args || '').trim();
      if (raw) {
        try { parsed = JSON.parse(raw) as Record<string, unknown>; }
        catch { parsed = { _raw: raw }; }   // surface for debugging, don't crash
      }
      return { id: s.id, type: 'function' as const, function: { name: s.name, arguments: parsed } };
    });
  return collected.length
    ? { text: full, toolCalls: collected }
    : { text: full };
}

/* ───── Ollama ───── */

async function ollamaSend(
  cfg: OllamaConfig,
  messages: ChatMessage[],
  opts: SendOptions = {}
): Promise<SendResult> {
  const host = (cfg.host ?? DEFAULTS.ollama.host).replace(/\/$/, '');
  const model = cfg.model;
  if (!model) throw new Error('Ollama: model required');
  const stream = opts.stream !== false;

  const tools = opts.tools;
  const useNativeTools = !!tools;     // we trust the caller to only pass tools when the model supports them

  const body: Record<string, unknown> = {
    model,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_name ? { tool_name: m.tool_name } : {})
    })),
    stream: useNativeTools ? false : stream,
    options: {
      temperature: opts.temperature ?? 0.3,
      num_predict: -1
    }
  };
  if (useNativeTools) body.tools = tools;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(cfg.headers ?? {})
  };

  const r = await fetch(`${host}/api/chat`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 300)}`);

  if (!(body.stream as boolean)) {
    const data = await r.json() as { message?: { content?: string; tool_calls?: NativeToolCall[] } };
    return { text: data.message?.content ?? '', toolCalls: data.message?.tool_calls };
  }

  // NDJSON stream
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const msg = JSON.parse(t);
        const delta = msg.message?.content ?? '';
        if (delta) {
          full += delta;
          opts.onDelta?.(delta, full);
        }
        if (msg.done) break;
      } catch { /* skip */ }
    }
  }
  return { text: full };
}

/* ───── Public dispatcher ───── */

export async function sendChat(
  cfg: LLMConfig,
  messages: ChatMessage[],
  opts: SendOptions = {}
): Promise<SendResult> {
  switch (cfg.provider) {
    case 'anthropic':         return anthropicSend(cfg, messages, opts);
    case 'openai':            return openaiSend(cfg, messages, opts);
    case 'openai-compatible': return openaiSend(cfg, messages, opts);
    case 'ollama':            return ollamaSend(cfg, messages, opts);
    default:
      throw new Error(`Unknown provider: ${(cfg as { provider: string }).provider}`);
  }
}

/* ───── Helper: list Ollama models for the picker ───── */
export async function listOllamaModels(host: string): Promise<string[]> {
  const r = await fetch(`${host.replace(/\/$/, '')}/api/tags`);
  if (!r.ok) throw new Error(`Ollama list failed: ${r.status}`);
  const data = await r.json() as { models?: { name: string }[] };
  return (data.models ?? []).map(m => m.name);
}
