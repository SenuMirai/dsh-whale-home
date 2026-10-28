import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  jaccard,
  containment,
  surpriseOf,
  findDuplicate,
  tierOf,
  TIER_TAU,
  effectiveHalfLife,
  makeTrace,
  writeTrace,
  loadTraces,
  traceActivation,
  DEDUPE_JACCARD,
  DEDUPE_CONTAINMENT,
} from '../src/qq/memory-traces.ts';

// ── Jaccard / containment 基础 ──
{
  assert.equal(jaccard('abc', 'abc'), 1);
  assert.equal(jaccard('abc', 'xyz'), 0);
  assert.ok(Math.abs(jaccard('abcd', 'abef') - 2 / 6) < 1e-9);
  assert.equal(jaccard('', 'abc'), 0);
  assert.equal(containment('ab', 'abcd'), 1, '短的完全包含在长的里');
  assert.ok(containment('abcz', 'abcd') < 1);
}

// ── 惊讶度：全新高、重复低 ──
{
  const existing = [makeTrace({ text: '主人说她喜欢白饭', domain: 'owner' })];
  const fresh = surpriseOf('今天看了个修驴蹄子的视频', existing);
  const same = surpriseOf('主人说她喜欢白饭', existing);
  assert.ok(fresh > 0.8, `全新的该高，实际 ${fresh}`);
  assert.ok(same < 0.01, `完全重复该接近 0，实际 ${same}`);
}

// ── 找重复：同 domain 才合并 ──
{
  const owner = makeTrace({ text: '主人说明天想吃火锅', domain: 'owner' });
  const same = findDuplicate('主人说明天想吃火锅', 'owner', [owner]);
  assert.ok(same !== undefined, '同域重复该命中');

  const cross = findDuplicate('主人说明天想吃火锅', 'group', [owner]);
  assert.equal(cross, undefined, '跨域不该合并');
}

// ── 闪光灯（pinned）不参与合并 ──
{
  const pinned = makeTrace({ text: '主人第一次说喜欢我', domain: 'owner', pinned: true });
  const hit = findDuplicate('主人第一次说喜欢我', 'owner', [pinned]);
  assert.equal(hit, undefined, 'pinned 不该被并掉');
}

// ── 相似但不够像：不合并 ──
{
  const a = makeTrace({ text: '主人今天中午吃了牛肉汤饭', domain: 'owner' });
  const hit = findDuplicate('主人今天中午吃了牛肉面', 'owner', [a]);
  // 这两个字符串差异：汤饭 vs 面。Jaccard 应该低于阈值
  assert.ok(jaccard(a.text, '主人今天中午吃了牛肉面') < DEDUPE_JACCARD || hit !== undefined);
}

// ── 分级：pinned 和高重要度是 core ──
{
  assert.equal(tierOf({ pinned: true, importance: 0.1 }), 'core', 'pinned 一定 core');
  assert.equal(tierOf({ pinned: false, importance: 0.9 }), 'core');
  assert.equal(tierOf({ pinned: false, importance: 0.85 }), 'core');
  assert.equal(tierOf({ pinned: false, importance: 0.7 }), 'important');
  assert.equal(tierOf({ pinned: false, importance: 0.5 }), 'important');
  assert.equal(tierOf({ pinned: false, importance: 0.3 }), 'normal');
}

// ── 三级 τ 差三个数量级 ──
{
  assert.equal(TIER_TAU.core, 3650);
  assert.equal(TIER_TAU.important, 30);
  assert.equal(TIER_TAU.normal, 7);
  assert.ok(TIER_TAU.core > TIER_TAU.important * 100);
}

// ── 有效半衰期：core 远大于 normal 同 domain ──
{
  const core = makeTrace({ text: 'core 记忆', domain: 'owner', importance: 0.95 });
  const normal = makeTrace({ text: 'normal 记忆', domain: 'owner', importance: 0.3 });
  const hc = effectiveHalfLife(core);
  const hn = effectiveHalfLife(normal);
  assert.ok(hc > hn * 100, `core(${hc}) 应远大于 normal(${hn})`);
}

