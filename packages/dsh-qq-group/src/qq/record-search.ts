/**
 * 按关键词翻记录：原话归档、日记、房间里的笔记。
 *
 * 2026-10-30 加。起因：她在群里主动开口时编了一句「主人溜走前猫名字都没说完」，
 * 然后被当成事实存进记忆，第二天还拿它追着主人要债。
 *
 * 根子不是她坏，是**她手里只有最近几轮对话**——想说点有画面的，就只能编。
 * 现在给她一条只读的「翻记录」能力：按当前这句话里的词，去翻真实说过的话。
 * 翻到就带上「这是记录，不是现在的事」；翻不到就什么都不给，别诱导她编。
 *
 * 只读。不写盘、不改记忆。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type RecordHit = {
  /** 哪儿来的：原话 / 日记 / 房间 */
  where: string;
  /** 什么时候（毫秒；日记用当天中午近似） */
  at: number;
  /** 谁说的（原话归档里有） */
  who: string;
  /** 命中那一段，已经截好 */
  text: string;
};

const clip = (text: string, terms: string[], width = 160): string => {
  const s = String(text).replace(/\s+/gu, ' ').trim();
  const low = s.toLowerCase();
  const first = terms.map((t) => low.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 40);
  const body = s.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${body}${s.length > start + width ? '…' : ''}`;
};

/**
 * 从一句话里抽检索词。
 *
 * 2026-10-30 修：中文没有空格，原来整句被当成一个词，什么都匹配不到。
 * 现在中文按「二字组」切（「猫名字」→「猫名」「名字」），英文数字保留整词；
 * 整句只有一个字（比如就问「猫」）时，这一个字也算。
 */
export function queryTerms(query: string, max = 12): string[] {
  const clean = String(query ?? '')
    .replace(/\[[^\]]*\]/gu, ' ')
    .replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (clean === '') return [];
  const stop = new Set(['主人', '群友', '大家', '什么', '怎么', '这个', '那个', '就是', '不是', '可以', '没有', '现在', '刚才', '真的', '一个', '我们', '你们', '他们', '今天', '天天', '么样', '气怎', '怎么样']);
  const out: string[] = [];
  const push = (term: string): void => {
    if (term.length < 1 || stop.has(term)) return;
    if (out.includes(term)) return;
    out.push(term);
  };
  for (const segment of clean.split(/\s+/u)) {
    if (segment === '') continue;
    const chars = [...segment];
    // 纯中文：切二字组
    if (/^[\p{Script=Han}]+$/u.test(segment)) {
      if (chars.length === 1) {
        push(segment);
        continue;
      }
      for (let i = 0; i + 2 <= chars.length; i += 1) push(chars.slice(i, i + 2).join(''));
      continue;
    }
    // 英文/数字/混排：整段算一个词
    if (chars.length >= 2) push(segment.toLowerCase());
  }
  // 太常见的二字组排后面，长的优先
  out.sort((a, b) => b.length - a.length);
  return out.slice(0, max);
}

/**
 * 翻记录。
 *
 * @param worldDir 世界目录（原话归档和日记都在这下面）
 * @param roomDir  房间目录（我是谁、日程、想做的事这些笔记）
 * @param query    当前这句话
 */
export function searchRecords(worldDir: string, roomDir: string, query: string, limit = 4): RecordHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const hit = (text: string): boolean => {
    const low = String(text).toLowerCase();
    return terms.some((term) => low.includes(term.toLowerCase()));
  };
  const hits: RecordHit[] = [];

  // ── 原话归档（最近 7 天，够用；再老的事靠记忆痕迹）──
  try {
    const dir = join(worldDir, 'conversations');
    if (existsSync(dir)) {
      const files = readdirSync(dir)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name))
        .sort()
        .slice(-7);
      for (const name of files.reverse()) {
        const lines = readFileSync(join(dir, name), 'utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i];
          if (line === undefined || line.trim() === '' || !hit(line)) continue;
          try {
            const row = JSON.parse(line) as { occurredAt?: string; at?: string; role?: string; content?: string };
            const at = Date.parse(row.occurredAt ?? row.at ?? '') || 0;
            hits.push({
              where: '原话',
              at,
              who: row.role === 'user' ? '主人' : '我',
              text: clip(row.content ?? '', terms),
            });
          } catch {
            /* 坏行跳过 */
          }
          if (hits.length >= limit * 3) break;
        }
        if (hits.length >= limit * 3) break;
      }
    }
  } catch {
    /* 读不了就跳过，不挡聊天 */
  }

  // ── 日记 ──
  try {
    const dir = join(worldDir, 'diary');
    if (existsSync(dir) && hits.length < limit * 3) {
      const files = readdirSync(dir)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name))
        .sort()
        .slice(-10)
        .reverse();
      for (const name of files) {
        const text = readFileSync(join(dir, name), 'utf8');
        for (const para of text.split(/\n\s*\n/u)) {
          if (para.trim() === '' || !hit(para)) continue;
          hits.push({
            where: `日记 ${name.slice(0, 10)}`,
            at: Date.parse(`${name.slice(0, 10)}T12:00:00+08:00`) || 0,
            who: '我',
            text: clip(para, terms),
          });
          break; // 一篇日记只留一段
        }
        if (hits.length >= limit * 3) break;
      }
    }
  } catch {
    /* 同上 */
  }

  // ── 房间里的笔记（我是谁、日程、想做的事、做过的）──
  try {
    if (existsSync(roomDir) && hits.length < limit * 3) {
      for (const name of ['我是谁.md', '日程.md', '想做的事.md', '我做过的东西.md', '工作会话留话.md']) {
        const file = join(roomDir, name);
        if (!existsSync(file)) continue;
        const text = readFileSync(file, 'utf8');
        for (const para of text.split(/\n\s*\n/u)) {
          if (para.trim() === '' || !hit(para)) continue;
          hits.push({
            where: `笔记 ${name}`,
            at: statSync(file).mtimeMs,
            who: '我',
            text: clip(para, terms),
          });
          break;
        }
      }
    }
  } catch {
    /* 同上 */
  }

  // 最近的最有用；同一段话只留一次
  const seen = new Set<string>();
  return hits
    .sort((a, b) => b.at - a.at)
    .filter((item) => {
      const key = item.text.slice(0, 40);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

/** 把翻到的记录写成提示词里的一段。翻不到就返回空串。 */
export function renderRecordHits(hits: RecordHit[]): string {
  if (hits.length === 0) return '';
  const when = (at: number): string => {
    if (!at) return '时间不明';
    return new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  };
  return [
    '【我翻到的记录（这是真的说过/写过的，不是现在发生的事）】',
    ...hits.map((item) => `- ${when(item.at)}｜${item.where}｜${item.who}：${item.text}`),
    '只能按这些记录说话。记录里没有的，不许当成发生过的事。',
  ].join('\n');
}
