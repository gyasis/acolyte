/**
 * Text-to-speech: dual-engine wrapper.
 *
 * Default engine: Web Speech API (`window.speechSynthesis`). Zero install,
 * uses the OS's shipped voices, fastest startup.
 *
 * Opt-in engine: Kokoro neural TTS (`./tts-kokoro.ts`). ~80 MB model
 * download on first use, cached forever, dramatically more natural voice.
 *
 * The engine is selected via `voice.engine` config:
 *   'webspeech' | 'kokoro' | 'auto'
 *
 * Switching engines is hot — the public speak()/cancel() surface is the
 * same regardless. The widget never touches engine internals.
 */

import type { VoiceConfig } from '../types.js';
import { KokoroEngine } from './tts-kokoro.js';

const SPEAK_RE = /\[\[\s*SPEAK\s*\]\]([\s\S]*?)\[\[\s*\/?\s*SPEAK\s*\]\]/i;
/** Opening <ref id="dom-section-id"> marker emitted by the LLM in a SPEAK
 *  block. TTS strips these from spoken text and fires onRef() when crossed. */
const REF_RE = /<ref\s+id\s*=\s*["']([^"']+)["']\s*\/?\s*>/gi;
/** Some models also emit a wrapping form: <ref id="x">phrase</ref>. The
 *  closing tag carries no anchor info; we just strip it from the text so
 *  TTS never reads it aloud. */
const REF_CLOSE_RE = /<\/\s*ref\s*>/gi;

const MALE_HINTS = /\b(male|man|guy|daniel|oliver|george|mark|arthur|brian|graham|nathan|ralph|alex|fred|reed|aaron|tom|david|bruce|james|jamie|liam|kieran|miles|simon|stephen|matthew|peter)\b/i;
const FEMALE_HINTS = /\b(female|woman|girl|samantha|kate|fiona|moira|tessa|karen|susan|vicki|allison|ava|serena|emma|amelia|hazel|isabella|olivia|sophia|ruth|sara|libby|laura|catherine|caroline|hollie|abigail|martha|maisie)\b/i;
const UK_HINTS = /(uk|british|en-gb|england|english uk|microsoft george|microsoft mark|microsoft hazel|microsoft sonia|microsoft ryan|microsoft thomas|microsoft libby|google uk|daniel|oliver|kate|moira|fiona|arthur|hollie|stephen|liam|maisie|hugh)/i;

export class TTSEngine {
  private cfg: VoiceConfig;
  supported: boolean;
  private kokoro: KokoroEngine | null = null;

  constructor(cfg: VoiceConfig = {}) {
    this.cfg = { enabled: true, accent: 'en-GB', gender: 'male', rate: 1.0, engine: 'webspeech', ...cfg };
    this.supported = typeof speechSynthesis !== 'undefined' || KokoroEngine.supported();
    if (typeof speechSynthesis !== 'undefined' && speechSynthesis.onvoiceschanged !== undefined) {
      speechSynthesis.onvoiceschanged = () => { /* triggers fresh listVoices */ };
    }
  }

