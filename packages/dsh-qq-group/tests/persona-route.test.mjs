/**
 * 验证世界控制台 /console/persona 的入参处理（走真实导出的 handleConsole）。
 *   · {text:"..."} → savePersonaText
 *   · 旧的按层提交 → 仍走 savePersona
 *   · 非法入参 → 400
 *   · 空文本 → 合法（表示清空）
 */
import assert from 'node:assert/strict';

const ROUTES = 'DSH_HOME/profiles/desktop/node_modules/dsh-world/lib/console/routes.js';
const { handleConsole } = await import('file://' + ROUTES);

const calls = [];
const actions = new Proxy({}, {
  get: (_t, key) => (...args) => { calls.push([key, ...args]); return undefined; },
});
const sources = {};

const post = (body) =>
  handleConsole(sources, actions, {
    url: '/dsh-world/console/persona',
    method: 'POST',
    write: true,
    body,
  });

// 1) 整段文本
const r1 = await post({ text: '一整段人设原文' });
assert.equal(r1.status, 200, '整段文本应该被接受');
assert.equal(calls.at(-1)[0], 'savePersonaText', '应走 savePersonaText');
assert.equal(calls.at(-1)[1], '一整段人设原文', '文本要原样传下去');

// 2) 旧的分层提交仍兼容
const r2 = await post({ 名字: '鲸鲸', 性格: '傲娇' });
assert.equal(r2.status, 200, '旧的按层提交应该还认');
assert.equal(calls.at(-1)[0], 'savePersona', '应走 savePersona');

// 3) 非法：text 不是字符串
assert.equal((await post({ text: 123 })).status, 400);

// 4) 非法：未知字段
assert.equal((await post({ 乱写: 'x' })).status, 400);

// 5) 空文本合法（等于清空）
const r5 = await post({ text: '' });
assert.equal(r5.status, 200, '空文本应被接受');
assert.equal(calls.at(-1)[1], '');

// 6) 没有写权限 → 403（跨站保护还在）
const forbidden = await handleConsole(sources, actions, {
  url: '/dsh-world/console/persona', method: 'POST', write: false, body: { text: 'x' },
});
assert.equal(forbidden.status, 403, '没有写权限必须拒绝');

console.log('persona-route: all assertions passed');
