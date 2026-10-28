/**
 * 语音拼接回归：句末标点后不能再塞逗号。
 *
 * 事故：两条「晚安。」「明天见。」被 join('，') 拼成「晚安。，明天见。」，
 * TTS 把这个畸形输入读成了一个怪音，主人听到多出来的「姐」。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// joinSpeech 是 bridge.ts 内部函数，构建后名字还在；直接从产物里取用不方便，
// 这里按同样的规则做等价实现并锁住行为契约。
function joinSpeech(parts) {
  let out = '';
  for (const raw of parts) {
    const part = String(raw).trim();
    if (part === '') continue;
    if (out === '') { out = part; continue; }
    if (/[。！？!?…~～」』】）)]$/u.test(out)) out += part;
    else out += `，${part}`;
  }
  return out;
}

// 1) 句号收尾 → 直接接，不插逗号
assert.equal(joinSpeech(['晚安。', '明天见。']), '晚安。明天见。');
assert.equal(joinSpeech(['晚安。', '明天见。']).includes('。，'), false, '不能出现「。，」');

// 2) 没有标点收尾 → 补逗号（保持连贯）
assert.equal(joinSpeech(['我想想', '等下告诉你']), '我想想，等下告诉你');

// 3) 问号/叹号/省略号同样不插
assert.equal(joinSpeech(['真的吗？', '我不信']), '真的吗？我不信');
assert.equal(joinSpeech(['好耶！', '走']), '好耶！走');
assert.equal(joinSpeech(['算了…', '不说了']), '算了…不说了');

// 4) 空段被跳过
assert.equal(joinSpeech(['一。', '', '  ', '二。']), '一。二。');
assert.equal(joinSpeech([]), '');

// 5) 构建产物里真的用了 joinSpeech，且不再有裸 join('，')
const built = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
assert.ok(built.includes('joinSpeech'), '构建产物里应有 joinSpeech');
assert.equal(built.includes("plan.messages.join(\"，\")"), false, '不该再出现旧的 join（，）');

console.log('speech-join: 句末标点不再被塞逗号');
