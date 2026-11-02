// 重新打包：第三方依赖全部走外部（运行时从 node_modules 解析），
// 避免把用 require 的 CJS 依赖塞进 ESM 产物
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const root = 'C:/DSHwork/plugins-src/dsh-qq-group';
const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));

await build({
  entryPoints: [`${root}/src/index.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  outfile: `${root}/lib/index.js`,
  packages: 'external',
  define: { __DSH_PLUGIN_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'error',
});
console.log('打包完成，版本', pkg.version);