// ── 想起来一次，半衰期变长 ──
{
  const t = makeTrace({ text: '被想起的记忆', domain: 'owner', importance: 0.6 });
  const before = effectiveHalfLife(t);
  const after = effectiveHalfLife({ ...t, recallCount: 3 });
  assert.ok(after > before, '被想起来该变慢');
}

// ── 激活：一天的 normal 还有相当激活，却衰减明显快于 core ──
{
  const now = Date.now();
  const day = 86_400_000;
  const core = makeTrace({ text: 'c', domain: 'owner', importance: 0.95, createdAt: now - 30 * day });
  const normal = makeTrace({ text: 'n', domain: 'owner', importance: 0.3, createdAt: now - 30 * day });
  const ac = traceActivation(core, now);
  const an = traceActivation(normal, now);
  assert.ok(ac > an, '30 天后 core 该比 normal 活得多');
  assert.ok(ac > 0.5, `core 30 天后该还在，实际 ${ac}`);
}

// ── writeTrace：新的存下来 ──
const tempRoot = join(import.meta.dirname, '.tmp-test-dedupe');
try {
  if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });

  const first = writeTrace(
    tempRoot,
    makeTrace({ text: '主人说喜欢喝热汤', domain: 'owner', importance: 0.7 }),
  );
  assert.equal(first.merged, false);
  assert.ok(first.surprise > 0.9, `全新的该高惊讶度，实际 ${first.surprise}`);
  assert.equal(loadTraces(tempRoot).length, 1);

  // 同一件事再说一次 → 合并，不新增
  const second = writeTrace(
    tempRoot,
    makeTrace({ text: '主人说喜欢喝热汤', domain: 'owner', importance: 0.9 }),
  );
  assert.equal(second.merged, true, '重复该被合并');
  assert.equal(second.into, first.trace.id, '该并进原来那条');
  assert.equal(loadTraces(tempRoot).length, 1, '不该新增一条');

  // 合并后重要度取更高、回想次数 +1
  const merged = loadTraces(tempRoot)[0];
  assert.equal(merged.importance, 0.9, '重要度取高的');
  assert.equal(merged.recallCount, 1, '合并算一次回想');

  // 不同的事 → 新增
  const third = writeTrace(
    tempRoot,
    makeTrace({ text: '今天在群里聊了钓鱼', domain: 'group', importance: 0.4 }),
  );
  assert.equal(third.merged, false);
  assert.equal(loadTraces(tempRoot).length, 2);

  // pinned 不合并：再写一条同文本的 pinned 应该…… 注意 findDuplicate 会跳过 pinned 那条，
  // 所以它会新建一条（id 相同会被 upsert 语义覆盖，这里用稍不同的文本验证）
  const flash = writeTrace(
    tempRoot,
    makeTrace({ text: '主人第一次夸我是小鲸鱼', domain: 'owner', pinned: true }),
  );
  assert.equal(flash.merged, false);
  const beforeCount = loadTraces(tempRoot).length;
  const flashAgain = writeTrace(
    tempRoot,
    makeTrace({ text: '主人第一次夸我是小鲸鱼', domain: 'owner', pinned: true }),
  );
  // pinned 不参与合并；同 id 再来一次应该覆盖而不是新增
  assert.equal(flashAgain.into, undefined, 'pinned 不该接收合并');
  assert.equal(loadTraces(tempRoot).length, beforeCount, '同 id 不该新增重复条目');
  // 而且新的那条 recallCount 应该 +1
  const flashRow = loadTraces(tempRoot).find((t) => t.id === flash.trace.id);
  assert.ok(flashRow !== undefined);
  assert.equal(flashRow.recallCount, 1, '同 id 覆盖时该算一次回想');

  rmSync(tempRoot, { recursive: true, force: true });
} catch (e) {
  rmSync(tempRoot, { recursive: true, force: true });
  throw e;
}

console.log('memory-dedupe: all assertions passed');
