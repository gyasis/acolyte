# Personas

A persona is the chat's *behavior contract* — who it is, how it grounds
its answers, how it speaks aloud, what it refuses. Personas drive the
system prompt; they do not drive appearance (see `docs/styling.md` for
visual themes).

## The one rule every persona must honor

From `CONSTITUTION.md` → Purpose:

> **Acolyte does NOT repeat the page back to the reader.** The widget's
> job is to supply **supplementary, ancillary, or net-new** information
> grounded in what the reader sees. If a reply could be replaced by
> *"reread paragraph 3 of the page"*, the widget failed.

Every built-in persona is engineered around this rule. When you write a
custom persona, your `role` text must reinforce it — point the model at
*adding value beyond what's visible*, not summarizing what is.

The widget's prompt assembler also injects an explicit "supplement-don't-
restate" reminder into every system message, so even a poorly-written
custom persona inherits the behavior. But persona authors should not
rely on that safety net — make the role itself reflect the principle.

## Quick selection

```ts
mount({ llm: { ... }, persona: 'teacher' });    // built-in
mount({ llm: { ... }, persona: 'docs' });
mount({ llm: { ... }, persona: 'business' });
mount({ llm: { ... }, persona: 'bare' });
mount({ llm: { ... }, persona: customPersonaObject });
```

## Built-in personas

| Name       | For                              | Voice style    | Grounding   | Greeting style              |
|------------|----------------------------------|----------------|-------------|-----------------------------|
| `teacher`  | Tutorial / course pages          | commentary     | permissive  | Warm, inviting              |
| `docs`     | API reference, technical docs    | commentary     | strict      | Concise, technical          |
| `business` | Customer support / sales         | verbatim       | strict      | Brand-warm, friendly        |
| `bare`     | Nothing fancy                    | verbatim       | permissive  | Minimal                     |

## Custom persona shape

```ts
{
  role: 'You are an expert tutor for the SaltyDog API docs...',     // required
  tone: 'warm' | 'professional' | 'concise' | 'playful' | 'academic',
  speakStyle: 'commentary' | 'verbatim' | 'off',
  grounding: 'strict' | 'permissive',
  refusalPolicy: 'redirect' | 'apologize' | 'answer',
  greeting: 'Hi! Ask me anything about ...',
  extras: 'Always cite docs by URL when relevant.'                 // appended to system prompt
}
```

## What each field actually does

### `role`

The opening sentence of the system prompt. Sets identity. Required.

### `tone`

Appended to the prompt as a style hint. The LLM treats it as a tone
modifier. Subtle but real effect.

### `speakStyle`

Drives the SPEAK block instructions injected into the prompt.

- **`'commentary'`** — voice acts as expert narrator: comments on what's
  on screen, points at key insights, doesn't restate the answer. Best
  for teaching / explanation contexts.
- **`'verbatim'`** — voice is a clean spoken version of the written
  answer. Best for business / docs contexts where the listener expects
  the answer, not commentary on it.
- **`'off'`** — no `[[SPEAK]]` block emitted; voice playback disabled
  for this persona.

### `grounding`

- **`'strict'`** — refuses to answer outside supplied RAG passages.
  Offers to call a tool or search the web instead.
- **`'permissive'`** — uses passages when they help, falls back to
  general knowledge otherwise. Doesn't preface answers with "the page
  doesn't cover this".

### `refusalPolicy`

What to do when a question is out of scope.

- `'redirect'` — politely steer toward what the persona can help with
- `'apologize'` — say it can't, no value-add
- `'answer'` — try anyway

### `greeting`

The first message the assistant shows when the chat opens. Single
sentence usually. Persona-flavored.

### `extras`

Free-form text appended to the assembled system prompt. Use for
client-specific rules ("always include the SKU when discussing
products", "never quote prices", etc.).

## How the system prompt is assembled

```
[persona.role]
+ [grounding block]      ← from persona.grounding
+ [tools block]          ← from enabled tools
+ [speak block]          ← from persona.speakStyle
+ [math block]           ← KaTeX instruction
+ [persona.extras]
+ "==== RELEVANT PASSAGES ===="     ← from RAG (current page + plugin sources)
+ "==== EARLIER CONVERSATIONS ===="  ← from ChatDB.searchConversations
```

The widget builds this per-message. You don't have to write any of it —
just set `persona: '...'` or pass a custom object.

## Writing a custom persona — the supplement-don't-restate test

Before shipping a custom persona, ask:

1. Could the model satisfy this `role` by paraphrasing the page? If yes,
   the role is too weak. Strengthen it with explicit "explain, expand,
   connect" verbs.
2. Does the `greeting` invite questions that *require* net-new info? Or
   could the reader just scroll up to find the answer? If the latter,
   rewrite.
3. If `speakStyle: 'verbatim'` is set, does this persona have an
   accessibility / read-aloud justification? If not, default to
   `'commentary'`.
4. If `grounding: 'strict'` is set, does the use case genuinely need
   refusal-on-miss (e.g. compliance, legal, support agent staying on
   script)? If not, use `'permissive'` so the model can teach beyond
   the page when relevant.

A persona that fails any of these tests is repackaging summarization,
which is what the constitution explicitly forbids.

## Adding a persona via plugin

```ts
{
  name: 'my-plugin',
  personas: [{
    name: 'support',
    persona: {
      role: 'You are a Tier-2 technical support agent...',
      tone: 'professional', speakStyle: 'verbatim',
      grounding: 'strict', refusalPolicy: 'redirect',
      greeting: 'Hi! What can I help you with today?'
    }
  }]
}
```

After the plugin is registered, `persona: 'support'` works in config.
