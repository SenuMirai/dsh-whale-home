import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  dts: false,
  outDir: 'lib',
  clean: false,
  external: [/^@deepseek-ai\//, /^node:/],
  define: {
    __DSH_PLUGIN_VERSION__: JSON.stringify(pkg.version),
  },
});
