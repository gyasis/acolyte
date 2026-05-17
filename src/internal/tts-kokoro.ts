/**
 * Kokoro neural TTS engine — opt-in alternative to the Web Speech API.
 *
 * Loads `kokoro-js` (a ~80 MB ONNX model + WASM/WebGPU runtime) from CDN
 * the first time speak() is called. Subsequent calls reuse the cached
 * model — first run costs the download, every run after is free and
 * fully offline.
 *
 * Lazy by design: importing this module does NOT trigger a network hit;
 * only the first `await engine.ensureLoaded()` does.
 *
 * Falls back to Web Speech API if anything goes wrong (no WebGPU, no
 * cache, no network on first run, etc.).
 */

declare global {
  // kokoro-js exposes a `KokoroTTS` class once the CDN module is loaded.
  // We avoid typing it tightly here so we don't drag the full type
  // surface into the bundle — runtime structural checks are enough.
  interface Window { __acolyteKokoro?: any; }
}

const KOKORO_CDN = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.0/+esm';

/** Default Kokoro voice ids that ship with the model. */
export const KOKORO_VOICES = [
  // American female
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_nicole', 'af_sarah',
  // American male
  'am_adam', 'am_michael', 'am_onyx',
  // British female
  'bf_emma', 'bf_isabella',
  // British male
  'bm_george', 'bm_lewis'
];

export interface KokoroSpeakOpts {
  voice?: string;
  rate?: number;
  onStart?: () => void;
  onEnd?: () => void;
  onProgress?: (pct: number) => void;
}

export class KokoroEngine {
  private model: any = null;
  private loadPromise: Promise<any> | null = null;
  private audio: HTMLAudioElement | null = null;
  loaded = false;
  loadingProgress = 0;

  static supported(): boolean {
    // Kokoro needs ONNX runtime. Works on WebGPU (fast) or WASM (slow).
    if (typeof window === 'undefined') return false;
    return !!(window.WebAssembly);
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) { await this.loadPromise; return; }
    this.loadPromise = (async () => {
      // Lazy import the kokoro-js module from CDN
      const mod: any = await import(/* @vite-ignore */ KOKORO_CDN).catch((e) => {
        console.warn('[acolyte] kokoro-js import failed:', e);
        throw e;
      });
      const KokoroTTS = mod.KokoroTTS ?? mod.default?.KokoroTTS ?? mod.default;
      if (!KokoroTTS) throw new Error('kokoro-js: KokoroTTS class not found in module');
      // Pick the right runtime: WebGPU if available, else WASM
      const device = (typeof navigator !== 'undefined' && (navigator as any).gpu) ? 'webgpu' : 'wasm';
      this.model = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: device === 'webgpu' ? 'fp32' : 'q8',
        device,
        progress_callback: (p: any) => {
          if (p && typeof p.progress === 'number') this.loadingProgress = p.progress;
        }
      });
      this.loaded = true;
    })();
    try { await this.loadPromise; }
    finally { this.loadPromise = null; }
  }

  cancel(): void {
    if (this.audio) {
      try { this.audio.pause(); } catch { /* ignore */ }
      this.audio = null;
    }
  }

  /**
   * Synthesize and play a single utterance. Resolves when playback ends.
   * If the model isn't loaded yet, this triggers ensureLoaded() (which
   * is the heavy first-call). Caller should reflect a loading state in
   * the UI before awaiting this on the first call.
   */
  async speak(text: string, opts: KokoroSpeakOpts = {}): Promise<void> {
    if (!text?.trim()) return;
    await this.ensureLoaded();
    this.cancel();

    const audio = await this.model.generate(text, {
      voice: opts.voice ?? 'bm_george',   // British male default to match webspeech default
      speed: opts.rate ?? 1.0
    });
    // kokoro-js returns a RawAudio with `.toBlob()` (or `.toWav()`).
    // Wrap as a Blob URL and play via <audio>.
    const blob: Blob = await audio.toBlob();
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    this.audio = el;
    return new Promise<void>((resolve, reject) => {
      el.onplay = () => opts.onStart?.();
      el.onended = () => { URL.revokeObjectURL(url); opts.onEnd?.(); resolve(); };
      el.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Kokoro audio playback failed')); };
      el.play().catch(reject);
    });
  }
}
