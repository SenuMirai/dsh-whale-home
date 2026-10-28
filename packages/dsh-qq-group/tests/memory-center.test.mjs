import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_MEMORY_POLICY,
  POLICY_FILE,
  appendPendingMaterial,
  appendQqDiarySection,
  appendQqTurn,
  dayKey,
  extractArchiveDirectives,
  fragmentHint,
  keepAlbumImage,
  qqDiaryPath,
  readMemoryPolicy,
  readMergedDiary,
  readRecentTurns,
  worldDiaryPath,
} from '../src/qq/memory-center.ts';

const BASE = join(process.cwd(), '.tmp-test-memory-center');
mkdirSync(BASE, { recursive: true });
function freshWorld() {
  return mkdtempSync(join(BASE, 'w-'));
}

// 1. 容量口径：首次读写种子，二次读文件；坏文件报错不兜底
{
  const dir = freshWorld();
  const first = readMemoryPolicy(dir);
  assert.equal(first.ok, true);
  assert.equal(first.seeded, true, '首次应写种子');
  assert.ok(existsSync(join(dir, POLICY_FILE)), '种子文件应落盘');

  writeFileSync(join(dir, POLICY_FILE), JSON.stringify({ ...DEFAULT_MEMORY_POLICY, contextTurns: 33 }), 'utf8');
  const second = readMemoryPolicy(dir);
  assert.equal(second.ok, true);
  assert.equal(second.seeded, false);
  assert.equal(second.policy.contextTurns, 33, '应读文件里的值');

  writeFileSync(join(dir, POLICY_FILE), '{bad json', 'utf8');
  const broken = readMemoryPolicy(dir);
  assert.equal(broken.ok, false, '坏文件必须报错，不能静默回退');
}

// 2. 日记：插件只写分片，不碰成品；合并读两边都在
{
  const dir = freshWorld();
  const now = new Date('2026-10-28T09:30:00+08:00');
  const date = dayKey(now);

  const wrote = appendQqDiarySection(dir, '今天普通聊天里记的一笔', now);
  assert.equal(wrote.ok, true);
  assert.ok(existsSync(qqDiaryPath(dir, date)), '分片应落盘');
  assert.equal(existsSync(worldDiaryPath(dir, date)), false, '插件不得创建成品');

  const merged1 = readMergedDiary(dir, date);
  assert.ok(merged1.qq.includes('今天普通聊天里记的一笔'));
  assert.equal(merged1.pending, true, '分片还没折进成品');

  mkdirSync(join(dir, 'diary'), { recursive: true });
  writeFileSync(worldDiaryPath(dir, date), '# 世界写的\n\n今天世界这半。', 'utf8');
  const merged2 = readMergedDiary(dir, date);
  assert.ok(merged2.merged.includes('今天世界这半。'));
  assert.ok(merged2.merged.includes('今天普通聊天里记的一笔'));
  assert.ok(
    merged2.merged.indexOf('今天世界这半。') < merged2.merged.indexOf('今天普通聊天里记的一笔'),
    '成品在前、分片在后',
  );
}

// 3. 流水：qq- 分片和世界归档按时间归并
{
  const dir = freshWorld();
  const now = new Date('2026-10-28T09:00:00+08:00');
  const date = dayKey(now);
  mkdirSync(join(dir, 'conversations'), { recursive: true });
  writeFileSync(
    join(dir, 'conversations', `${date}.jsonl`),
    `${JSON.stringify({ occurredAt: '2026-10-28T08:59:00+08:00', role: 'user', content: '世界那边的第一句' })}\n`,
    'utf8',
  );
  assert.equal(appendQqTurn(dir, { role: 'user', content: '插件这边的第二句', at: now, session: 'p:1' }), true);
  assert.equal(appendQqTurn(dir, { role: 'assistant', content: '插件这边的回答', at: now, session: 'p:1' }), true);
  assert.ok(existsSync(join(dir, 'conversations', `qq-${date}.jsonl`)), '分片文件名要带 qq- 前缀');

  const turns = readRecentTurns(dir, { limit: 10, days: 2 });
  assert.equal(turns.length, 3);
  assert.equal(turns[0].content, '世界那边的第一句', '按时间排序，世界那句更早');
  assert.equal(turns[2].content, '插件这边的回答');
  assert.ok(turns.some((turn) => turn.origin === 'qq-plugin'));
}

// 4. 留档指令：从回复里摘掉，不发给主人
{
  const parsed = extractArchiveDirectives('好呀[日记：今天被主人叫醒了三次][相册：这张留着]那就这样');
  assert.deepEqual(parsed.diary, ['今天被主人叫醒了三次']);
  assert.deepEqual(parsed.album, ['这张留着']);
  assert.equal(parsed.clean, '好呀 那就这样');
  const none = extractArchiveDirectives('普通一句话');
  assert.equal(none.clean, '普通一句话');
  assert.deepEqual(none.diary, []);
}

// 5. 相册：图进家里、登记进待整理、超限拒绝
{
  const dir = freshWorld();
  const now = new Date('2026-10-28T10:00:00+08:00');
  const ok = keepAlbumImage(dir, { data: new Uint8Array([1, 2, 3, 4]), ext: 'png' }, '好看的一张', now);
  assert.equal(ok.ok, true);
  assert.ok(existsSync(ok.file), '图片要落进相册目录');
  assert.ok(ok.file.includes(join('room', '相册')), '路径要在相册目录下');

  const pending = readFileSync(join(dir, 'room', '待整理.md'), 'utf8');
  assert.ok(pending.includes('好看的一张'));

  writeFileSync(join(dir, POLICY_FILE), JSON.stringify({ ...DEFAULT_MEMORY_POLICY, albumMaxBytes: 2 }), 'utf8');
  const rejected = keepAlbumImage(dir, { data: new Uint8Array([1, 2, 3, 4]), ext: 'png' }, '太大', now);
  assert.equal(rejected.ok, false, '超限要拒绝');
}

// 6. 分片提示：只有存在分片时才给一句
{
  const dir = freshWorld();
  const now = new Date('2026-10-28T11:00:00+08:00');
  assert.equal(fragmentHint(dir, now), '', '没有分片就不占上下文');
  appendQqDiarySection(dir, '写一笔', now);
  const hint = fragmentHint(dir, now);
  assert.ok(hint.includes(`qq-${dayKey(now)}.md`));
  assert.ok(hint.includes('一起读'));
}

// 7. 待整理：空行不入库
{
  const dir = freshWorld();
  assert.equal(appendPendingMaterial(dir, '   '), false);
  assert.equal(appendPendingMaterial(dir, '一条素材'), true);
  assert.ok(readFileSync(join(dir, 'room', '待整理.md'), 'utf8').includes('一条素材'));
}

rmSync(BASE, { recursive: true, force: true });
console.log('memory-center: all cases passed');
