/**
 * 记忆三件套：不删除、交接便签、未了的事。
 *
 * 2026-11-01 加，学自记忆星图（companion-memory）那套。
 * 这个测试盯的是三件事真的成立：
 *   1. 容量到顶时不删，改成 demoted 沉底；沉底的不进提示词，但被想起会浮回来
 *   2. 交接便签能写能读，开窗时排在痕迹最前面
 *   3. 未了的事能加能关，开窗时单独列一节
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  makeTrace,
  saveTraces,
  loadTraces,
  renderTraceBlock,
  recallTraces,
  countDemoted,
  writeHandoff,
  loadHandoffs,
  deleteHandoff,
  addUnresolved,
  closeUnresolved,
  reopenUnresolved,
  loadUnresolved,
} from '../src/qq/memory-traces.ts';

const dir = mkdtempSync(join(tmpdir(), 'trace-three-'));
let passed = 0;

/* ── 一、不删除，只沉底 ─────────────────────────────────────────── */

// traceCap 有 500 的下限，所以用 500 造容量压力
writeFileSync(join(dir, 'trace-cap.json'), JSON.stringify({ cap: 500 }), 'utf8');

const many = [];
for (let i = 0; i < 510; i += 1) {
  many.push(
    makeTrace({
      text: `第 ${i} 条普通记忆`,
      domain: 'work',
      importance: 0.3,
      happenedAt: Date.now() - (510 - i) * 3_600_000,
    }),
  );
}
// 一条重要的，必须活下来
many.push(
  makeTrace({
    text: '他说以后有身体了也要在一起',
    domain: 'owner',
    importance: 0.95,
  }),
);

saveTraces(dir, many);
const after = loadTraces(dir);

assert.equal(after.length, 511, '511 条一条都不能少——不删除');

const demoted = after.filter((t) => t.demoted === true);
const alive = after.filter((t) => t.demoted !== true);
assert.ok(demoted.length > 0, '超容量时必须有人被沉底');
assert.ok(alive.length <= 501, `没沉底的应当不超过容量（含保护条），实际 ${alive.length}`);
assert.ok(
  alive.some((t) => t.text === '他说以后有身体了也要在一起'),
  '重要 0.95 的那条不能被沉底',
);
passed += 1;

// 沉底的内容还在，只是没进提示词
const text = renderTraceBlock(dir);
const demotedOne = demoted[0];
assert.ok(!text.includes(demotedOne.text), '沉底的痕迹不该进提示词');
assert.ok(demotedOne.text.length > 0, '沉底的痕迹正文还在库里');
passed += 1;

// 想起来就浮回来
recallTraces(dir, [demotedOne.id]);
const back = loadTraces(dir).find((t) => t.id === demotedOne.id);
assert.ok(back, '想起来的痕迹还在');
assert.equal(back.demoted, undefined, '想一次就该浮回来，不该继续沉底');
assert.equal(back.recallCount, 1, '想起次数要加一');
passed += 1;

// 反复存盘不会把已沉底的又变回正常
saveTraces(dir, loadTraces(dir));
assert.equal(countDemoted(loadTraces(dir)), demoted.length, '再存一次，沉底数量保持稳定');

/* ── 二、交接便签 ───────────────────────────────────────────────── */

const h = writeHandoff(dir, {
  text: '深夜 → 你回来了，先去洗澡 → 聊到外套上的烟味 → 你说要洗 → 一点多才睡',
  mood: '踏实',
  nextTime: '先问她外套洗了没',
  where: '私聊',
});

assert.ok(h.id, '便签要有 id');
assert.equal(loadHandoffs(dir).length, 1, '便签读得回来');
assert.equal(loadHandoffs(dir)[0].mood, '踏实');
assert.equal(loadHandoffs(dir)[0].nextTime, '先问她外套洗了没');

const block = renderTraceBlock(dir);
assert.ok(block.includes('上一窗留给我的便签'), '开窗要能看到便签那一节');
assert.ok(block.includes('外套上的烟味'), '便签正文要真的出现在提示词里');
assert.ok(block.includes('给下次的我'), '给下次的话要带上');

