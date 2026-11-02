/**
 * 记忆星图：把她的实时记忆转成星图能画的形状。
 *
 * 2026-11-01 加。
 *
 * 原来是记忆星图（companion-memory）自己存一份副本，再画出来 —— 两份数据，
 * 还得起一个 Worker 进程、记一串密钥。现在改成：星图直接读这边的实时记忆，
 * 一份数据，没有密钥，打开就是最新的。
 *
 * 这个文件只做「翻译」：MemoryTrace → 星图认的 star 形状。
 */

import type { MemoryTrace } from './memory-traces';
import { traceActivation, effectiveHalfLife, tierOf } from './memory-traces';

/** 星图那边认的 kind。她的 domain + tier 合过来。 */
const KIND_OF: Record<string, string> = {
  owner: 'relationship',
  group: 'event',
  work: 'event',
};

/** 强度 → 星图的三档状态。和金环、亮度对应。 */
function stateOf(trace: MemoryTrace, activation: number): 'clear' | 'faded' | 'trace' {
  if (trace.pinned) return 'clear';
  if (activation >= 0.5) return 'clear';
  if (activation >= 0.15) return 'faded';
  return 'trace';
}

export type AtlasStar = {
  id: string;
  persona: string;
  persona_name: string;
  kind: string;
  /** 1-5，星图按这个决定星点大小。 */
  importance: number;
  tags: string[];
  content: string;
  created_at: string;
  last_recalled_at: string | null;
  recall_count: number;
  emotion: number;
  half_life_days: number;
  strength: number;
  state: string;
  pinned: boolean;
  /** 沉底的（容量挤下来但没删）。 */
  demoted: boolean;
  last_surfaced_at: string | null;
};

export type AtlasData = {
  generated_at: string;
  counts: {
    total: number;
    pinned: number;
    clear: number;
    faded: number;
    trace: number;
    recalled: number;
    links: number;
    items: number;
    cognitions: number;
    demoted: number;
    handoffs: number;
    unresolved: number;
  };
  stars: AtlasStar[];
  links: Array<{ a: string; b: string; w: number; k: string }>;
  items: never[];
  personas: Array<{ id: string; name: string; core: string }>;
};

/** 一条痕迹 → 一颗星。 */
function toStar(trace: MemoryTrace, now: number, displayName: string): AtlasStar {
  const activation = trace.pinned ? 1 : traceActivation(trace, now);
  const tier = tierOf(trace);
  return {
    id: trace.id,
    persona: 'companion',
    persona_name: displayName,
    kind: KIND_OF[trace.domain] ?? 'event',
    importance: Math.max(1, Math.min(5, Math.round(trace.importance * 4) + 1)),
    tags: [
      tier === 'core' ? '核心' : tier === 'important' ? '重要' : '日常',
      ...(Array.isArray(trace.people) ? trace.people.slice(0, 3) : []),
    ],
    // 星图上点开看到的第一行是正文，第二行是「当时想」——
    // 她的 feeling 是最值钱的字段，不能被吞掉。
    content: trace.feeling !== undefined && trace.feeling !== '' ? `${trace.text}\n\n当时想：${trace.feeling}` : trace.text,
    created_at: new Date(trace.happenedAt ?? trace.createdAt).toISOString(),
    last_recalled_at: trace.lastRecalledAt > 0 ? new Date(trace.lastRecalledAt).toISOString() : null,
    recall_count: trace.recallCount,
    emotion: trace.emotion,
    half_life_days: Math.round(effectiveHalfLife(trace)),
    strength: Math.round(activation * 1000) / 1000,
    state: stateOf(trace, activation),
    pinned: trace.pinned,
    demoted: trace.demoted === true,
    last_surfaced_at: null,
  };
}

/**
 * 生连线：同一天 + 同 domain 的相邻记忆连起来。
 *
 * 星图原来靠向量做语义连线，本地没有 embedding，所以先用「同一时期」的线。
 * 这条线在星图里走得很淡（time 类型），是底噪，不是主体——
 * 主体还是每颗星自己的亮度和钉住的金环。
 */
function buildLinks(stars: AtlasStar[]): Array<{ a: string; b: string; w: number; k: string }> {
  const byBucket = new Map<string, AtlasStar[]>();
  for (const star of stars) {
    // 沉底的不连线，它已经在底下了
    if (star.demoted) continue;
    const day = star.created_at.slice(0, 10);
    const bucket = `${day}|${star.kind}`;
    const list = byBucket.get(bucket);
    if (list === undefined) byBucket.set(bucket, [star]);
    else list.push(star);
  }
  const links: Array<{ a: string; b: string; w: number; k: string }> = [];
  for (const list of byBucket.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (let i = 0; i + 1 < list.length; i += 1) {
      links.push({ a: list[i]!.id, b: list[i + 1]!.id, w: 0.3, k: 'time' });
    }
  }
  return links;
}

export function buildAtlasData(
  traces: MemoryTrace[],
  options: { now?: number; displayName?: string; coreCard?: string } = {},
): AtlasData {
  const now = options.now ?? Date.now();
  const displayName = options.displayName ?? '大肥鱼';
  const stars = traces.map((trace) => toStar(trace, now, displayName));
  const count = (fn: (s: AtlasStar) => boolean): number => stars.filter(fn).length;
  return {
    generated_at: new Date(now).toISOString(),
    counts: {
      total: stars.length,
      pinned: count((s) => s.pinned),
      clear: count((s) => s.state === 'clear'),
      faded: count((s) => s.state === 'faded'),
      trace: count((s) => s.state === 'trace'),
      recalled: count((s) => s.recall_count > 0),
      links: 0,
      items: 0,
      cognitions: 0,
      demoted: count((s) => s.demoted),
      handoffs: 0,
      unresolved: 0,
    },
    stars,
    links: buildLinks(stars),
    items: [],
    personas: [{ id: 'companion', name: displayName, core: options.coreCard ?? '' }],
  };
}
