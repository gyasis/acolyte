import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendChat } from '../src/providers/index.ts';

// Serve `chunks` as the body of a streamed fetch response.
function stubFetch(chunks: string[]) {
  const enc = new TextEncoder();
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); },
  }), { status: 200 })) as typeof fetch;
}

const ollama = { provider: 'ollama', host: 'http://x', model: 'm' } as any;
const openai = { provider: 'openai-compatible', baseUrl: 'http://x', apiKey: 'k', model: 'm' } as any;
const msgs = [{ role: 'user', content: 'hi' }] as any;

const ol = (o: object) => JSON.stringify(o) + '\n';
const sse = (o: object | string) => `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`;

test('ollama: normal stream is unchanged', async () => {
  stubFetch([ol({ message: { content: 'Hel' } }), ol({ message: { content: 'lo' } }), ol({ done: true })]);
  assert.equal((await sendChat(ollama, msgs)).text, 'Hello');
});

test('ollama: error line rejects and partial text was streamed first', async () => {
  stubFetch([ol({ message: { content: 'Par' } }), ol({ error: 'upstream timed out', done: true })]);
  let seen = '';
  await assert.rejects(sendChat(ollama, msgs, { onDelta: (_d, f) => { seen = f; } }),
    /Answer interrupted: upstream timed out/);
  assert.equal(seen, 'Par');
});

test('ollama: unparseable line is skipped', async () => {
  stubFetch([ol({ message: { content: 'a' } }), 'not json\n', ol({ message: { content: 'b' } }), ol({ done: true })]);
  assert.equal((await sendChat(ollama, msgs)).text, 'ab');
});

test('openai: normal stream is unchanged', async () => {
  stubFetch([sse({ choices: [{ delta: { content: 'Hi' } }] }), sse({ choices: [{ delta: { content: '!' } }] }), sse('[DONE]')]);
  assert.equal((await sendChat(openai, msgs)).text, 'Hi!');
});

test('openai: error object chunk rejects', async () => {
  stubFetch([sse({ choices: [{ delta: { content: 'Par' } }] }), sse({ error: { message: 'upstream timed out' } })]);
  await assert.rejects(sendChat(openai, msgs), /Answer interrupted: upstream timed out/);
});

test('openai: error string chunk rejects', async () => {
  stubFetch([sse({ error: 'boom' })]);
  await assert.rejects(sendChat(openai, msgs), /Answer interrupted: boom/);
});

test('openai: unparseable chunk is skipped', async () => {
  stubFetch([sse('{broken'), sse({ choices: [{ delta: { content: 'ok' } }] }), sse('[DONE]')]);
  assert.equal((await sendChat(openai, msgs)).text, 'ok');
});