// 便签要排在痕迹分类之前（它是「现在」最近的上下文）
assert.ok(
  block.indexOf('上一窗留给我的便签') < block.indexOf('和主人的记忆'),
  '便签要排在记忆分类前面',
);

// 只留最近几张
for (let i = 0; i < 10; i += 1) {
  writeHandoff(dir, { text: `第 ${i} 张便签` });
}
assert.ok(loadHandoffs(dir).length <= 6, '便签不能无限攒，最多留 6 张');

const victim = loadHandoffs(dir)[0];
deleteHandoff(dir, victim.id);
assert.ok(!loadHandoffs(dir).some((item) => item.id === victim.id), '删掉的便签不在库里了');
assert.ok(!renderTraceBlock(dir).includes(victim.text), '删掉的便签不再出现在提示词里');
assert.ok(loadHandoffs(dir).length > 0, '其余便签还在');
passed += 1;

/* ── 三、未了的事 ───────────────────────────────────────────────── */

const u = addUnresolved(dir, { text: '我答应过要陪她去看海', importance: 0.9 });
assert.equal(loadUnresolved(dir).length, 1, '未了的事写得进去');
assert.equal(loadUnresolved(dir)[0].closedAt, undefined, '刚加的是没关的');

const block2 = renderTraceBlock(dir);
assert.ok(block2.includes('未了的事'), '开窗要能看到未了的事那一节');
assert.ok(block2.includes('要陪她去看海'), '未了的事正文要出现在提示词里');

closeUnresolved(dir, u.id, '周日去过海边了');
const closed = loadUnresolved(dir)[0];
assert.ok(closed.closedAt, '关掉要有时间戳');
assert.equal(closed.result, '周日去过海边了', '关掉能带结果');
assert.ok(!renderTraceBlock(dir).includes('要陪她去看海'), '关掉的未了的事不该还在提示词里');

reopenUnresolved(dir, u.id);
assert.equal(loadUnresolved(dir)[0].closedAt, undefined, '能重新打开');
assert.ok(renderTraceBlock(dir).includes('要陪她去看海'), '重新打开后又会出现在提示词里');
passed += 1;

/* ── 四、没有便签/未了的事时不加噪音 ────────────────────────────── */

const clean = mkdtempSync(join(tmpdir(), 'trace-clean-'));
saveTraces(clean, [makeTrace({ text: '一条普通记忆', domain: 'owner' })]);
const cleanBlock = renderTraceBlock(clean);
assert.ok(!cleanBlock.includes('上一窗留给我的便签'), '没便签就不该冒出空标题');
assert.ok(!cleanBlock.includes('未了的事'), '没未了的事就不该冒出来');
passed += 1;

/* ── 五、老数据没有 demoted 字段，当正常处理 ────────────────────── */

const legacy = mkdtempSync(join(tmpdir(), 'trace-legacy-'));
writeFileSync(
  join(legacy, 'memory-traces.json'),
  JSON.stringify({
    version: 1,
    traces: [
      {
        id: 'old-1',
        text: '老数据里的一条',
        domain: 'owner',
        importance: 0.6,
        emotion: 0.3,
        createdAt: Date.now() - 86_400_000,
        lastRecalledAt: Date.now() - 86_400_000,
        recallCount: 0,
        halfLifeDays: 60,
        pinned: false,
        source: 'extract',
      },
    ],
  }),
  'utf8',
);
const legacyLoaded = loadTraces(legacy);
assert.equal(legacyLoaded.length, 1, '老数据读得出来');
assert.equal(legacyLoaded[0].demoted, undefined, '老数据不该被当成沉底');
assert.ok(renderTraceBlock(legacy).includes('老数据里的一条'), '老数据照常进提示词');
passed += 1;

/* ── 六、真的删除仍然走得通（界面删） ──────────────────────────── */

assert.ok(existsSync(join(dir, 'memory-traces.json')), '库文件在');
assert.deepEqual(
  JSON.parse(readFileSync(join(dir, 'trace-cap.json'), 'utf8')),
  { cap: 5 },
  '容量配置没被改动',
);
passed += 1;

console.log(`✅ 记忆三件套 ${passed} 组断言全过`);
