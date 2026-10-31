import assert from 'node:assert/strict';
import {
  SafetyGuard,
  DEFAULT_SAFETY,
  SAFETY_PRESETS,
  ECONOMY_FACTORS,
  classifyFailure,
  isRetryable,
  looksLikeLink,
  isOffPeak,
} from '../src/qq/safety.ts';

const MIN = 60_000;

const make = (patch = {}) => ({ ...DEFAULT_SAFETY, ...patch });
const at = (h, m = 0) => new Date(2026, 9, 28, h, m, 0, 0).getTime();

// ── 档位预设完整性 ──
{
  for (const id of ['unlimited', 'loose', 'standard', 'strict']) {
    const p = SAFETY_PRESETS[id];
    assert.ok(p, `档位 ${id} 缺失`);
    assert.equal(typeof p.globalPerMinute, 'number');
  }
  // 越保守，配额越小
  assert.ok(SAFETY_PRESETS.strict.globalPerMinute < SAFETY_PRESETS.loose.globalPerMinute);
  assert.ok(SAFETY_PRESETS.strict.globalPerHour < SAFETY_PRESETS.standard.globalPerHour);
  // 无限制档全关
  assert.equal(SAFETY_PRESETS.unlimited.globalPerMinute, 0);
  assert.equal(SAFETY_PRESETS.unlimited.stopOnRiskSignal, false);
}

// ── 无限制档：什么都不拦 ──
{
  const g = new SafetyGuard(make({ profile: 'unlimited' }));
  for (let i = 0; i < 50; i += 1) {
    const v = g.check('随便说点什么', { now: at(12) });
    assert.equal(v.ok, true, '无限制档不该拦');
  }
}

// ── 每分钟上限 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', globalPerMinute: 3, globalPerHour: 0 }));
  const t = at(12);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(g.check(`第${i}句`, { now: t + i }).ok, true);
    g.onSent(`第${i}句`, t + i);
  }
  const blocked = g.check('再来一句', { now: t + 3000 });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.rule, 'rate-minute');
    assert.ok(blocked.until > t + 3000, '应给出解禁时间');
    assert.ok(blocked.reason.length > 0, '应有人话理由');
  }
  // 过了这一分钟就放行
  assert.equal(g.check('新的一句', { now: t + MIN + 1 }).ok, true);
}

// ── 每小时上限 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', globalPerMinute: 0, globalPerHour: 2 }));
  const t = at(12);
  g.onSent('甲', t);
  g.onSent('乙', t + 10_000);
  const v = g.check('丙', { now: t + 20_000 });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.rule, 'rate-hour');
}

// ── 私聊豁免：静默期里私聊仍能说话 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', privateExempt: true, failureThreshold: 1, silenceMinutes: 10 }));
  const t = at(12);
  g.onFailed('risk', t);
  assert.equal(g.check('群里的', { now: t + 1000 }).ok, false, '群聊该被拦住');
  assert.equal(g.check('私聊的', { now: t + 1000, isPrivate: true }).ok, true, '私聊该放行');
}

// ── 关掉私聊豁免后，私聊也停 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', privateExempt: false, failureThreshold: 1, silenceMinutes: 10 }));
  const t = at(12);
  g.onFailed('risk', t);
  assert.equal(g.check('私聊的', { now: t + 1000, isPrivate: true }).ok, false);
}

// ── 风控信号：立刻停手 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', stopOnRiskSignal: true, silenceMinutes: 10 }));
  const t = at(12);
  const r = g.onFailed('risk', t);
  assert.equal(r.stop, true, '风控该停手');
  assert.ok(String(r.reason).includes('风控') || String(r.reason).includes('拦'), '理由要能看懂');
  assert.equal(g.check('再说一句', { now: t + 1000 }).ok, false);
}

// ── 禁言同理 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', stopOnRiskSignal: true }));
  assert.equal(g.onFailed('mute', at(12)).stop, true);
}

// ── 网络失败：要连续几次才退避 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', failureThreshold: 2, silenceMinutes: 5 }));
  const t = at(12);
  assert.equal(g.onFailed('network', t).stop, false, '第一次不该停');
  assert.equal(g.onFailed('network', t + 1000).stop, true, '第二次该停');
}

// ── 成功会清掉失败计数 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', failureThreshold: 2 }));
  const t = at(12);
  g.onFailed('network', t);
  g.onSent('好', t + 1000);
  assert.equal(g.onFailed('network', t + 2000).stop, false, '成功过就该重新数');
}

// ── 重复内容拦截 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', blockRepeat: true, repeatWindowMinutes: 10, globalPerMinute: 0, globalPerHour: 0 }));
  const t = at(12);
  // 说两遍是正常强调，不该拦（阈值 3）
  g.onSent('今天白饭真香', t);
  g.onSent('今天白饭真香', t + 1000);
  assert.equal(g.check('今天白饭真香', { now: t + 1500 }).ok, true, '第二次说同一句不该拦');
  // 第三遍才算复读
  g.onSent('今天白饭真香', t + 2000);
  const v = g.check('今天白饭真香', { now: t + 2500 });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.rule, 'repeat');
  // 不同的内容能过
  assert.equal(g.check('换一句别的', { now: t + 3000 }).ok, true);
}

