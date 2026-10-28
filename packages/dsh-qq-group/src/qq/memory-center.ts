/**
 * 记忆中心：worldDir 是唯一记忆库，插件只往自己的分片里写。
 *
 * ── 硬规矩（方案 v2 的总原则，落成代码） ──
 * 1. **每个文件只有一个写者。**
 *    插件写：`diary/qq-<日>.md`、`conversations/qq-<日>.jsonl`、`room/待整理.md`、`room/相册/*`。
 *    世界写：`diary/<日>.md`、`相册.md`、`我是谁.md`、`persona.md`、`world-prompt.md`。
 * 2. **不做跨写者互斥。** 世界那侧是模型用 read/edit/write 改文件，不经过任何 fs 锁，
 *    所以锁在这里结构性兑现不了；防护只有两条：写者隔离（文件级）＋写者自洽（单次原子追加）。
 * 3. **读侧归并。** 成品与当日分片按时间排序后一起给模型看，白天两边读到的都是完整时间线。
 *
 * 这里只做纯文件操作，不读模型、不发消息；桥接层负责在合适的时机调用。
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { MAX_GROUPS, MAX_TURNS_PER_GROUP } from './memory.ts';

/** 记忆容量口径：两边唯一的数字来源。 */
export interface MemoryPolicy {
  version: number;
  /** 每个群/会话保留多少条短记忆 */
  turnsPerSession: number;
  /** 保留多少个会话 */
  maxSessions: number;
  /** 进模型上下文的最近条数 */
  contextTurns: number;
  /** 群聊私聊互贴的条数 */
  shareTurns: number;
  /** 长期记忆召回条数 */
  traceTopK: number;
  /** 永久记忆召回 */
  permanentRecallLimit: number;
  permanentRecallChars: number;
  /** 群里近况滚动条数与留存量 */
  digestRoll: number;
  digestKeep: number;
  /** 日记/回看保留天数 */
  diaryKeepDays: number;
  /** 读记忆快照时最多几个日文件、几行、每行多少字 */
  memoryReadDays: number;
  memoryReadLines: number;
  memoryLineChars: number;
  /** 相册限额 */
  albumMaxBytes: number;
  albumMaxFiles: number;
}

/**
 * 唯一的默认值来源：首次启动写种子，之后一律读文件。
 * 读不到就报错，不各自兜底——兜底两次就会长出第三个真相源。
 */
export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  version: 1,
  turnsPerSession: MAX_TURNS_PER_GROUP,
  maxSessions: MAX_GROUPS,
  contextTurns: 60,
  shareTurns: 12,
  traceTopK: 6,
  permanentRecallLimit: 12,
  permanentRecallChars: 1500,
  digestRoll: 40,
  digestKeep: 600,
  diaryKeepDays: 14,
  memoryReadDays: 5,
  memoryReadLines: 80,
  memoryLineChars: 1200,
  albumMaxBytes: 20 * 1024 * 1024,
  albumMaxFiles: 2000,
};

export const POLICY_FILE = 'memory-policy.json';

export type PolicyResult =
  | { ok: true; policy: MemoryPolicy; seeded: boolean }
  | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** 读容量口径；首次启动把默认值写进去当种子。 */
