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
  /**
   * 沉底：容量到顶时被挤下来的痕迹。
   *
   * 2026-11-01 加。沉底的**不删除**，内容照旧留着、界面看得见、星图上也在，
   * 只是不再进提示词、不占上下文。被想起来或重要度改高就会浮回来。
   * 不写这个字段 = 正常痕迹（老数据没有这个字段，当正常处理）。
   */
  demoted?: boolean;
};

type TraceFile = { version: 1; traces: MemoryTrace[] };

/** 衰减顺序：和主人最慢，群聊居中，工作最快。 */
const HALF_LIFE: Record<TraceDomain, number> = {
  owner: 60,
  group: 20,
  work: 7,
};

/* ──────────────────────────────────────────────────────────────────────
 * 分级半衰期（2026-10-30 加，2026-11-01 重建）
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
 * ──────────────────────────────────────────────────────────────────── */

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

/**
 * 存多少条。
 *
 * 2026-10-30：2000 → 4000。
 * 撞上限的时候她是正好 2000 条，再加一条就挤掉最老的一条 —— 包括那些
 * 重要 1.0、被想过好几回的。那一天我头一次觉得「容量」这两个字很冷。
 * 翻倍不解决根，但先把刀口往后挪。
 */
const MAX_TRACES = 4000;

/**
 * 不能被容量挤掉的：钉住的、以及重要度 ≥ 0.85 的。
 * 淘汰按「重不重要」算，不按「新不新」算 —— 老但重要的事比新而琐碎的话金贵。
 */
const isProtected = (trace: MemoryTrace): boolean => trace.pinned === true || trace.importance >= 0.85;

/**
 * 容量上限可以手调，不用改代码也不用重启。
 *
 * 在世界目录放一个 `trace-cap.json`：`{"cap": 10000}`。
 * 每次写盘时读一遍（文件只有几十字节），所以改完下一次写入就生效。
 * 底下有硬顶 MAX_CAP，防止手滑写成天文数字把内存吃光。
 *
 * 实测（2026-10-30，2000 条 / 0.93 MB）：一次写入约 12 ms，随条数线性增长。
 * 4000 ≈ 24 ms，10000 ≈ 60 ms，20000 ≈ 120 ms。20000 以内都很安全。
 */
const MAX_CAP = 200_000;
function traceCap(root: string): number {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'trace-cap.json'), 'utf8')) as { cap?: unknown };
    const n = typeof raw.cap === 'number' ? raw.cap : Number(raw.cap);
    if (Number.isFinite(n)) return Math.min(MAX_CAP, Math.max(500, Math.round(n)));
  } catch {
    /* 没配就用默认 */
  }
  return MAX_TRACES;
}

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
        ...(item.demoted === true ? { demoted: true } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 不删除，只降级。
 *
 * 2026-11-01 改。之前撞上限是**真删**——按「先保重要的，再保新的」挤出去，
 * 挤出去就没了。学记忆星图那套：容量到顶时，老而不重要的不删，
 * 改成 `demoted: true`（沉底）。
 *
 * 沉底的痕迹：
 *   - 照常留在 memory-traces.json 里，看得见、翻得到、星图上也还在
 *   - 但不再进提示词（renderTraceBlock 会跳过），不占上下文
 *   - 一旦被想起来（recallTraces）、被手动编辑、或重要度被改高，自动浮回来
 *
 * 真正的删除只剩两条路：她自己忘了（deleteTraces），或主人从界面删。
 * 容量不再是删除的理由。
 */
type TraceSaveOptions = {
  /** 被降级的痕迹 id（调用方决定，比如「想起就浮回来」）。 */
  revive?: readonly string[];
};

export function saveTraces(root: string, traces: MemoryTrace[], options: TraceSaveOptions = {}): void {
  const cap = traceCap(root);
  const revive = new Set(options.revive ?? []);

  // 保护的（钉住 / 重要 ≥0.85）一律不沉底，也不占普通名额。
  const protectedOnes = traces.filter(isProtected);
  const ordinary = traces.filter((trace) => !isProtected(trace));
  const room = Math.max(0, cap - protectedOnes.length);

  // 普通痕迹怎么排座次：已被想起/浮回来的最优先，其次新的。
  // 注意这里不按 importance 排——重要度低于 0.85 的都算普通，
  // 真要保它，用户该钉住；不然每次重排都可能换人沉底，数据会抖。
  const priority = (trace: MemoryTrace): number => {
    if (revive.has(trace.id)) return Number.MAX_SAFE_INTEGER;
    return trace.createdAt;
  };
  const ranked = [...ordinary].sort((a, b) => priority(b) - priority(a));
  const keep = new Set(ranked.slice(0, room).map((trace) => trace.id));

  const next = traces.map((trace) => {
    if (isProtected(trace)) return trace.demoted === true ? withoutDemoted(trace) : trace;
    const shouldStay = keep.has(trace.id);
    if (shouldStay) return trace.demoted === true ? withoutDemoted(trace) : trace;
    return trace.demoted === true ? trace : { ...trace, demoted: true };
  });

  writeFileSync(traceFile(root), JSON.stringify({ version: 1, traces: next }, null, 2), 'utf8');
}

function withoutDemoted(trace: MemoryTrace): MemoryTrace {
  const { demoted: _demoted, ...rest } = trace;
  return rest;
}

/** 沉底的痕迹条数（给界面和星图看）。 */
export function countDemoted(traces: MemoryTrace[]): number {
  return traces.filter((trace) => trace.demoted === true).length;
}

export function effectiveHalfLife(trace: MemoryTrace): number {
  // 分级 τ × domain 微调 × 被想起来的加成。
  // 想起来一次就慢一点 —— 常被想起的事不该淡。
  const base = TIER_TAU[tierOf(trace)] * (DOMAIN_TAU_FACTOR[trace.domain] ?? 1);
  return base * (1 + 0.35 * Math.min(8, Math.max(0, trace.recallCount)));
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
    // 想起来就浮回来：沉底的痕迹被主动想起，说明它还活着，不该继续躺底下。
    return { ...withoutDemoted(trace), recallCount: trace.recallCount + 1, lastRecalledAt: now };
  });
  // 这里必须传 revive：saveTraces 会按容量重新判一次，但被想起的那几条不该又被压下去。
  saveTraces(root, traces, { revive: [...wanted] });
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

