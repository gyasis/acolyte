# Voice-follow: SPEAK that points

The "voice-follow" feature lets the SPEAK voice **point at parts of the
page** as it speaks about them. The widget scrolls the page (only when
needed) and softly highlights the section, giving the reader a
follow-along reading experience without hijacking their scroll.

This doc explains how it works end-to-end, when it triggers, and how
to author content that benefits from it.

---

## The mechanism in one minute

1. When the user asks a question, the widget retrieves relevant
   passages from the page (BM25 over DOM headings).
2. Each passage carries a stable DOM id. If the heading didn't have a
   `id` attribute, the auto-RAG scanner stamps one back onto it
   (`acolyte-h-0`, `acolyte-h-1`, …) before indexing.
3. The system prompt feeds the LLM the passages with their ids, and
   the `speak_commentary` block instructs the model to emit inline
   `<ref id="…">` markers in the SPEAK block — **only** when it's
   literally pointing at a visible artifact.
4. When the user clicks 🔊 to play the SPEAK block, the TTS engine
   splits the text by `<ref>` markers into ordered segments. Before
   each spoken segment, the widget fires `onRef(id)` to scroll +
   highlight the matching DOM element.

The markers never become audible — they're stripped from the spoken
text. They never appear in the rendered chat bubble either (the same
strip happens at render time).

---

## What the model sees in the prompt

For every retrieved passage, the system prompt includes a tagged
header:

```
===== RELEVANT PASSAGES =====
[1] {id="acolyte-h-4"} Signatures — the contract
…passage text…

[2] {id="acolyte-h-15"} Anatomy of a Signature call
…passage text…
```

And the `speak_commentary` prompt block adds RULE #6, which (paraphrased)
says: *use these ids inside `<ref id="…">` markers — but only as a
pointing gesture, not a footnote.*

---

## When the model emits a `<ref>`

The prompt explicitly tells the model:

**Do** emit a `<ref>` when:
- The next sentence will literally describe what's on screen at that
  anchor ("here you can see…", "this code block is where…").
- It's the first mention of a key section, to orient the reader.

**Don't** emit a `<ref>` when:
- Mentioning a section topically ("Module 5 covers this").
- Re-referring to a section already pointed at this turn.
- General theory not tied to a visible artifact.

Target: 0–2 refs per SPEAK block. Hard cap: 3. If the reader could keep
reading the chat without looking at the page, the marker is wrong and
should be removed.

The model handles both emission forms:

```
<ref id="some-id">     ← marker-only, fires before the next sentence
<ref id="some-id">phrase</ref>   ← wrapping form, fires at the opening
```

Both produce the same behavior — the closing tag is stripped from
spoken text. The widget treats either as "point here, then continue
speaking."

---

## Scroll & highlight policy

The widget's `followAlongTo(id)` function is intentionally conservative:

| Situation                                              | Behavior                       |
|--------------------------------------------------------|--------------------------------|
| First ref of the speech, target fully offscreen        | Smooth-scroll to center + glow |
| First ref of the speech, target visible in viewport    | Glow only, no scroll           |
| Subsequent ref of the speech                           | Glow only, no scroll           |
| Same id mentioned a second time                        | Ignored entirely (dedupe)      |

Two design choices to call out:

1. **One orientation scroll per speech, max.** After the first ref, the
   reader is in control of their scroll position. The widget refuses
   to re-orient them mid-speech. If the voice circles back to an
   earlier section, only the glow re-asserts.

2. **Glow is a single soft fade.** It's a 3.4-second animation: fade in,
   hold for a beat, fade out. No continuous pulse. The gesture is
   "look here for a moment" — not "I am still talking about this."

Visited ids are tracked in a `Set<string>` per playback. Replaying the
same answer starts a fresh set, so the same first-mention sections
re-trigger their orientation logic.

---

## Authoring tips for the host page

The mechanism works on any page. Two ways to make it work *better*:

### 1. Give your headings real ids

The auto-RAG scanner stamps synthetic `acolyte-h-N` ids on every
`<h1>`/`<h2>`/`<h3>` that doesn't already have one. That's fine — but
synthetic ids are stable only within a single mount. If your page is a
SPA that reorders content, the stamped ids may drift across mounts.

If your headings carry meaningful semantic ids ("optimizer-tree",
"miprov2-recipe"), the LLM will use those instead, which produces
better passage prompts (the model sees a meaningful name) and stable
deep links.

```html
<!-- bad: unstable scroll target across mounts -->
<h2>Which optimizer should I reach for?</h2>

<!-- good: stable, meaningful, deep-linkable -->
<h2 id="optimizer-decision-tree">Which optimizer should I reach for?</h2>
```

### 2. Make the visible artifact actually scannable

The model points at what it's about to describe. If the artifact at
that anchor is just a single `<p>` of prose, the reader's eye lands
on text and they wonder what they're supposed to notice. The pointing
gesture works best when the anchor is:

- A code block with a specific trick on a specific line
- A diagram or labeled image
- A table comparing options
- A formula
- A boxed definition or callout

Sections that are just running prose work too — the voice still narrates
what to think about — but the "look here" payoff is weaker.

---

## CSS hook

The glow is a single CSS class with a one-shot keyframe:

```css
.acolyte-following-voice {
  animation: acolyte-following-voice 3.4s ease-out forwards;
  border-radius: 6px;
  scroll-margin-top: 80px;
}
```

To restyle it, override `.acolyte-following-voice` in your own CSS
*after* the Acolyte stylesheet loads. The widget only sets the class —
it doesn't apply inline styles, so your overrides win.

To disable the glow without disabling the navigation gesture entirely,
set:

```css
.acolyte-following-voice { animation: none !important; }
```

To disable voice-follow entirely (e.g., business persona that should
never autoscroll the host page), don't include the `speak_commentary`
prompt block in your persona — or use a custom persona that omits
RULE #6.

---

## Failure modes & graceful degradation

| Failure                                              | Result                              |
|------------------------------------------------------|-------------------------------------|
| Model emits an id not in the passages list           | `getElementById` returns null, the call is a no-op. Speech continues. |
| Model emits no `<ref>` markers at all                | Voice plays as a single utterance, no scroll/highlight. Normal SPEAK behavior. |
| Page has a section with id but the BM25 didn't surface it | Model never sees the id, never points at it. |
| Auto-RAG is disabled (`rag.enabled: false`)          | No passages, no ids, no `<ref>` markers — voice still works. |
| `cfg.voice.engine = 'kokoro'` and Kokoro fails to load | Webspeech fallback path also honors `<ref>` — same behavior. |

The mechanism is purely additive. If anything in the chain breaks, the
fallback is "play the voice without scroll" — which is the same
behavior as a chat widget without voice-follow.

---

## Related code

- `src/prompts/blocks.ts::speak_commentary` — RULE #6 (when to emit
  `<ref>`).
- `src/widget.ts::buildContextBlock` — surfaces `{id="…"}` in the
  passages block.
- `src/internal/rag.ts::segmentByHeadings` — stamps `acolyte-h-N` ids
  on headings without their own id.
- `src/internal/tts.ts::splitByRefs` — segments SPEAK text by `<ref>`
  markers, fires `onRef` between segments.
- `src/widget.ts::followAlongTo` — the dedupe + orient-once-per-speech
  scroll policy.
- `src/styles.css::.acolyte-following-voice` — the glow keyframe.