export function readMemoryPolicy(worldDir: string): PolicyResult {
  const file = join(worldDir, POLICY_FILE);
  if (!existsSync(file)) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(DEFAULT_MEMORY_POLICY, null, 2)}\n`, 'utf8');
      return { ok: true, policy: { ...DEFAULT_MEMORY_POLICY }, seeded: true };
    } catch (e) {
      return { ok: false, message: `容量口径种子写入失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!isRecord(parsed)) return { ok: false, message: `${POLICY_FILE} 不是对象` };
    const merged: MemoryPolicy = { ...DEFAULT_MEMORY_POLICY };
    for (const key of Object.keys(DEFAULT_MEMORY_POLICY) as Array<keyof MemoryPolicy>) {
      const value = parsed[key];
      if (typeof value === 'number' && Number.isFinite(value)) merged[key] = value;
    }
    return { ok: true, policy: merged, seeded: false };
  } catch (e) {
    return { ok: false, message: `${POLICY_FILE} 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 本地日期（Asia/Shanghai），YYYY-MM-DD。 */
export function dayKey(date: Date = new Date()): string {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

/** 本地时间 HH:mm。 */
export function clockOf(date: Date = new Date()): string {
  return date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 5);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** 当日分片：普通聊天写的日记。 */
export function qqDiaryPath(worldDir: string, date: string): string {
  return join(worldDir, 'diary', `qq-${date}.md`);
}

/** 世界自己的当日日记（成品）。 */
export function worldDiaryPath(worldDir: string, date: string): string {
  return join(worldDir, 'diary', `${date}.md`);
}

/**
 * 普通聊天写日记：只追加自己的分片，不碰成品。
 * 单次 append，失败不重试到天荒地老——返回给调用方去报主人。
 */
export function appendQqDiarySection(
  worldDir: string,
  text: string,
  at: Date = new Date(),
): { ok: true; path: string } | { ok: false; message: string } {
  const body = text.trim();
  if (body === '') return { ok: false, message: '日记内容是空的' };
  const date = dayKey(at);
  const file = qqDiaryPath(worldDir, date);
  try {
    ensureDir(dirname(file));
    const header = existsSync(file) ? '' : `# ${date} · 普通聊天写的那半\n`;
    appendFileSync(file, `${header}\n## ${clockOf(at)} · 普通聊天\n${body}\n`, 'utf8');
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** 私聊/群聊流水：和世界归档同 schema，只是前缀不同，读侧归并。 */
export function appendQqTurn(
  worldDir: string,
  entry: { role: 'user' | 'assistant'; content: string; at?: Date; session: string; name?: string },
): boolean {
  const text = entry.content.trim();
  if (text === '') return false;
  const at = entry.at ?? new Date();
  const file = join(worldDir, 'conversations', `qq-${dayKey(at)}.jsonl`);
  try {
    ensureDir(dirname(file));
    appendFileSync(
      file,
      `${JSON.stringify({
        occurredAt: at.toISOString(),
        role: entry.role,
        content: text.slice(0, 4000),
        origin: 'qq-plugin',
        session: entry.session,
        ...(entry.name === undefined ? {} : { name: entry.name }),
      })}\n`,
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

/** 待整理：相册登记、值得进日记/我是谁的素材，逐条追加。 */
export function appendPendingMaterial(
  worldDir: string,
  line: string,
  at: Date = new Date(),
): boolean {
  const text = line.trim();
  if (text === '') return false;
  const file = join(worldDir, 'room', '待整理.md');
  try {
    ensureDir(dirname(file));
    const header = existsSync(file)
      ? ''
      : '# 待整理\n\n普通聊天这侧攒下来的素材：相册登记、值得进日记或「我是谁」的片段。\n夜里由世界折进成品，折完可以清空。\n';
    appendFileSync(file, `${header}- ${clockOf(at)} ${text}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 相册留底：图片文件本身插件独占（文件名带时间戳与内容哈希，天然不冲突），
 * 索引只在待整理里登记一行，成品 `相册.md` 由世界折。
 */
export function keepAlbumImage(
  worldDir: string,
  image: { data: Uint8Array; ext: string },
  note: string,
  at: Date = new Date(),
): { ok: true; file: string } | { ok: false; message: string } {
  const policy = readMemoryPolicy(worldDir);
  if (!policy.ok) return { ok: false, message: policy.message };
  if (image.data.byteLength > policy.policy.albumMaxBytes) {
    return { ok: false, message: `图片太大（${Math.round(image.data.byteLength / 1024)}KB），限额 ${Math.round(policy.policy.albumMaxBytes / 1024)}KB` };
  }
  const dir = join(worldDir, 'room', '相册');
  try {
    ensureDir(dir);
    const hash = createHash('sha256').update(image.data).digest('hex').slice(0, 8);
    const stamp = at.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/[-: ]/g, '').slice(0, 14);
    const ext = image.ext.replace(/[^a-z0-9]/giu, '').toLowerCase() || 'jpg';
    const file = join(dir, `${stamp}-${hash}.${ext}`);
    if (!existsSync(file)) writeFileSync(file, image.data);
    // 只登一处：待整理.md。相册目录里再写一份就等于两个索引，世界折叠时会对不上。
    appendPendingMaterial(worldDir, `相册 | ${note.trim() || '留了一张'} | ${file.split(/[\\/]/u).pop()}`, at);
    return { ok: true, file };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export type MergedDiary = {
  date: string;
  /** 世界的成品那半 */
  world: string;
  /** 普通聊天写的分片那半 */
  qq: string;
  /** 拼好的连续时间线（世界在前、分片接在后面） */
  merged: string;
  /** 分片还没折进成品 */
  pending: boolean;
};

/** 读一天：成品 ∪ 分片。两边都读这个，谁也不会只看见一半。 */
export function readMergedDiary(worldDir: string, date: string): MergedDiary {
  const read = (file: string): string => {
    try {
      return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    } catch {
      return '';
    }
  };
  const world = read(worldDiaryPath(worldDir, date));
  const qq = read(qqDiaryPath(worldDir, date));
  const merged =
    world === '' && qq === ''
      ? ''
      : [world, qq === '' ? '' : `\n---\n\n${qq}`].filter((part) => part !== '').join('\n').trim();
  return { date, world, qq, merged, pending: qq !== '' && !world.includes(qq.split('\n').slice(-3).join('\n').trim()) };
}

/** 最近几天有分片的日子，从新到旧。 */
export function recentQqDiaryDays(worldDir: string, limit = 7): string[] {
  const dir = join(worldDir, 'diary');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .map((name) => /^qq-(\d{4}-\d{2}-\d{2})\.md$/u.exec(name)?.[1])
      .filter((value): value is string => typeof value === 'string')
      .sort()
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** 插件侧读最近流水（含 qq- 分片与其他来源），给上下文归并用。 */
export function readRecentTurns(
  worldDir: string,
  options: { limit?: number; days?: number; chars?: number } = {},
): Array<{ occurredAt: string; role: string; content: string; origin?: string }> {
  const policy = readMemoryPolicy(worldDir);
  const defaults = policy.ok ? policy.policy : DEFAULT_MEMORY_POLICY;
  const limit = Math.max(1, options.limit ?? defaults.contextTurns);
  const days = Math.max(1, options.days ?? 3);
  const chars = Math.max(80, options.chars ?? defaults.memoryLineChars);
  const dir = join(worldDir, 'conversations');
  if (!existsSync(dir)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(dir)
      .filter((name) => /^(?:qq-)?\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name))
      .sort()
      .slice(-days);
  } catch {
    return [];
  }
  const lines: Array<{ occurredAt: string; role: string; content: string; origin?: string }> = [];
  for (const name of names) {
    let raw = '';
    try {
      raw = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      try {
        const item = JSON.parse(line) as { occurredAt?: unknown; role?: unknown; content?: unknown; origin?: unknown };
        if (typeof item.content !== 'string' || item.content === '') continue;
        lines.push({
          occurredAt: typeof item.occurredAt === 'string' ? item.occurredAt : '',
          role: typeof item.role === 'string' ? item.role : 'user',
          content: item.content.slice(0, chars),
          ...(typeof item.origin === 'string' ? { origin: item.origin } : {}),
        });
      } catch {
        /* 跳过坏行 */
      }
    }
  }
  // 两侧时间戳的时区写法可能不同（本地 +08:00 / UTC Z），按真实时刻比，别按字符串比。
  const stamp = (value: string): number => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  lines.sort((a, b) => stamp(a.occurredAt) - stamp(b.occurredAt));
  return lines.slice(-limit);
}

/** 模型回复里带的留档指令：`[日记：…]`、`[相册：…]`，发出去之前要摘掉。 */
export function extractArchiveDirectives(text: string): { clean: string; diary: string[]; album: string[] } {
  const diary: string[] = [];
  const album: string[] = [];
  const clean = text
    .replace(/\[日记[:：]\s*([^\]\n]{1,800})\]/gu, (_m, body: string) => {
      const value = body.trim();
      if (value !== '') diary.push(value);
      return ' ';
    })
    .replace(/\[相册[:：]\s*([^\]\n]{1,200})\]/gu, (_m, body: string) => {
      const value = body.trim();
      if (value !== '') album.push(value);
      return ' ';
    })
    .replace(/[ \t]{2,}/gu, ' ')
    .trim();
  return { clean, diary, album };
}

/** 给世界 prompt 用的一句话：分片在哪、读今天要两个都读。 */
export function fragmentHint(worldDir: string, at: Date = new Date()): string {
  const date = dayKey(at);
  const file = qqDiaryPath(worldDir, date);
  if (!existsSync(file)) return '';
  return `今天普通聊天写的那半在 diary/qq-${date}.md；读今天的日记要成品和它一起读。`;
}

/** 触摸时间戳（世界侧用它判断分片是否还在更新）。 */
export function fragmentUpdatedAt(worldDir: string, at: Date = new Date()): number {
  const file = qqDiaryPath(worldDir, dayKey(at));
  try {
    return existsSync(file) ? statSync(file).mtimeMs : 0;
  } catch {
    return 0;
  }
}
