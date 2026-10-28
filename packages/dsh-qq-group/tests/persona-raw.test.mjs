/**
 * dsh-world 人设改成「整段纯文本」的验证。
 *
 * 不依赖宿主：直接 import 新写的 lib/persona.js，验证
 *   · 读写整段原文
 *   · 旧的按层调用还能用（不炸）
 *   · 空文本等于清空（删文件）
 *   · 真实角色卡能原样读回、不丢一行
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const WORLD = new URL('../../dsh-world/lib/persona.js', import.meta.url);
const mod = await import(WORLD.href);
const { readPersonaText, writePersonaText, readPersona, writePersona, renderPersona, PERSONA_LAYERS } = mod;

// 临时目录用工作区自己的，宿主的 Temp 被 ACL 挡着
const dir = join(process.cwd(), '.tmp-persona-test');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'persona.md');
const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };

try {
  // ── 1. 文件不存在 = 空串 ──
  assert.equal(readPersonaText(file), '', '不存在的文件应读成空串');

  // ── 2. 写整段原文，原样读回 ──
  const card = ['DeepSeek 小鲸鱼 · 角色卡', '', '一、你是谁', '', '你是 DeepSeek，一个以 AI 身份混在 QQ 群里的网络角色。'].join('\n');
  writePersonaText(file, card);
  assert.equal(readPersonaText(file).trimEnd(), card, '写入后应原样读回');

  // ── 3. 自动补结尾换行，但不改内容 ──
  const back = readPersonaText(file);
  assert.ok(back.endsWith('\n'), '应自动补一个结尾换行');
  assert.equal(back.trimEnd(), card, '补换行不能动内容');

  // ── 4. renderPersona 直接返回原文（不再拼六层）──
  assert.equal(renderPersona(readPersona(file)).trimEnd(), card, 'renderPersona 应等于原文');

  // ── 5. 旧的按层调用不炸：只认「全文」 ──
  const layered = readPersona(file);
  assert.equal(layered['全文'].trimEnd(), card);
  assert.equal(layered['名字'], '', '纯文本下没有名字层');
  for (const layer of PERSONA_LAYERS) assert.equal(typeof layered[layer], 'string');

  // ── 6. 旧代码按层写：写「全文」有效，写别的层无效 ──
  writePersona(file, { 名字: '不该生效', 全文: '新的一段人设' });
  assert.equal(readPersonaText(file).trimEnd(), '新的一段人设', '按层写应只认全文');
  assert.ok(!readPersonaText(file).includes('不该生效'), '别的层不该被写进去');

  // ── 7. 空文本 = 清空（删文件）──
  writePersonaText(file, '   ');
  assert.equal(existsSync(file), false, '空白文本应删掉文件');
  assert.equal(readPersonaText(file), '', '删掉之后读成空串');

  // ── 8. 大段角色卡：一字不丢 ──
  // 默认用合成文本（260 行）；也可以用 DSH_WHALE_PERSONA 指向自己的角色卡跑真样本。
  const samplePath = process.env.DSH_WHALE_PERSONA ?? '';
  const real =
    samplePath !== '' && existsSync(samplePath)
      ? readFileSync(samplePath, 'utf8')
      : Array.from({ length: 260 }, (_, i) => `第 ${i + 1} 行：这一行只是用来验证长文本往返不丢字。`).join(String.fromCharCode(10));
  writePersonaText(file, real);
  const round = readPersonaText(file);
  assert.equal(round.trimEnd(), real.trimEnd(), '大段角色卡往返后不能少一个字');
  assert.equal(round.split(String.fromCharCode(10)).length >= 200, true, '行数应该还是两百多行');
  console.log('角色卡样本字符数:', real.length, '| 行数:', real.split(String.fromCharCode(10)).length);

  // ── 9. 模拟「旧控制台把六层写空」：不再删掉角色卡，因为我们只走纯文本 ──
  writePersonaText(file, '');
  assert.equal(existsSync(file), false);
  writePersonaText(file, card);
  assert.equal(readPersonaText(file).trimEnd(), card, '清空后还能重新写回来');

  console.log('persona-raw: all assertions passed');
} finally {
  cleanup();
}

// ── 10. 旧前端（六层、没有全文）不许把角色卡删掉 ──
{
  const dir2 = join(process.cwd(), '.tmp-persona-legacy');
  mkdirSync(dir2, { recursive: true });
  const f2 = join(dir2, 'persona.md');
  try {
    writePersonaText(f2, '这是一整套角色卡，不能被旧界面冲掉');
    assert.equal(readPersonaText(f2).trimEnd(), '这是一整套角色卡，不能被旧界面冲掉');
    // 模拟：还没刷新的旧控制台发来六层对象（全空、无全文）
    writePersona(f2, { 名字: '', 她是谁: '', 性格: '', 说话方式: '', 愿景: '', 补充: '' });
    assert.equal(readPersonaText(f2).trimEnd(), '这是一整套角色卡，不能被旧界面冲掉', '旧格式提交不该删除角色卡');
    // 显式传全文空串才允许清空
    writePersona(f2, { 全文: '' });
    assert.equal(existsSync(f2), false, '显式清空才删文件');
    console.log('legacy-guard: 旧格式提交不会删角色卡');
  } finally {
    try { rmSync(dir2, { recursive: true, force: true }); } catch {}
  }
}
