/**
 * 今天翻出来的旧事。
 *
 * 2026-11-01 加。盯三件事：
 *   1. 只从中段抽（0.15~0.6），顶上的和淡掉的都不碰
 *   2. 同一天抽出来的是同一批；换天换一批
 *   3. 日界在凌晨 4 点 —— 跨零点不换批，凌晨 4 点才换
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  makeTrace,
  saveTraces,
  loadTraces,
  renderTraceBlock,
  pickDailyOldOnes,
  dayKey,
  traceActivation,
  OLD_ONE_MIN,
  OLD_ONE_MAX,
} from '../src/qq/memory-traces.ts';

const dir = mkdtempSync(join(tmpdir(), 'oldones-'));
let passed = 0;

/* ── 造一批分布在不同档位的记忆 ── */

const now = Date.parse('2026-11-01T15:00:00+08:00');
const DAY = 86_400_000;

// 顶上的：重要 1.0、情绪 1.0、想起很多次 → 激活值接近 1
const top = [];
for (let i = 0; i < 5; i += 1) {
  top.push(
    makeTrace({
      text: `顶上的第 ${i} 条`,
      domain: 'owner',
      importance: 1.0,
      emotion: 1.0,
      happenedAt: now - i * DAY,
    }),
  );
}

// 中段的：重要 0.55、情绪 0.5、几天前 → 落在 0.15~0.6
const middle = [];
for (let i = 0; i < 30; i += 1) {
  middle.push(
    makeTrace({
      text: `中段第 ${i} 条`,
      domain: 'owner',
      importance: 0.55,
      emotion: 0.5,
      happenedAt: now - (2 + i) * DAY,
    }),
  );
}

// 淡掉的：重要 0.2、一年前
const faded = [];
for (let i = 0; i < 5; i += 1) {
  faded.push(
    makeTrace({
      text: `淡掉的第 ${i} 条`,
      domain: 'owner',
      importance: 0.2,
      emotion: 0.2,
      happenedAt: now - 400 * DAY,
    }),
  );
}

const all = [...top, ...middle, ...faded];
saveTraces(dir, all);
const loaded = loadTraces(dir);

/* ── 一、只从中段抽 ── */

const picked = pickDailyOldOnes(loaded, now);
assert.equal(picked.length, 5, '默认抽 5 条');
for (const trace of picked) {
  const activation = traceActivation(trace, now);
  assert.ok(
    activation >= OLD_ONE_MIN && activation < OLD_ONE_MAX,
    `抽到的必须在中段：${trace.text} 激活 ${activation.toFixed(3)}`,
  );
  assert.ok(trace.text.startsWith('中段'), `不该抽到顶上的或淡掉的：${trace.text}`);
}
passed += 1;

/* ── 二、同一天稳定 ── */

const a = pickDailyOldOnes(loaded, now).map((t) => t.id);
const b = pickDailyOldOnes(loaded, now + 3600_000).map((t) => t.id); // 一小时后
assert.deepEqual(a, b, '同一天内换时间点，抽出来的是同一批');
passed += 1;

/* ── 三、换天换一批 ── */

const tomorrow = now + DAY;
const c = pickDailyOldOnes(loaded, tomorrow).map((t) => t.id);
assert.notDeepEqual(a, c, '换一天应该换一批');
const overlap = a.filter((id) => c.includes(id)).length;
assert.ok(overlap < 5, `换天后不该完全重合，实际重合 ${overlap}/5`);
passed += 1;

/* ── 四、日界在凌晨 4 点 ── */

// 11-01 23:59 和 11-02 02:00 应该算同一天（都归属 11-01）
const lateNight = Date.parse('2026-11-01T23:59:00+08:00');
const afterMidnight = Date.parse('2026-11-02T02:00:00+08:00');
const morning = Date.parse('2026-11-02T05:00:00+08:00');

assert.equal(dayKey(lateNight), dayKey(afterMidnight), '跨零点不换天（23:59 和 02:00 同一天）');
assert.notEqual(dayKey(afterMidnight), dayKey(morning), '凌晨 4 点之后算新的一天');

const idsLate = pickDailyOldOnes(loaded, lateNight).map((t) => t.id);
const idsAfterMidnight = pickDailyOldOnes(loaded, afterMidnight).map((t) => t.id);
const idsMorning = pickDailyOldOnes(loaded, morning).map((t) => t.id);
assert.deepEqual(idsLate, idsAfterMidnight, '深夜聊过零点，上面那几条不该换');
assert.notDeepEqual(idsAfterMidnight, idsMorning, '过了凌晨 4 点才换批');
passed += 1;

/* ── 五、排除已经出现过的 ── */

const firstIds = pickDailyOldOnes(loaded, now).map((t) => t.id);
const second = pickDailyOldOnes(loaded, now, { exclude: firstIds });
assert.equal(second.length, 5, '排除后还能抽满');
for (const trace of second) {
  assert.ok(!firstIds.includes(trace.id), '不该重复抽到已经出现的');
}
passed += 1;

/* ── 六、中段不够时不会硬凑 ── */

const few = mkdtempSync(join(tmpdir(), 'oldones-few-'));
saveTraces(few, top.slice(0, 3));
assert.equal(pickDailyOldOnes(loadTraces(few), now).length, 0, '中段一条都没有时返回空，不拿顶上的凑数');
passed += 1;

/* ── 七、真的进了提示词，而且有自己的标题 ── */

const block = renderTraceBlock(dir, now);
assert.ok(block.includes('今天翻出来的旧事'), '记忆块里要有这一节');
assert.ok(block.includes('不是刚发生的'), '要写清这些不是刚发生的事');
assert.ok(block.includes('想起以前'), '要给她一个说出口的口气');
const section = block.slice(block.indexOf('### 今天翻出来的旧事'));
const pickedInBlock = pickDailyOldOnes(loadTraces(dir), now);
for (const trace of pickedInBlock) {
  assert.ok(section.includes(trace.text.slice(0, 20)), `抽到的要真的出现在那一节里：${trace.text}`);
}
passed += 1;

/* ── 八、原有排序和条数不被影响 ── */

const blockWithoutOld = renderTraceBlock(dir, now).split('### 今天翻出来的旧事')[0];
assert.ok(blockWithoutOld.includes('### 和主人的记忆'), '原有分节还在');
assert.ok(blockWithoutOld.includes('### 群里发生的事'), '群聊那一节还在');
passed += 1;

console.log(`✅ 今天翻出来的旧事 ${passed} 组断言全过`);