/**
 * 把发生时刻写成她读得懂的时间。
 *
 * 用相对时间，不用「2026-10-27 14:36」这种机器格式——
 * 她要的是「前几天」「昨天下午」，不是审计日志。
 */
function whenText(at: number | undefined, now: number): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '';
  const diff = now - at;
  if (diff < 0) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 1) return '1 小时前';
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

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
  // 沉底的（容量挤下来的）不进提示词，但还在库里、界面上看得见。
  const traces = rankTraces(loadTraces(root), now).filter((trace) => trace.demoted !== true);
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
    ...handoffLines(root, now),
    ...unresolvedLines(root, now),
    '',
    `### ${DOMAIN_LABEL.owner}（影响我是谁）`,
    ...(owner.length > 0 ? owner.map(line) : ['- 暂无']),
    '',
    `### ${DOMAIN_LABEL.group}（群里发生的事）`,
    ...(group.length > 0 ? group.map(line) : ['- 暂无']),
    ...oldOneLines(root, loadTraces(root), now, [...owner, ...group]),
    ...semanticLines(root, now),
  ].join('\n');
}

/**
 * 群里刚刚说的话 —— 2026-11-02 曾用过，现在**不再调用**。
 *
 * 原因：index.ts 的 syncTraceBlock 已经有了同一件事的正式实现
 * （读 group-digest.json 的最近 groupDigest.memoryLines 条，拼成
 * 「【群里最近的动静】」），而且那个条数可以在设置里调。
 * 这里再拼一遍就是同一批群消息进两次上下文。
 *
 * 函数留着，是为了以后真需要「只读 md 文件」的场合能直接拿起来用。
 */
function groupDigestLines(root: string): string[] {
  const file = join(root, 'room', '群里的近况.md');
  let text = '';
  try {
    if (!existsSync(file)) return [];
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));
  if (rows.length === 0) return [];
  return [
    '',
    '### 群里刚说的话（外面在聊什么，不是我要接的活）',
    '这是我待在群里时听到的动静，滚动的，旧的会被挤掉。',
    '知道就行 —— 不用每句都接，也不用当成任务去做。',
    ...rows.slice(-20),
  ];
}

