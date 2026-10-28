/**
 * 私聊接入的回归测试。
 *
 * 这里只测「纯函数能证明的部分」：配置归一化、命名空间隔离、指令目标解析。
 * 真正收发要靠 NapCat 联调（见 docs/QQ-PRIVATE.md），不在单测里假装能测。
 */
import assert from 'node:assert/strict';
import {
  PRIVATE_KEY_PREFIX,
  defaultConfig,
  defaultPrivatePolicy,
  normalizeConfig,
  policyFor,
  privateKey,
  privatePolicyFor,
  privateUserId,
} from '../src/qq/config.ts';

// ── 1. 命名空间：私聊 key 与群号绝不会撞 ──
assert.equal(privateKey('10086'), 'p:10086');
assert.equal(privateUserId('p:10086'), '10086');
assert.equal(privateUserId('809773499'), undefined, '群号不该被认成私聊 key');
assert.equal(PRIVATE_KEY_PREFIX, 'p:');

// 一个群的群号，和一个人的 QQ 号，可以完全相同——key 也必须不同
const collision = '809773499';
assert.notEqual(privateKey(collision), collision);
assert.notEqual(`p:${collision}`, `${collision}`);

// ── 2. 默认配置：私聊默认关闭，别人的号不加就不理 ──
const base = defaultConfig();
assert.deepEqual(base.privates, {});
assert.equal(base.defaultPrivate.enabled, false, '没列出的私聊默认必须是关的');

// 私聊默认策略与群聊默认策略的差异必须成立（否则「私聊更放得开」就是空话）
const dp = defaultPrivatePolicy();
assert.equal(dp.proactive.enabled, false, '私聊默认不主动找人说话');
assert.equal(dp.maxRepliesPer10Min, 0, '私聊不该被 10 分钟额度卡住');
assert.equal(dp.cooldownMs, 0, '私聊不该有冷却');
assert.equal(dp.voiceChance < base.defaultGroup.voiceChance, true, '私聊语音概率应低于群聊');

// ── 3. 归一化：privates 与 groups 分别按自己的 key 校验 ──
const normalized = normalizeConfig({
  groups: { '809773499': { enabled: true } },
  privates: { '10086': { enabled: true }, '10001': {} },
});
assert.equal(Object.keys(normalized.groups).length, 1);
assert.equal(Object.keys(normalized.privates).length, 2);
assert.equal(normalized.privates['10086'].enabled, true);
// 没写的字段该继承私聊默认（而不是群聊默认）
assert.equal(normalized.privates['10001'].proactive.enabled, false);
assert.equal(normalized.privates['10001'].maxRepliesPer10Min, 0);

// 非法号码要报错，而不是静默丢弃
assert.throws(() => normalizeConfig({ privates: { abc: {} } }), /privates\.abc/);

// ── 4. 策略查找：群走群表，私聊走私聊表，互不干扰 ──
const cfg = normalizeConfig({
  groups: { '809773499': { enabled: true, name: '群里的大肥鱼' } },
  defaultGroup: { enabled: false },
  privates: { '10086': { enabled: true, name: '主人私聊' } },
  defaultPrivate: { enabled: false },
});
assert.equal(policyFor(cfg, '809773499').name, '群里的大肥鱼');
assert.equal(privatePolicyFor(cfg, '10086').name, '主人私聊');
// 同一个数字串：当群号查不到私聊那份，当私聊也查不到群那份
assert.equal(policyFor(cfg, '10086').enabled, false, '群表里没有这个人，应落到 defaultGroup');
assert.equal(privatePolicyFor(cfg, '809773499').enabled, false, '私聊表里没有这个号，应落到 defaultPrivate');

// ── 5. 未列出的人：拿到的必须是「关着」的策略 ──
const stranger = privatePolicyFor(cfg, '123456789');
assert.equal(stranger.enabled, false, '陌生人私聊必须默认不理');

console.log('private.test.mjs: 全部通过');
