/**
 * 记忆痕迹的「谁说的」和「什么时候」。
 *
 * 事故：群聊痕迹 27% 泛化成「群友说…」，且注入提示词时完全没有时间。
 * 根因是提取时把昵称抹成了「群友」，且 MemoryTrace 没有 people / happenedAt 字段。
 */
import assert from 'node:assert/strict';
import { makeTrace, renderTraceBlock } from '../src/qq/memory-traces.ts';

// 1) people 存得进去、去重、截断
const t = makeTrace({
  text: 'C呆说自己把9600X换成9800X3D了',
  people: ['C呆', 'C呆', '析木', ''],
  happenedAt: Date.parse('2026-10-27T14:36:00+08:00'),
  domain: 'group',
});
assert.deepEqual(t.people, ['C呆', '析木'], 'people 去重并去掉空串');
assert.equal(t.happenedAt, Date.parse('2026-10-27T14:36:00+08:00'), 'happenedAt 原样保留');

// 2) 没给 happenedAt 时不要瞎填
const t2 = makeTrace({ text: '随便一条', domain: 'group' });
assert.equal(t2.happenedAt, undefined, '没给就不填');

// 3) 渲染要带人名的结构（people 字段存在时）
const t3 = makeTrace({
  text: '渔樵问群友怎么锐评姆巴佩',
  people: ['渔樵'],
  happenedAt: Date.now() - 2 * 86_400_000,
  domain: 'group',
});
assert.deepEqual(t3.people, ['渔樵']);

// 4) 时间不会被写成机器格式
const src = (await import('node:fs')).readFileSync(new URL('../src/qq/memory-traces.ts', import.meta.url), 'utf8');
assert.ok(src.includes('function whenText'), '应有相对时间函数');
assert.ok(!/toLocaleString\('zh-CN'/.test(src), '痕迹行不该用完整时间戳格式');

console.log('trace-people-time: 人名与发生时刻字段就位');
