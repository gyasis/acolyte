import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Inline the CSS into a JS string so we can auto-inject it at mount time —
// caller never has to import a separate stylesheet.
const cssText = readFileSync(resolve(__dirname, 'src/styles.css'), 'utf-8');

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: true,
  target: 'es2020',
  platform: 'browser',
  globalName: 'Acolyte',
  define: {
    __ACOLYTE_CSS__: JSON.stringify(cssText)
  },
  // Bundle marked + dompurify + katex into the output. Adds ~250 KB total
  // gzipped, but the trade-off is a true single-file drop-in.
  noExternal: ['marked', 'dompurify', 'katex'],
  // Copy the css alongside dist so callers can also import it directly if
  // they want (e.g. for SSR where auto-injection is undesirable).
  loader: { '.css': 'copy' },
  // Use treeshake to keep payload small.
  treeshake: true
});
