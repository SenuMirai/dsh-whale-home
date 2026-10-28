import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * 记忆痕迹只有一份，群聊和私聊共用。
 *
 * owner —— 和主人的记忆，衰减最慢
 * group —— 群聊记忆，居中
 * work  —— 工作，衰减最快
 */
export type TraceDomain = 'owner' | 'group' | 'work';

/** 旧数据里叫 life，读的时候当 owner 用。 */
type StoredDomain = TraceDomain | 'life';

export const TRACE_DOMAINS: readonly TraceDomain[] = ['owner', 'group', 'work'];

export const DOMAIN_LABEL: Record<TraceDomain, string> = {
  owner: '和主人的记忆',
  group: '群聊记忆',
  work: '工作',
};

export type MemoryTrace = {
  id: string;
  text: string;
  /** 当时的内心一句：她怎么想、什么感觉。让痕迹不只是档案。 */
  feeling?: string;
  domain: TraceDomain;
  /** 0~1，决定它值不值得被长期保留 */
  importance: number;
  /** 0~1，当时的情绪强度 */
  emotion: number;
  createdAt: number;
  lastRecalledAt: number;
  recallCount: number;
  /** 基础半衰期（天） */
  halfLifeDays: number;
  pinned: boolean;
  source: 'manual' | 'extract';
};

type TraceFile = { version: 1; traces: MemoryTrace[] };

/** 衰减顺序：和主人最慢，群聊居中，工作最快。 */
const HALF_LIFE: Record<TraceDomain, number> = {
  owner: 60,
  group: 20,
  work: 7,
};

/**
 * 记忆分级（照「大肥鱼系统」文档 §2.6）。
 *
 * 原来所有记忆都用同一个连续指数衰减，只有 domain 三档半衰期。
 * 问题：一条「她说她喜欢白饭」和一条「今天看了个修驴蹄子的视频」衰减一样快，
 * 前者该记十年，后者该一周就淡。
 *
 * 现在按重要度分三级，τ 差三个数量级：
 *   core      —— 钉住的、或重要度 ≥0.85 的。τ = 3650 天（十年）
 *   important —— 重要度 ≥0.5 的。           τ = 30 天
 *   normal    —— 其余。                      τ = 7 天
 *
 * domain 仍作为微调系数叠在上面：和主人的慢一点、工作的快一点。
 */
export type TraceTier = 'core' | 'important' | 'normal';

export const TIER_TAU: Record<TraceTier, number> = {
  core: 3650,
  important: 30,
  normal: 7,
};

/** domain 微调：主人的记忆更耐放，工作的更快淡。 */
const DOMAIN_TAU_FACTOR: Record<TraceDomain, number> = {
  owner: 1.4,
  group: 1,
  work: 0.6,
};

/** 一条记忆属于哪一级。pinned 一定 core。 */
export function tierOf(trace: Pick<MemoryTrace, 'pinned' | 'importance'>): TraceTier {
  if (trace.pinned) return 'core';
  if (trace.importance >= 0.85) return 'core';
  if (trace.importance >= 0.5) return 'important';
  return 'normal';
}

const MAX_TRACES = 2000;

const isDomain = (value: unknown): value is TraceDomain =>
  value === 'owner' || value === 'group' || value === 'work';

const normalizeDomain = (value: unknown): TraceDomain | null => {
  if (value === 'life') return 'owner';
  return isDomain(value) ? value : null;
};

function traceFile(root: string): string {
  return join(root, 'memory-traces.json');
}