  update(cfg: Partial<VoiceConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  /** Which engine is active right now (after 'auto' resolution). */
  activeEngine(): 'kokoro' | 'webspeech' {
    if (this.cfg.engine === 'kokoro') return 'kokoro';
    if (this.cfg.engine === 'auto') {
      const hasWebGPU = typeof navigator !== 'undefined' && !!(navigator as any).gpu;
      return hasWebGPU ? 'kokoro' : 'webspeech';
    }
    return 'webspeech';
  }

  /** True if Kokoro is being used and its model has finished loading. */
  kokoroLoaded(): boolean { return !!this.kokoro?.loaded; }

  /** True only when Kokoro is the active engine and the model is mid-download. */
  kokoroLoading(): boolean { return !!this.kokoro && !this.kokoro.loaded; }

  private ensureKokoro(): KokoroEngine {
    if (!this.kokoro) this.kokoro = new KokoroEngine();
    return this.kokoro;
  }

  extractSpeakBlock(text: string): string | null {
    const m = text?.match(SPEAK_RE);
    return m ? m[1].trim() : null;
  }

  stripSpeakBlock(text: string): string {
    return (text ?? '').replace(SPEAK_RE, '').trim();
  }

  /** Strip the invisible <ref id="..."> anchor markers (and any closing
   *  </ref> from the wrapping-form emission) — they steer the follow-along
   *  scroller, but TTS must never read them aloud. */
  stripRefMarkers(text: string): string {
    return (text ?? '')
      .replace(REF_RE, '')
      .replace(REF_CLOSE_RE, '')
      .replace(/\s{2,}/g, ' ').trim();
  }

  /** Split a SPEAK block into ordered segments. Each segment is either a
   *  ref-anchor (a section id the page should scroll to) or a piece of
   *  spoken text. The widget plays them in order, scrolling on anchors
   *  and speaking on text. */
  splitByRefs(text: string): Array<{ kind: 'ref'; id: string } | { kind: 'text'; text: string }> {
    if (!text) return [];
    const out: Array<{ kind: 'ref'; id: string } | { kind: 'text'; text: string }> = [];
    let last = 0;
    REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const clean = (s: string): string => s.replace(REF_CLOSE_RE, '').replace(/\s{2,}/g, ' ').trim();
    while ((m = REF_RE.exec(text)) !== null) {
      if (m.index > last) {
        const chunk = clean(text.slice(last, m.index));
        if (chunk) out.push({ kind: 'text', text: chunk });
      }
      out.push({ kind: 'ref', id: m[1] });
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      const chunk = clean(text.slice(last));
      if (chunk) out.push({ kind: 'text', text: chunk });
    }
    return out;
  }

  spokenVersionFromMarkdown(text: string): string {
    if (!text) return '';
    const block = this.extractSpeakBlock(text);
    // Keep <ref id="..."> markers intact here — speak() consumes them to
    // drive page-scroll/highlight synchronization. They are stripped from
    // the spoken audio inside speak() (per-segment) and via stripRefMarkers
    // when callers need a pure transcript.
    if (block) return block;

    let t = text;
    const hadCode  = /```/.test(t);
    t = t.replace(/```[\s\S]*?```/g, ' ');
    const hadTable = /^.*\|.*\|.*$/m.test(t);
    t = t.replace(/^.*\|.*\|.*$/gm, ' ')
         .replace(/^#{1,6}\s+/gm, '')
         .replace(/^>\s?/gm, '')
         .replace(/`([^`]+)`/g, '$1')
         .replace(/\*\*([^*]+)\*\*/g, '$1')
         .replace(/\*([^*]+)\*/g, '$1')
         .replace(/_([^_]+)_/g, '$1')
         .replace(/~~([^~]+)~~/g, '$1')
         .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
         .replace(/^\s*[-*+]\s+/gm, '')
         .replace(/^\s*\d+\.\s+/gm, '')
         .replace(/\s*\n\s*\n\s*/g, '. ')
         .replace(/\n+/g, ' ')
         .replace(/\s{2,}/g, ' ')
         .trim();

    const hints: string[] = [];
    if (hadCode)  hints.push('I included a code block in the message');
    if (hadTable) hints.push('I included a table in the message');
    if (hints.length) t += (t.endsWith('.') ? ' ' : '. ') + hints.join(' and ') + '.';
    return t;
  }

  listVoices(): SpeechSynthesisVoice[] {
    if (!this.supported) return [];
    const list = speechSynthesis.getVoices().slice();
    const lang = (navigator.language || '').toLowerCase();
    list.sort((a, b) => {
      const aLocal = (a.lang || '').toLowerCase().slice(0, 2) === lang.slice(0, 2);
      const bLocal = (b.lang || '').toLowerCase().slice(0, 2) === lang.slice(0, 2);
      if (aLocal && !bLocal) return -1;
      if (!aLocal && bLocal) return 1;
      return a.name.localeCompare(b.name);
    });
    return list;
  }

  private scoreVoice(v: SpeechSynthesisVoice, prefs: { gender?: string; lang?: string }): number {
    let s = 0;
    const name = v.name || '';
    const lang = (v.lang || '').toLowerCase();
    const prefLang = (prefs.lang || '').toLowerCase();
    if (prefLang && lang === prefLang) s += 120;
    else if (prefLang && lang.slice(0, 2) === prefLang.slice(0, 2)) s += 40;
    if (prefLang === 'en-gb' && UK_HINTS.test(name)) s += 35;
    if (prefs.gender === 'male')   s += MALE_HINTS.test(name)   ? 60 : (FEMALE_HINTS.test(name) ? -40 : 0);
    if (prefs.gender === 'female') s += FEMALE_HINTS.test(name) ? 60 : (MALE_HINTS.test(name)   ? -40 : 0);
    if (/default/i.test(name)) s -= 5;
    return s;
  }

  pickVoice(): SpeechSynthesisVoice | null {
    const voices = this.listVoices();
    if (!voices.length) return null;
    if (this.cfg.voiceName) {
      const m = voices.find(v => v.name === this.cfg.voiceName);
      if (m) return m;
    }
    const ranked = voices
      .map(v => ({ v, s: this.scoreVoice(v, { gender: this.cfg.gender, lang: this.cfg.accent }) }))
      .sort((a, b) => b.s - a.s);
    return ranked[0]?.s > 0 ? ranked[0].v : voices[0] ?? null;
  }

  private chunk(text: string, maxLen = 220): string[] {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const out: string[] = [];
    let buf = '';
    for (const s of sentences) {
      if ((buf + ' ' + s).length > maxLen && buf) { out.push(buf.trim()); buf = s; }
      else buf = buf ? buf + ' ' + s : s;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  cancel(): void {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.kokoro?.cancel();
  }

  async speak(
    text: string,
    opts: {
      onStart?: () => void;
      onEnd?: () => void;
      rate?: number;
      /** Fired just before the *next* spoken segment when a <ref id="..">
       *  marker was crossed. The widget uses this to scroll/highlight
       *  the matching DOM section as the voice talks about it. */
      onRef?: (id: string) => void;
    } = {}
  ): Promise<void> {
    this.cancel();
    if (!text?.trim()) return;
    // If the text contains <ref> markers, play the segments in order:
    // text → speak; ref → fire callback then continue. Keeps speech and
    // page-scroll synchronized without changing the engine surface.
    if (opts.onRef && REF_RE.test(text)) {
      const segments = this.splitByRefs(text);
      let firedStart = false;
      for (const seg of segments) {
        if (seg.kind === 'ref') { try { opts.onRef(seg.id); } catch { /* ignore */ } continue; }
        const clean = seg.text;
        if (!clean) continue;
        await this.speakOnce(clean, {
          onStart: firedStart ? undefined : opts.onStart,
          rate: opts.rate
        });
        firedStart = true;
      }
      opts.onEnd?.();
      return;
    }
    // No refs — single utterance path
    return this.speakOnce(this.stripRefMarkers(text), opts);
  }

  /** One-segment speak helper used by the ref-aware orchestrator and the
   *  no-ref fast path. */
  private async speakOnce(text: string, opts: { onStart?: () => void; onEnd?: () => void; rate?: number }): Promise<void> {
    if (!text.trim()) return;
    if (this.activeEngine() === 'kokoro') {
      // Fall back to WebSpeech if Kokoro fails to load (no WebGPU /
      // network blocked / etc.). Keeps the widget functional regardless.
      try {
        const k = this.ensureKokoro();
        await k.speak(text, {
          voice: this.cfg.kokoroVoice ?? defaultKokoroVoiceFor(this.cfg),
          rate: opts.rate ?? this.cfg.rate ?? 1.0,
          onStart: opts.onStart,
          onEnd: opts.onEnd
        });
        return;
      } catch (e) {
        console.warn('[acolyte] Kokoro failed, falling back to webspeech:', e);
        // fall through to webspeech path below
      }
    }
    await this.speakWebSpeech(text, opts);
  }

  private async speakWebSpeech(
    text: string,
    opts: { onStart?: () => void; onEnd?: () => void; rate?: number }
  ): Promise<void> {
    if (typeof speechSynthesis === 'undefined') throw new Error('SpeechSynthesis not supported');
    const voice = this.pickVoice();
    const rate = opts.rate ?? this.cfg.rate ?? 1.0;
    const chunks = this.chunk(text);
    if (!chunks.length) return;
    let i = 0;
    return new Promise((resolve, reject) => {
      const next = () => {
        if (i >= chunks.length) { opts.onEnd?.(); resolve(); return; }
        const u = new SpeechSynthesisUtterance(chunks[i]);
        if (voice) u.voice = voice;
        u.rate = rate;
        u.lang = voice?.lang || navigator.language || 'en-US';
        u.onstart = () => { if (i === 0) opts.onStart?.(); };
        u.onerror = (e) => {
          if (e.error === 'canceled' || e.error === 'interrupted') { resolve(); return; }
          reject(new Error('TTS error: ' + e.error));
        };
        u.onend = () => { i += 1; next(); };
        speechSynthesis.speak(u);
      };
      next();
    });
  }
}

/** Pick a Kokoro voice that roughly matches the user's accent + gender prefs. */
function defaultKokoroVoiceFor(cfg: VoiceConfig): string {
  const accent = (cfg.accent ?? 'en-GB').toLowerCase();
  const female = cfg.gender === 'female';
  if (accent === 'en-gb') return female ? 'bf_emma' : 'bm_george';
  return female ? 'af_bella' : 'am_michael';
}