// ── 链接拦截 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', blockLinks: true, globalPerMinute: 0, globalPerHour: 0 }));
  assert.equal(g.check('看这个 https://example.com', { now: at(12) }).ok, false);
  assert.equal(g.check('看这个 no link here', { now: at(12) }).ok, true);
}

// ── 深夜降频 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', nightThrottle: true, nightStart: 1, nightEnd: 7, globalPerMinute: 8, globalPerHour: 0 }));
  const night = at(3);
  // 深夜上限是 ceil(8/2)=4
  for (let i = 0; i < 4; i += 1) g.onSent(`夜${i}`, night + i * 100);
  const v = g.check('夜里再说一句', { now: night + 500 });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.rule, 'night');
}

// ── 连发静默 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', burstAfter: 3, burstSilenceMinutes: 5, globalPerMinute: 0, globalPerHour: 0 }));
  const t = at(12);
  // 连发按「回复轮数」计：onReplied 才是计数点
  for (let i = 0; i < 3; i += 1) { g.onSent(`第${i}句`, t + i * 1000); g.onReplied(t + i * 1000); }
  const v = g.check('第4句', { now: t + 4000 });
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.rule, 'burst');
}

// ── 拟人化延迟：在范围内 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', jitterMinMs: 1000, jitterMaxMs: 2000, typingPerCharMs: 10 }));
  const v = g.check('四个字呀', { now: at(12) });
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.ok(v.delayMs >= 1000 + 4 * 10 - 1, `延迟太小：${v.delayMs}`);
    assert.ok(v.delayMs <= 2000 + 4 * 10 + 1, `延迟太大：${v.delayMs}`);
  }
}

// ── 延迟是随机的，不是固定值 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', jitterMinMs: 1000, jitterMaxMs: 3000, typingPerCharMs: 0, globalPerMinute: 0, globalPerHour: 0 }));
  const values = new Set();
  for (let i = 0; i < 20; i += 1) {
    const v = g.check(`抖动${i}`, { now: at(12) });
    if (v.ok) values.add(v.delayMs);
  }
  assert.ok(values.size > 5, '延迟应该有抖动，不能是固定值');
}

// ── 经济档位按谷峰缩放配额 ──
{
  // 谷时：0-8 点
  assert.equal(isOffPeak(at(3), 0, 8), true);
  assert.equal(isOffPeak(at(15), 0, 8), false);

  const off = new SafetyGuard(make({ profile: 'standard', economy: 'frugal', globalPerMinute: 10, globalPerHour: 0, offPeakStart: 0, offPeakEnd: 8 }));
  // 峰时：10 * 0.35 = 3.5 → 4
  for (let i = 0; i < 4; i += 1) off.onSent(`峰${i}`, at(15, 0) + i);
  assert.equal(off.check('峰时再一句', { now: at(15, 0) + 10 }).ok, false, '峰时应该更早被拦');

  const offPeakGuard = new SafetyGuard(make({ profile: 'standard', economy: 'frugal', globalPerMinute: 10, globalPerHour: 0, offPeakStart: 0, offPeakEnd: 8 }));
  // 谷时：10 * 1.5 = 15
  for (let i = 0; i < 4; i += 1) offPeakGuard.onSent(`谷${i}`, at(3, 0) + i);
  assert.equal(offPeakGuard.check('谷时再一句', { now: at(3, 0) + 10 }).ok, true, '谷时应该更宽松');
}

// ── 统计 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', globalPerMinute: 1, globalPerHour: 0 }));
  const t = at(12);
  g.onSent('一', t);
  g.check('二', { now: t + 100 });
  const s = g.stats(t + 200);
  assert.equal(s.sentLastMinute, 1);
  assert.equal(s.profile, 'standard');
  assert.ok(s.blocksToday.length > 0, '拦截该被记下来');
  assert.ok(s.lastBlock !== null);
}

// ── 重置 ──
{
  const g = new SafetyGuard(make({ profile: 'standard', failureThreshold: 1, silenceMinutes: 30 }));
  const t = at(12);
  g.onFailed('risk', t);
  assert.equal(g.check('被拦的', { now: t + 1000 }).ok, false);
  g.reset();
  assert.equal(g.check('reset 后', { now: t + 2000 }).ok, true, 'reset 后应该能说话');
}