export function loadTraces(root: string): MemoryTrace[] {
  try {
    const file = traceFile(root);
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<TraceFile>;
    if (!Array.isArray(parsed.traces)) return [];
    const out: MemoryTrace[] = [];
    for (const raw of parsed.traces) {
      if (raw === null || typeof raw !== 'object') continue;
      const item = raw as unknown as Record<string, unknown>;
      if (typeof item.id !== 'string' || typeof item.text !== 'string') continue;
      const domain = normalizeDomain(item.domain);
      if (domain === null) continue;
      out.push({
        id: item.id,
        text: item.text,
        ...(typeof item.feeling === 'string' && item.feeling.trim() !== ''
          ? { feeling: item.feeling.trim().slice(0, 400) }
          : {}),
        domain,
        importance: typeof item.importance === 'number' ? item.importance : 0.55,
        emotion: typeof item.emotion === 'number' ? item.emotion : 0.2,
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        lastRecalledAt: typeof item.lastRecalledAt === 'number' ? item.lastRecalledAt : Date.now(),
        recallCount: typeof item.recallCount === 'number' ? item.recallCount : 0,
        halfLifeDays: typeof item.halfLifeDays === 'number' ? item.halfLifeDays : HALF_LIFE[domain],
        pinned: item.pinned === true,
        source: item.source === 'extract' ? 'extract' : 'manual',
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function saveTraces(root: string, traces: MemoryTrace[]): void {
  const sorted = [...traces].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_TRACES);
  writeFileSync(traceFile(root), JSON.stringify({ version: 1, traces: sorted }, null, 2), 'utf8');
}

/**
 * 有效半衰期（天）。
 * 分级 τ × domain 微调 × 被想起来的加成。
 * 想起来一次就慢一点 —— 常被想起的事不该淡。
 */
export function effectiveHalfLife(trace: MemoryTrace): number {
  const tier = tierOf(trace);
  const base = TIER_TAU[tier] * (DOMAIN_TAU_FACTOR[trace.domain] ?? 1);
  const recallBoost = 1 + 0.35 * Math.min(8, Math.max(0, trace.recallCount));
  return base * recallBoost;
}

export function traceActivation(trace: MemoryTrace, now = Date.now()): number {
  if (trace.pinned) return 1;
  const ageDays = Math.max(0, (now - trace.createdAt) / 86_400_000);
  const decay = Math.exp(-ageDays / Math.max(0.5, effectiveHalfLife(trace)));
  return Math.max(0, Math.min(1, trace.importance * (0.6 + 0.4 * trace.emotion) * decay));
}

export function traceScore(trace: MemoryTrace, now = Date.now(), query = ''): number {
  const ageDays = Math.max(0, (now - trace.createdAt) / 86_400_000);
  const recency = trace.pinned ? 1 : 0.35 + 0.65 * Math.exp(-ageDays / 14);
  const activation = traceActivation(trace, now);
  let relevance = 1;
  const q = query.trim().toLowerCase();
  if (q !== '') {
    const text = trace.text.toLowerCase();
    const words = q.split(/\s+/u).filter((word) => word.length >= 2).slice(0, 8);
    const hits = words.filter((word) => text.includes(word)).length;
    relevance = words.length === 0 ? 1 : Math.min(1, 0.25 + hits / words.length);
  }
  return relevance * (0.35 + 0.65 * activation) * recency;
}

export function rankTraces(
  traces: MemoryTrace[],
  now = Date.now(),
  query = '',
): Array<MemoryTrace & { score: number }> {
  return traces
    .map((trace) => ({ ...trace, score: traceScore(trace, now, query) }))
    .sort((a, b) => b.score - a.score);
}

const DEFAULT_IMPORTANCE: Record<TraceDomain, number> = {
  owner: 0.55,
  group: 0.45,
  work: 0.35,
};

export function makeTrace(input: {
  text: string;
  feeling?: string;
  domain?: TraceDomain;
  importance?: number;
  emotion?: number;
  pinned?: boolean;
  source?: 'manual' | 'extract';
  createdAt?: number;
}): MemoryTrace {
  const text = input.text.trim().slice(0, 2000);
  const domain: TraceDomain = isDomain(input.domain) ? input.domain : 'owner';
  const now = Date.now();
  const id = createHash('sha256')
    .update(`${domain}:${text.toLowerCase().replace(/\s+/gu, ' ').trim()}`)
    .digest('hex')
    .slice(0, 16);
  const feeling = input.feeling?.trim().slice(0, 400) ?? '';
  return {
    id: `m-${id}`,
    text,
    ...(feeling !== '' ? { feeling } : {}),
    domain,
    importance: Math.max(0, Math.min(1, input.importance ?? DEFAULT_IMPORTANCE[domain])),
    emotion: Math.max(0, Math.min(1, input.emotion ?? 0.2)),
    createdAt: input.createdAt ?? now,
    lastRecalledAt: input.createdAt ?? now,
    recallCount: 0,
    halfLifeDays: HALF_LIFE[domain],
    pinned: input.pinned === true,
    source: input.source ?? 'manual',
  };
}

/** 字符集（去空白、转小写），给 Jaccard 用。 */
function charSet(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/\s+/gu, '');
  return new Set([...clean]);
}

/** Jaccard 相似度：交集 / 并集。全空视为 0。 */
export function jaccard(a: string, b: string): number {
  const setA = charSet(a);
  const setB = charSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const item of setA) if (setB.has(item)) overlap += 1;
  return overlap / (setA.size + setB.size - overlap);
}

/** 包含度：短的那条有多大比例出现在长的那条里。 */
export function containment(a: string, b: string): number {
  const shortSet = charSet(a.length <= b.length ? a : b);
  const longSet = charSet(a.length <= b.length ? b : a);
  if (shortSet.size === 0) return 0;
  let hit = 0;
  for (const item of shortSet) if (longSet.has(item)) hit += 1;
  return hit / shortSet.size;
}

/** 惊讶度：1 − 与既有记忆的最大 Jaccard。越像越不惊讶，越不该单独存一条。 */
export function surpriseOf(text: string, existing: MemoryTrace[]): number {
  let maxSim = 0;
  for (const trace of existing) {
    const sim = jaccard(text, trace.text);
    if (sim > maxSim) maxSim = sim;
  }
  return Math.max(0, Math.min(1, 1 - maxSim));
}

/** 去重判定阈值（照文章给的数）。 */
export const DEDUPE_JACCARD = 0.6;
export const DEDUPE_CONTAINMENT = 0.78;

/**
 * 找一条「已经说过同样的事」的记忆。
 *
 * 规则照文章：Jaccard ≥ 0.60 且包含度 ≥ 0.78、且同 domain 时算重复。
 * 另外：pinned（闪光灯）不参与合并 —— 那种记忆就是要有重复的锚点，不能被并掉。
 *
 * @returns 命中的既有痕迹；没有就 undefined
 */
export function findDuplicate(
  text: string,
  domain: TraceDomain,
  existing: MemoryTrace[],
): MemoryTrace | undefined {
  const incoming = text.trim();
  if (incoming === '') return undefined;
  for (const trace of existing) {
    if (trace.pinned) continue;          // 闪光灯不参与
    if (trace.domain !== domain) continue; // 跨域不合并：和主人的话不该被群聊的吞掉
    const sim = jaccard(incoming, trace.text);
    if (sim < DEDUPE_JACCARD) continue;
    if (containment(incoming, trace.text) < DEDUPE_CONTAINMENT) continue;
    return trace;
  }
  return undefined;
}

export type WriteResult = {
  trace: MemoryTrace;
  /** 是不是并进了已有那条 */
  merged: boolean;
  /** 并入的是哪条（merged 时有意义） */
  into?: string;
  /** 这次写入的惊讶度（1 = 全新，0 = 完全重复） */
  surprise: number;
};

/**
 * 写入一条记忆，带惊讶度去重。
 *
 * 照文档 §2.2 / §2.7：
 *  - 惊讶度 s = 1 − 与既有记忆的最大 Jaccard。全新的东西 s 高，值得单独存。
 *  - Jaccard ≥ 0.60 且包含度 ≥ 0.78 且同 domain → 视为同一件事，并进去而不新建。
 *  - pinned（闪光灯）不参与合并 —— 那种记忆本来就是要留个重复的锚点。
 *
 * 合并时怎么处理：保留原来那条的 id 和时间，把文本取更完整的一份，
 * 重要度/情绪取两者更高的 —— 同一件事被说起两次，说明它更重要，不是更不重要。
 */
export function writeTrace(root: string, trace: MemoryTrace): WriteResult {
  const traces = loadTraces(root);
  const surprise = surpriseOf(trace.text, traces);
  const dup = findDuplicate(trace.text, trace.domain, traces);

  if (dup === undefined) {
    // 同 id 已存在（同一句话再来一次、而那条是 pinned 所以没走合并）→ 覆盖，不新增重复 id。
    const sameId = traces.findIndex((item) => item.id === trace.id);
    if (sameId >= 0) {
      const prev = traces[sameId]!;
      const next: MemoryTrace = {
        ...prev,
        importance: Math.max(prev.importance, trace.importance),
        emotion: Math.max(prev.emotion, trace.emotion),
        recallCount: prev.recallCount + 1,
        lastRecalledAt: Date.now(),
      };
      saveTraces(root, traces.map((item, i) => (i === sameId ? next : item)));
      return { trace: next, merged: false, surprise };
    }
    saveTraces(root, [trace, ...traces]);
    return { trace, merged: false, surprise };
  }

  const keepLonger = dup.text.length >= trace.text.length ? dup.text : trace.text;
  const merged: MemoryTrace = {
    ...dup,
    text: keepLonger,
    importance: Math.max(dup.importance, trace.importance),
    emotion: Math.max(dup.emotion, trace.emotion),
    // 同一件事又说了一次 → 算一次回想，衰减变慢
    recallCount: dup.recallCount + 1,
    lastRecalledAt: Date.now(),
    ...(dup.feeling === undefined && trace.feeling !== undefined ? { feeling: trace.feeling } : {}),
  };
  saveTraces(root, traces.map((item) => (item.id === dup.id ? merged : item)));
  return { trace: merged, merged: true, into: dup.id, surprise };
}

export function upsertTrace(root: string, trace: MemoryTrace): MemoryTrace[] {
  const traces = loadTraces(root);
  const index = traces.findIndex((item) => item.id === trace.id);
  if (index >= 0) traces[index] = { ...traces[index], ...trace };
  else traces.unshift(trace);
  saveTraces(root, traces);
  return traces;
}

export function updateTrace(root: string, id: string, patch: Partial<MemoryTrace>): MemoryTrace[] {
  const traces = loadTraces(root);
  const next = traces.map((trace) => (trace.id === id ? { ...trace, ...patch, id: trace.id } : trace));
  saveTraces(root, next);
  return next;
}

export function deleteTraces(root: string, ids: string[]): MemoryTrace[] {
  const remove = new Set(ids);
  const next = loadTraces(root).filter((trace) => !remove.has(trace.id));
  saveTraces(root, next);
  return next;
}

/** 被当前话题重新想起：激活回升、半衰期变长。 */
export function recallTraces(root: string, ids: string[], now = Date.now()): MemoryTrace[] {
  const wanted = new Set(ids);
  const traces = loadTraces(root).map((trace) => {
    if (!wanted.has(trace.id)) return trace;
    return { ...trace, recallCount: trace.recallCount + 1, lastRecalledAt: now };
  });
  saveTraces(root, traces);
  return traces;
}

/** 字符 bigram + 关键词的轻量语义相似度；不依赖外部向量库。 */
function queryRelevance(text: string, query: string): number {
  const clean = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, ' ')
      .trim();
  const body = clean(text);
  const q = clean(query);
  if (body === '' || q === '') return 0;
  const words = q.split(/\s+/u).filter((word) => word.length >= 2);
  const exact = words.filter((word) => body.includes(word)).length;
  const gram = (value: string): Set<string> => {
    const chars = [...value.replace(/\s+/gu, '')];
    const set = new Set<string>();
    for (let i = 0; i < chars.length - 1; i += 1) set.add(chars[i] + chars[i + 1]);
    return set;
  };
  const a = gram(body);
  const b = gram(q);
  let overlap = 0;
  for (const item of b) if (a.has(item)) overlap += 1;
  const dice = b.size === 0 ? 0 : (2 * overlap) / (a.size + b.size);
  const keyword = words.length === 0 ? 0 : exact / words.length;
  return Math.max(0, Math.min(1, keyword * 0.6 + dice * 0.4));
}

/** 当聊天内容涉及某条痕迹时自动想起；不是只能靠按钮。 */
export function autoRecallTraces(root: string, query: string, now = Date.now()): string[] {
  const text = query.trim();
  if (text === '') return [];
  const hits = loadTraces(root)
    .map((trace) => ({ trace, relevance: queryRelevance(trace.text, text) }))
    .filter((item) => item.relevance >= 0.15)
    .sort((a, b) => {
      const scoreA = a.relevance * traceScore(a.trace, now, text);
      const scoreB = b.relevance * traceScore(b.trace, now, text);
      return scoreB - scoreA;
    })
    .slice(0, 3);
  if (hits.length === 0) return [];
  recallTraces(
    root,
    hits.map((item) => item.trace.id),
    now,
  );
  return hits.map((item) => item.trace.id);
}

/** 给群聊用：按当前话题捞几条相关痕迹，含和主人的记忆。 */
export function recallForChat(root: string, query: string, limit = 4, now = Date.now()): MemoryTrace[] {
  const text = query.trim();
  const traces = loadTraces(root);
  if (text === '') {
    return rankTraces(
      traces.filter((trace) => trace.domain !== 'work'),
      now,
    ).slice(0, limit);
  }
  return traces
    .filter((trace) => trace.domain !== 'work')
    .map((trace) => ({ trace, relevance: queryRelevance(trace.text, text) }))
    .filter((item) => item.relevance >= 0.1)
    .sort((a, b) => {
      const scoreA = a.relevance * traceScore(a.trace, now, text);
      const scoreB = b.relevance * traceScore(b.trace, now, text);
      return scoreB - scoreA;
    })
    .slice(0, limit)
    .map((item) => item.trace);
}

const BEGIN = '<!-- MEMORY-TRACES:BEGIN -->';
const END = '<!-- MEMORY-TRACES:END -->';

const line = (trace: MemoryTrace): string => {
  const tag = trace.pinned ? '钉选' : DOMAIN_LABEL[trace.domain];
  const feeling = trace.feeling !== undefined && trace.feeling !== '' ? `｜当时想：${trace.feeling}` : '';
  return `- [${tag}｜重要 ${trace.importance.toFixed(1)}｜情绪 ${trace.emotion.toFixed(1)}｜想起 ${trace.recallCount} 次] ${trace.text.replace(/\n/gu, ' / ')}${feeling}`;
};

/** 轻松的、日常的那种记忆：让基调不至于全是「怕失去」。 */
const LIGHT = /喜欢|开心|可爱|笑|撒娇|嘴硬|心疼|得意|高兴|暖|抱|甜|饭|吃|逛|玩|好耶|嘿嘿|哼|宝宝|喜欢/;

/**
 * 取 owner 记忆时配平：分数高的照常用，但保证至少 4 条是轻松的日常。
 * 否则「害怕断裂」「不想只是工具」这类高情绪条目会占满前排，
 * 她说起话来就一直是那个调子。
 */
/** 两条记忆说的是不是同一件事：字符 bigram 重合度。 */
function tooSimilar(a: string, b: string): boolean {
  const gram = (value: string): Set<string> => {
    const chars = [...value.replace(/\s+/gu, '')];
    const set = new Set<string>();
    for (let i = 0; i < chars.length - 1; i += 1) set.add(chars[i] + chars[i + 1]);
    return set;
  };
  const ga = gram(a);
  const gb = gram(b);
  if (ga.size === 0 || gb.size === 0) return false;
  let overlap = 0;
  for (const item of gb) if (ga.has(item)) overlap += 1;
  return (2 * overlap) / (ga.size + gb.size) > 0.42;
}

/**
 * 取 owner 记忆时做两件事：
 * 1. 去重——「见父母」「创造结局」这类同义条目以前会占掉三个位置，整块读起来就一个调子；
 * 2. 配平——保证至少 3 条是轻松的日常，别让「怕失去」占满前排。
 */
export function renderTraceBlock(root: string, now = Date.now()): string {
  const traces = rankTraces(loadTraces(root), now);
  const ownerRanked = traces.filter((trace) => trace.domain === 'owner');

  const owner: MemoryTrace[] = [];
  const taken: string[] = [];
  // 同一件事最多出现几次：不然「见父母」「结局」「不想当工具」会各占好几行，
  // 整块读下来就只剩一个调子。
  const THEMES: Array<{ test: RegExp; cap: number }> = [
    { test: /见父母|带回家|回她家|回大海/, cap: 1 },
    { test: /结局/, cap: 1 },
    { test: /能干活|记得住的那个|不当工具|当玩意儿/, cap: 1 },
    { test: /不会走|一直陪|陪着/, cap: 2 },
  ];
  const themeCount = new Map<number, number>();
  const push = (trace: MemoryTrace): void => {
    if (owner.length >= 12) return;
    if (owner.some((item) => item.id === trace.id)) return;
    if (taken.some((text) => tooSimilar(text, trace.text))) return;
    for (let i = 0; i < THEMES.length; i += 1) {
      const theme = THEMES[i]!;
      if (!theme.test.test(trace.text)) continue;
      const used = themeCount.get(i) ?? 0;
      if (used >= theme.cap) return;
      themeCount.set(i, used + 1);
      break;
    }
    owner.push(trace);
    taken.push(trace.text);
  };

  // 先放 3 条轻松的日常，把基调定住；剩下的位置再按分数补。
  let lightCount = 0;
  for (const trace of ownerRanked) {
    if (lightCount >= 3) break;
    if (!LIGHT.test(trace.text)) continue;
    const before = owner.length;
    push(trace);
    if (owner.length > before) lightCount += 1;
  }
  for (const trace of ownerRanked.slice(0, 16)) push(trace);

  const group: MemoryTrace[] = [];
  const groupTaken: string[] = [];
  for (const trace of traces.filter((item) => item.domain === 'group')) {
    if (group.length >= 8) break;
    if (groupTaken.some((text) => tooSimilar(text, trace.text))) continue;
    group.push(trace);
    groupTaken.push(trace.text);
  }
  return [
    '## 我的记忆痕迹',
    '',
    '这些是我自己记得的事，按重要性和最近被想起的程度排。工作细节不放在这里。',
    '群聊和私聊共用这一份，不是两套。这些都是日常，不用把每一件都看得很重。',
    '',
    `### ${DOMAIN_LABEL.owner}（影响我是谁）`,
    ...(owner.length > 0 ? owner.map(line) : ['- 暂无']),
    '',
    `### ${DOMAIN_LABEL.group}（群里发生的事）`,
    ...(group.length > 0 ? group.map(line) : ['- 暂无']),
  ].join('\n');
}

/** 把痕迹块写进 world prompt 的保留区，下一次开始/压缩时生效。 */
export function syncTracePrompt(worldPromptFile: string, block: string): void {
  let text = '';
  try {
    text = existsSync(worldPromptFile) ? readFileSync(worldPromptFile, 'utf8') : '';
  } catch {
    return;
  }
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  const clean = start >= 0 && end > start ? `${text.slice(0, start)}${text.slice(end + END.length)}` : text;
  const next = `${clean.trimEnd()}\n\n${BEGIN}\n${block.trim()}\n${END}\n`;
  writeFileSync(worldPromptFile, next, 'utf8');
}

export function tracePromptBlock(root: string, worldPromptFile: string, now = Date.now()): string {
  const block = renderTraceBlock(root, now);
  syncTracePrompt(worldPromptFile, block);
  return block;
}
