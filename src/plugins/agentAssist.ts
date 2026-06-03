/**
 * Built-in plugin: agent-assist.
 *
 * Emits conversation lifecycle events to a configurable, same-origin HTTP
 * endpoint so a BACKEND can observe live chats — for analytics, lead
 * capture, or a human operator hand-off ("shadow chat"). The plugin is
 * deliberately generic: it knows nothing about how the backend uses the
 * events (Telegram, Slack, a database, a dashboard — all backend concerns).
 *
 * Three events, all POSTed as JSON to `endpoint`:
 *   { type: 'session_start',      sessionId, ts, page }            // first user message
 *   { type: 'user_message',       sessionId, ts, text }
 *   { type: 'assistant_response', sessionId, ts, text, elapsedMs, fromCache }
 *
 * `sessionId` matches the OpenAI `user` field Acolyte forwards on the chat
 * request itself, so a proxy can correlate events with the live LLM call
 * (e.g. to splice in an operator's reply). See docs.
 *
 * Design notes (per CONSTITUTION):
 *   - Hooks must be fast: posts are fire-and-forget, never awaited in the
 *     hook path, so they never delay the visitor's reply.
 *   - Posts are serialized through a tiny promise queue so the backend
 *     receives them in conversation order (user before assistant).
 *   - All failures are swallowed: a down backend must never break the chat.
 */

import type { AcolytePlugin } from '../plugin.js';

export interface AgentAssistConfig {
  /** Where to POST events. Default '/api/agent-assist/events' (same-origin). */
  endpoint?: string;
  /** Extra headers to send with each event POST (e.g. a shared token). */
  headers?: Record<string, string>;
  /** Set false to register the plugin but emit nothing (kill-switch). Default true. */
  enabled?: boolean;
}

interface AgentAssistEvent {
  type: 'session_start' | 'user_message' | 'assistant_response';
  sessionId: string;
  ts: string;
  text?: string;
  elapsedMs?: number;
  fromCache?: boolean;
  page?: { url: string; title: string; path: string; referrer: string };
}

export function agentAssist(cfg: AgentAssistConfig = {}): AcolytePlugin {
  const endpoint = cfg.endpoint ?? '/api/agent-assist/events';
  const enabled = cfg.enabled !== false;
  const headers = { 'content-type': 'application/json', ...(cfg.headers ?? {}) };

  let started = false;
  // Sequential post queue — keeps events in conversation order without
  // blocking the hook that enqueues them.
  let tail: Promise<void> = Promise.resolve();

  function post(evt: AgentAssistEvent): void {
    if (!enabled) return;
    tail = tail.then(async () => {
      try {
        await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(evt),
          keepalive: true
        });
      } catch {
        /* backend down / offline — best-effort, never bubble */
      }
    });
  }

  function pageInfo(): AgentAssistEvent['page'] {
    try {
      return {
        url: location.href,
        title: document.title,
        path: location.pathname,
        referrer: document.referrer || ''
      };
    } catch {
      return { url: '', title: '', path: '', referrer: '' };
    }
  }

  return {
    name: 'agentAssist',
    version: '0.1.0',

    beforeSend(ctx) {
      if (!started) {
        started = true;
        post({ type: 'session_start', sessionId: ctx.sessionId, ts: new Date().toISOString(), page: pageInfo() });
      }
      post({ type: 'user_message', sessionId: ctx.sessionId, ts: new Date().toISOString(), text: ctx.question });
      return ctx;
    },

    afterResponse(ctx) {
      post({
        type: 'assistant_response',
        sessionId: ctx.sessionId,
        ts: new Date().toISOString(),
        text: ctx.responseText,
        elapsedMs: ctx.elapsedMs,
        fromCache: ctx.fromCache
      });
    }
  };
}