// ── 失败分类 ──
{
  assert.equal(classifyFailure('操作太频繁，请稍后再试'), 'risk');
  assert.equal(classifyFailure('你已被禁言'), 'mute');
  assert.equal(classifyFailure('request timeout'), 'network');
  assert.equal(classifyFailure('上传失败'), 'upload');
  assert.equal(classifyFailure('some random error'), 'unknown');
  assert.equal(classifyFailure('', 1200), 'risk');

  assert.equal(isRetryable('network'), true);
  assert.equal(isRetryable('upload'), true);
  assert.equal(isRetryable('risk'), false, '风控绝不能重试');
  assert.equal(isRetryable('mute'), false);
  assert.equal(isRetryable('unknown'), false, '不确定就别重试');
}

// ── 链接识别 ──
{
  assert.equal(looksLikeLink('https://a.com'), true);
  assert.equal(looksLikeLink('看 baidu.com 这个'), true);
  assert.equal(looksLikeLink('就是一句话'), false);
  assert.equal(looksLikeLink('3.14'), false);
}

console.log('safety: all assertions passed');

// ── 私聊不受「每分钟」和「连发」限制（2026-10-28 事故回归）──
{
  const g = new SafetyGuard(make({ profile: 'standard', globalPerMinute: 3, globalPerHour: 0, burstAfter: 3, burstSilenceMinutes: 8 }));
  const t = at(12);
  // 私聊里连着说 6 句：以前第 4 句就被 burst 拦，主人只看到半截
  for (let i = 0; i < 6; i += 1) {
    const v = g.check(`第${i}句`, { now: t + i * 1000, isPrivate: true });
    assert.equal(v.ok, true, `私聊第 ${i + 1} 句不该被拦：${v.ok ? '' : v.reason}`);
    g.onSent(`第${i}句`, t + i * 1000);
  }
  // 但群聊仍然有闸
  const gp = new SafetyGuard(make({ profile: 'standard', globalPerMinute: 3, globalPerHour: 0, burstAfter: 3, burstSilenceMinutes: 8 }));
  for (let i = 0; i < 3; i += 1) { gp.check(`群${i}`, { now: t + i }); gp.onSent(`群${i}`, t + i); }
  const blocked = gp.check('群里再来', { now: t + 100 });
  assert.equal(blocked.ok, false, '群聊该有的闸不能一起废掉');
}

// ── 私聊有自己的每小时兜底，但不吃群聊的额度 ──
//
// 2026-10-30 事故：群里热闹时 150 条/小时的额度被群聊吃光，
// 主人一对一说话也一起被拦——他那边只有自己说的话。
// 现在两本账：群聊吃 q.perHour，私聊吃 max(120, q.perHour*4)。
{
  const g = new SafetyGuard(make({ profile: 'standard', globalPerMinute: 0, globalPerHour: 2, burstAfter: 0 }));
  const t = at(12);
  // 群聊把这小时的额度吃满
  g.onSent('甲', t);
  g.onSent('乙', t + 1000);
  const groupBlocked = g.check('群里再来', { now: t + 1500 });
  assert.equal(groupBlocked.ok, false, '群聊的每小时闸照旧');
  // 私聊不受影响，照样能说
  const privateOk = g.check('私聊丙', { now: t + 2000, isPrivate: true });
  assert.equal(privateOk.ok, true, '私聊不该被群聊吃掉的额度拦住');

  // 但私聊自己也有兜底：攒到 120 条就该缓一缓
  const g2 = new SafetyGuard(make({ profile: 'standard', globalPerMinute: 0, globalPerHour: 2, burstAfter: 0 }));
  for (let i = 0; i < 120; i += 1) g2.onSent(`私${i}`, t, true);
  const v = g2.check('私聊再来', { now: t + 1000, isPrivate: true });
  assert.equal(v.ok, false, '私聊自己的每小时兜底仍生效（防失控）');
  if (!v.ok) assert.equal(v.rule, 'rate-hour');
}

console.log('safety-private: 私聊不再被连发/分钟闸误伤');

// ── 连发按「回复轮数」算，不按气泡数（2026-10-28 事故回归）──
{
  const g = new SafetyGuard(make({ profile: 'standard', burstAfter: 10, burstSilenceMinutes: 5, globalPerMinute: 0, globalPerHour: 0 }));
  const t = at(12);
  // 一次回复拆 5 个气泡：只该记 1 次连发
  for (let seg = 0; seg < 5; seg += 1) g.onSent(`气泡${seg}`, t + seg * 200);
  g.onReplied(t + 1000);
  assert.equal(g.check('接下来一句', { now: t + 2000 }).ok, true, '一条回复拆多段不该算连发');

  // 连回 10 轮才该静默
  let blockedAt = 0;
  for (let i = 1; i <= 12; i += 1) {
    const now = t + i * 3000;
    const v = g.check(`第${i}轮`, { now });
    if (!v.ok) { blockedAt = i; break; }
    g.onSent(`第${i}轮`, now);
    g.onReplied(now);
  }
  assert.ok(blockedAt >= 10, `应到第 10 轮左右才拦，实际第 ${blockedAt} 轮`);
}

console.log('safety-burst: 连发按回复轮数计，不按气泡');
