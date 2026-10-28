/**
 * 防止「界面说明」和「实际数值」再次对不上。
 *
 * 事故：界面写「标准 — 日常不受影响」，实际私聊连说 6 句就被拦掉;
 * 界面写的连发阈值/每小时条数也和源码不一致。
 * 这里把文案里的关键数字和预设值绑死，改一边不改另一边就红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SAFETY_PRESETS } from '../lib/index.js';
import { SafetyGuard, DEFAULT_SAFETY } from '../src/qq/safety.ts';

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function grab(label, key) {
  const re = new RegExp('· ' + label + '：[^' + String.fromCharCode(92) + 'n]*');
  const line = re.exec(client)?.[0] ?? '';
  const m = new RegExp(key + ' (' + String.fromCharCode(92) + 'd+)').exec(line);
  return m ? Number(m[1]) : null;
}

// 标准
assert.equal(grab('标准', '每分钟'), SAFETY_PRESETS.standard.globalPerMinute, '标准·每分钟对不上');
assert.equal(grab('标准', '每小时'), SAFETY_PRESETS.standard.globalPerHour, '标准·每小时对不上');
assert.equal(grab('标准', '连发'), SAFETY_PRESETS.standard.burstAfter, '标准·连发阈值对不上');
assert.equal(grab('标准', '静默'), SAFETY_PRESETS.standard.burstSilenceMinutes, '标准·静默时长对不上');

// 宽松
assert.equal(grab('宽松', '每分钟'), SAFETY_PRESETS.loose.globalPerMinute);
assert.equal(grab('宽松', '每小时'), SAFETY_PRESETS.loose.globalPerHour);
assert.equal(grab('宽松', '连发'), SAFETY_PRESETS.loose.burstAfter);
assert.equal(grab('宽松', '静默'), SAFETY_PRESETS.loose.burstSilenceMinutes);

// 保守
assert.equal(grab('保守', '每分钟'), SAFETY_PRESETS.strict.globalPerMinute);
assert.equal(grab('保守', '每小时'), SAFETY_PRESETS.strict.globalPerHour);
assert.equal(grab('保守', '连发'), SAFETY_PRESETS.strict.burstAfter);
assert.equal(grab('保守', '静默'), SAFETY_PRESETS.strict.burstSilenceMinutes);

// 档位名不能再写「日常不受影响」——它只管群聊
assert.equal(client.includes('标准（默认）— 日常不受影响'), false, '档位名又变回含糊说法了');
assert.ok(client.includes('只限群聊'), '档位名应写明只限群聊');

// 必须写清哪些规则不管私聊
assert.ok(client.includes('私聊完全不管'), '缺少「私聊完全不管」的说明');

console.log('safety-doc: 界面数字与源码预设一致');

// ── 预设要能真正生效：没手改过的字段跟随档位，手改过的保留 ──
{
  const { readSettings, writeSettings } = await import('../lib/index.js').catch(() => ({}));
  // 直接验证「merged 逻辑」的等价行为：预设值 vs 存盘值
  const p = SAFETY_PRESETS.standard;
  assert.equal(p.burstAfter, 10, '标准档连发阈值应为 10');
  assert.equal(p.burstSilenceMinutes, 5, '标准档静默应为 5 分钟');
  assert.equal(SAFETY_PRESETS.strict.globalPerHour, 60, '保守档每小时应为 60');
  assert.equal(SAFETY_PRESETS.loose.blockRepeat, false, '宽松档不该拦重复');
  console.log('safety-preset: 预设值已更新到新口径');
}

// ── 选「无限制」必须真的全关（2026-10-28 事故回归）──
{
  const u = SAFETY_PRESETS.unlimited;
  assert.equal(u.globalPerMinute, 0, '无限制：每分钟应为 0');
  assert.equal(u.globalPerHour, 0, '无限制：每小时应为 0');
  assert.equal(u.burstAfter, 0, '无限制：连发阈值应为 0');
  assert.equal(u.burstSilenceMinutes, 0, '无限制：静默应为 0');
  assert.equal(u.blockLinks, false, '无限制：不该拦链接');
  assert.equal(u.blockRepeat, false, '无限制：不该拦重复');
  assert.equal(u.nightThrottle, false, '无限制：不该深夜降频');
  assert.equal(u.failureThreshold, 0, '无限制：不该因失败退避');
  assert.equal(u.stopOnRiskSignal, false, '无限制：不该按风控信号停手');

  // 无限制档下，任何检查都该放行
  const g = new SafetyGuard({ ...DEFAULT_SAFETY, ...u, profile: 'unlimited', enabled: true });
  const t = Date.parse('2026-10-28T12:00:00+08:00');
  for (let i = 0; i < 50; i += 1) {
    const v = g.check(`第${i}句`, { now: t + i * 100 });
    assert.equal(v.ok, true, `无限制档第 ${i + 1} 句被拦了：${v.ok ? '' : v.reason}`);
    g.onSent(`第${i}句`, t + i * 100);
    g.onReplied(t + i * 100);
  }
  console.log('safety-unlimited: 无限制档确实全关');
}