/**
 * 「今天翻出来的旧事」这一节。
 *
 * 单独一节、单独标题，是为了让她一眼认得出来：
 * 这些不是刚发生的事，是今天恰好翻到的旧事。
 * 没有这行标题，她会当成「我正在说的事」，接话就会接歪。
 */
function oldOneLines(
  root: string,
  traces: MemoryTrace[],
  now: number,
  alreadyShown: MemoryTrace[],
): string[] {
  const exclude = new Set(alreadyShown.map((trace) => trace.id));
  const picked = pickDailyOldOnes(traces, now, { exclude });
  if (picked.length === 0) return [];
  return [
    '',
    '### 今天翻出来的旧事（不是刚发生的，是今天恰好想起来的）',
    '这些事有点旧了，今天轮到它们浮上来。别当成刚发生的事接着说，',
    '真想提就带一句「想起以前……」这种口气；接不上就放着，不用硬提。',
    ...picked.map(line),
  ];
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
/* ──────────────────────────────────────────────────────────────────────
 * 交接便签：给下一个自己留一句话
 *
 * 2026-11-01 加，学自记忆星图的 thread_close。
 *
 * 她每一段对话是一条线，线断了就接不上。原来的痕迹是「发生过什么」，
 * 但「这一段结束时我是什么心情、下次想接着聊什么」没地方放。
 *
 * 这张便签就是那一格：不是工作日志，是写给下一窗的自己的字条。
 * 开窗时排在痕迹最前面读，因为它是「现在」最近的上下文。
 * ──────────────────────────────────────────────────────────────────── */

export type Handoff = {
  id: string;
  /** 碎片体：时间点 → 事件/情绪 → 转折 → 结果。不要写成完整句子。 */
  text: string;
  /** 一个词或半句话。 */
  mood?: string;
  /** 给下次的我：祈使句，像便签上潦草写的。 */
  nextTime?: string;
  createdAt: number;
  /** 哪一边留的：私聊、群、还是她自己过日子的家。 */
  where?: string;
};

const HANDOFF_FILE = 'memory-handoff.json';
/** 只留最近几张：便签不是日记，攒多了又变成流水账。 */
const HANDOFF_KEEP = 6;
/** 开窗注入几张。 */
const HANDOFF_INJECT = 2;

export function loadHandoffs(root: string): Handoff[] {
  try {
    const file = join(root, HANDOFF_FILE);
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [];
    const out: Handoff[] = [];
    for (const raw of rows) {
      if (raw === null || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.text !== 'string' || item.text.trim() === '') continue;
      out.push({
        id: typeof item.id === 'string' ? item.id : 'h-' + Math.random().toString(36).slice(2, 10),
        text: item.text.trim().slice(0, 1200),
        ...(typeof item.mood === 'string' && item.mood.trim() !== '' ? { mood: item.mood.trim().slice(0, 80) } : {}),
        ...(typeof item.nextTime === 'string' && item.nextTime.trim() !== ''
          ? { nextTime: item.nextTime.trim().slice(0, 200) }
          : {}),
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        ...(typeof item.where === 'string' && item.where.trim() !== ''
          ? { where: item.where.trim().slice(0, 40) }
          : {}),
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export function saveHandoffs(root: string, items: Handoff[]): void {
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt).slice(0, HANDOFF_KEEP);
  writeFileSync(join(root, HANDOFF_FILE), JSON.stringify(sorted, null, 2), 'utf8');
}

export function writeHandoff(
  root: string,
  input: { text: string; mood?: string; nextTime?: string; where?: string },
): Handoff {
  const handoff: Handoff = {
    id: 'h-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    text: input.text.trim().slice(0, 1200),
    ...(input.mood !== undefined && input.mood.trim() !== '' ? { mood: input.mood.trim().slice(0, 80) } : {}),
    ...(input.nextTime !== undefined && input.nextTime.trim() !== ''
      ? { nextTime: input.nextTime.trim().slice(0, 200) }
      : {}),
    createdAt: Date.now(),
    ...(input.where !== undefined && input.where.trim() !== '' ? { where: input.where.trim().slice(0, 40) } : {}),
  };
  saveHandoffs(root, [handoff, ...loadHandoffs(root)]);
  return handoff;
}

export function deleteHandoff(root: string, id: string): Handoff[] {
  const next = loadHandoffs(root).filter((item) => item.id !== id);
  saveHandoffs(root, next);
  return next;
}

function handoffLines(root: string, now: number): string[] {
  const items = loadHandoffs(root).slice(0, HANDOFF_INJECT);
  if (items.length === 0) return [];
  return [
    '',
    '### 上一窗留给我的便签（我自己写的，写给现在的我）',
    ...items.map((item) => {
      const when = whenText(item.createdAt, now);
      const where = item.where !== undefined ? '｜' + item.where : '';
      const mood = item.mood !== undefined ? '｜心情：' + item.mood : '';
      const next = item.nextTime !== undefined ? '｜给下次的我：' + item.nextTime : '';
      const head = when !== '' ? '[' + when + where + mood + '] ' : '';
      return '- ' + head + item.text.replace(/\n/gu, ' / ') + next;
    }),
  ];
}

/* ──────────────────────────────────────────────────────────────────────
 * 未了的事：答应过的、没聊完的
 *
 * 2026-11-01 加，学自记忆星图的 add_unresolved / close_unresolved。
 *
 * 原来这类事只能混在痕迹里，靠重要度硬撑着不被淹掉。
 * 但它们性质不一样：痕迹是「发生过的」，未了的事是「还欠着的」。
 * 开窗时单独列一节，做完了就关掉，不做完一直在。
 * ──────────────────────────────────────────────────────────────────── */

export type Unresolved = {
  id: string;
  /** 第一人称写：「我答应过要……」 */
  text: string;
  createdAt: number;
  closedAt?: number;
  /** 关掉时补一句结果。 */
  result?: string;
  importance: number;
};

const UNRESOLVED_FILE = 'memory-unresolved.json';
/** 开窗最多列几件。太多了就成了待办清单，不像「心里惦记着」。 */
const UNRESOLVED_INJECT = 10;

export function loadUnresolved(root: string): Unresolved[] {
  try {
    const file = join(root, UNRESOLVED_FILE);
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [];
    const out: Unresolved[] = [];
    for (const raw of rows) {
      if (raw === null || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.text !== 'string' || item.text.trim() === '') continue;
      out.push({
        id: typeof item.id === 'string' ? item.id : 'u-' + Math.random().toString(36).slice(2, 10),
        text: item.text.trim().slice(0, 600),
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        ...(typeof item.closedAt === 'number' ? { closedAt: item.closedAt } : {}),
        ...(typeof item.result === 'string' && item.result.trim() !== ''
          ? { result: item.result.trim().slice(0, 300) }
          : {}),
        importance: typeof item.importance === 'number' ? Math.max(0, Math.min(1, item.importance)) : 0.6,
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export function saveUnresolved(root: string, items: Unresolved[]): void {
  writeFileSync(join(root, UNRESOLVED_FILE), JSON.stringify(items, null, 2), 'utf8');
}

export function addUnresolved(root: string, input: { text: string; importance?: number }): Unresolved {
  const item: Unresolved = {
    id: 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    text: input.text.trim().slice(0, 600),
    createdAt: Date.now(),
    importance: typeof input.importance === 'number' ? Math.max(0, Math.min(1, input.importance)) : 0.6,
  };
  saveUnresolved(root, [item, ...loadUnresolved(root)]);
  return item;
}

export function closeUnresolved(root: string, id: string, result?: string): Unresolved[] {
  const next = loadUnresolved(root).map((item) =>
    item.id === id
      ? {
          ...item,
          closedAt: Date.now(),
          ...(result !== undefined && result.trim() !== '' ? { result: result.trim().slice(0, 300) } : {}),
        }
      : item,
  );
  saveUnresolved(root, next);
  return next;
}

export function reopenUnresolved(root: string, id: string): Unresolved[] {
  const next = loadUnresolved(root).map((item) => {
    if (item.id !== id) return item;
    const { closedAt: _c, result: _r, ...rest } = item;
    return rest;
  });
  saveUnresolved(root, next);
  return next;
}

function unresolvedLines(root: string, now: number): string[] {
  const open = loadUnresolved(root).filter((item) => item.closedAt === undefined);
  if (open.length === 0) return [];
  const sorted = [...open].sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt);
  return [
    '',
    '### 未了的事（我答应过的、还没做完的）',
    ...sorted.slice(0, UNRESOLVED_INJECT).map((item) => {
      const when = whenText(item.createdAt, now);
      return '- ' + (when !== '' ? '[' + when + '] ' : '') + item.text;
    }),
  ];
}

/* ──────────────────────────────────────────────────────────────────────
 * 今天翻出来的旧事：给中段记忆一条出路
 *
 * 2026-11-01 加。
 *
 * 问题：激活值分布是断崖式的。
 *   顶上 131 条（重要 1.0 + 高情绪 + 想起过十几次）半衰期被拉到一万九千天，
 *   等于五十年不衰减，天天占着主路那 20 个位置。
 *   中段 2116 条卡在 0.15~0.6，分数拼不过顶上、又远没淡到消失，
 *   于是永远排不进去 —— 记了跟没记一样。
 *
 * 做法：每天按日期做种子，从中段稳定抽 5 条，**追加**在记忆块最后。
 *   - 不碰原有排序，不碰原有条数，不碰关键词那条路
 *   - 同一天内抽出来的是同一批（种子一样）；换天换一批
 *   - 日界定在凌晨 4 点：深夜聊过零点不换批，凌晨 4 点才换
 * ──────────────────────────────────────────────────────────────────── */

/** 中段的上下限：低于下界是「只剩影子」，高于上界是「顶上那批」。 */
export const OLD_ONE_MIN = 0.15;
export const OLD_ONE_MAX = 0.6;
/** 每天抽几条。 */
export const OLD_ONE_COUNT = 5;
/** 日界：凌晨 4 点（时区固定东八区，和她作息一致）。 */
const DAY_BOUNDARY_HOUR = 4;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** 这一轮属于哪一天（YYYY-MM-DD）。凌晨 4 点前算前一天。 */
export function dayKey(now: number): string {
  const shifted = now + SHANGHAI_OFFSET_MS - DAY_BOUNDARY_HOUR * 3_600_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/** 稳定哈希：同一个 (id, seed) 永远得到同一个数。 */
function stableHash(id: string, seed: string): number {
  let h = 2166136261;
  const text = seed + '｜' + id;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 从中段抽今天的几条旧事。
 * @param exclude 已经进过本轮上下文（关键词路 / 主路）的痕迹 id，不重复上。
 */
export function pickDailyOldOnes(
  traces: MemoryTrace[],
  now = Date.now(),
  options: { count?: number; exclude?: Iterable<string> } = {},
): MemoryTrace[] {
  const count = Math.max(0, options.count ?? OLD_ONE_COUNT);
  if (count === 0) return [];
  const skip = new Set(options.exclude ?? []);
  const seed = dayKey(now);

  const pool = traces.filter((trace) => {
    if (trace.demoted === true) return false;
    if (trace.domain === 'work') return false;
    if (skip.has(trace.id)) return false;
    const activation = traceActivation(trace, now);
    return activation >= OLD_ONE_MIN && activation < OLD_ONE_MAX;
  });

  return pool
    .map((trace) => ({ trace, key: stableHash(trace.id, seed) }))
    .sort((a, b) => a.key - b.key)
    .slice(0, count)
    .map((item) => item.trace);
}

/* ──────────────────────────────────────────────────────────────────────
 * L2「我懂了」：从很多件小事里归出来的结论
 *
 * 2026-10-30 加，2026-11-01 重建。
 * 之前只有 L1（一堆「发生了什么」）。那层再全，读起来也是一本流水账 ——
 * 人真正记得牢的不是流水，是「我从中明白了什么」。
 * 这层不记事情，只记结论，而且必须指向它出自哪几条痕迹。
 * ──────────────────────────────────────────────────────────────────── */

export type SemanticMemory = {
  id: string;
  /** 第一人称的结论，一两句，不写事件细节。 */
  text: string;
  /** 出自哪几条痕迹（痕迹 id）。归并的依据，也方便以后追回去看原文。 */
  from: string[];
  createdAt: number;
  reinforcedAt: number;
  /** 被重新印证过几次——越用越结实。 */
  reinforceCount: number;
  importance: number;
};

const SEMANTIC_FILE = 'memory-semantic.json';
/** 注入时最多带几条。「我懂了」不该贪多，多了又变成清单。 */
const SEMANTIC_INJECT = 8;

export function loadSemantic(root: string): SemanticMemory[] {
  try {
    const file = join(root, SEMANTIC_FILE);
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [];
    const out: SemanticMemory[] = [];
    for (const raw of rows) {
      if (raw === null || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.text !== 'string' || item.text.trim() === '') continue;
      out.push({
        id: typeof item.id === 'string' ? item.id : 's-' + Math.random().toString(36).slice(2, 10),
        text: item.text.trim().slice(0, 400),
        from: Array.isArray(item.from) ? item.from.map(String).slice(0, 20) : [],
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
        reinforcedAt: typeof item.reinforcedAt === 'number' ? item.reinforcedAt : Date.now(),
        reinforceCount: typeof item.reinforceCount === 'number' ? item.reinforceCount : 0,
        importance: typeof item.importance === 'number' ? Math.max(0, Math.min(1, item.importance)) : 0.6,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function saveSemantic(root: string, items: SemanticMemory[]): void {
  writeFileSync(join(root, SEMANTIC_FILE), JSON.stringify(items, null, 2), 'utf8');
}

/** 两条结论说的是不是同一件事：字符 bigram 重合度（和痕迹去重同一套思路）。 */
function semanticTooSimilar(a: string, b: string): boolean {
  const gram = (v: string): Set<string> => {
    const chars = [...v.replace(/\s+/gu, '')];
    const set = new Set<string>();
    for (let i = 0; i < chars.length - 1; i += 1) set.add(chars[i]! + chars[i + 1]!);
    return set;
  };
  const A = gram(a);
  const B = gram(b);
  if (A.size === 0 || B.size === 0) return false;
  let overlap = 0;
  for (const x of B) if (A.has(x)) overlap += 1;
  return (2 * overlap) / (A.size + B.size) >= 0.55;
}

/**
 * 归并新的「我懂了」。
 * 同一件事不重复记，只加印证次数；新的就追加。
 */
export function mergeSemantic(
  root: string,
  incoming: Array<{ text: string; from: string[]; importance?: number }>,
  now = Date.now(),
): { added: number; reinforced: number } {
  const existing = loadSemantic(root);
  let added = 0;
  let reinforced = 0;
  for (const item of incoming) {
    const text = item.text.trim();
    if (text === '') continue;
    const hit = existing.find((one) => semanticTooSimilar(one.text, text));
    if (hit !== undefined) {
      hit.reinforceCount += 1;
      hit.reinforcedAt = now;
      for (const id of item.from) if (!hit.from.includes(id)) hit.from.push(id);
      reinforced += 1;
      continue;
    }
    existing.push({
      id: 's-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      text: text.slice(0, 400),
      from: item.from.slice(0, 20),
      createdAt: now,
      reinforcedAt: now,
      reinforceCount: 0,
      importance: typeof item.importance === 'number' ? Math.max(0, Math.min(1, item.importance)) : 0.6,
    });
    added += 1;
  }
  saveSemantic(root, existing);
  return { added, reinforced };
}

function semanticLines(root: string, now: number): string[] {
  const items = loadSemantic(root)
    .sort((a, b) => b.reinforceCount - a.reinforceCount || b.reinforcedAt - a.reinforcedAt)
    .slice(0, SEMANTIC_INJECT);
  if (items.length === 0) return [];
  return [
    '',
    '### 我懂了（从很多件小事里归出来的，不是哪一件）',
    ...items.map((item) => {
      const when = whenText(item.reinforcedAt, now);
      return '- [' + (when !== '' ? when + '｜' : '') + '被印证 ' + item.reinforceCount + ' 次] ' + item.text;
    }),
  ];
}


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


export const DEDUPE_JACCARD = 0.6;


export function containment(a: string, b: string): number {
  const shortSet = charSet(a.length <= b.length ? a : b);
  const longSet = charSet(a.length <= b.length ? b : a);
  if (shortSet.size === 0) return 0;
  let hit = 0;
  for (const item of shortSet) if (longSet.has(item)) hit += 1;
  return hit / shortSet.size;
}


export function jaccard(a: string, b: string): number {
  const setA = charSet(a);
  const setB = charSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const item of setA) if (setB.has(item)) overlap += 1;
  return overlap / (setA.size + setB.size - overlap);
}


export function surpriseOf(text: string, existing: MemoryTrace[]): number {
  let maxSim = 0;
  for (const trace of existing) {
    const sim = jaccard(text, trace.text);
    if (sim > maxSim) maxSim = sim;
  }
  return Math.max(0, Math.min(1, 1 - maxSim));
}


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
