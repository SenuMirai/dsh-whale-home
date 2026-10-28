/**
 * 决策：确定性优先。
 *
 * 出自「大肥鱼系统」文档 §4.3：
 *   为避免过度随机，当首选概率 ≥ 0.55 且领先次选 ≥ 0.15 时直接采纳
 *   （deterministic-first），仅在选项接近（竞争态）时交由坍缩抽样。
 *
 * 为什么要这个：以前处处 Math.random()，明明只有一个合理选项也要掷一次骰子。
 * 结果是她对同一件事的反应忽左忽右，看着不像有主见的人，像个骰子。
 * 现在只有真的两难时才摇。
 */

/** 首选够不够格直接拍板：概率 ≥ 0.55 且领先次选 ≥ 0.15。 */
export const DECISIVE_P = 0.55;
export const DECISIVE_LEAD = 0.15;

export type WeightedOption<T> = {
  /** 选项本身，调用方自己定义形状 */
  value: T;
  /** 相对权重，不必归一化；全部 ≤0 时视为无选项 */
  weight: number;
};

export type Decision<T> = {
  value: T | undefined;
  /** 是否直接拍板（false = 摇出来的） */
  decisive: boolean;
  /** 首选概率 */
  topP: number;
  /** 与次选的差 */
  lead: number;
};

/**
 * 按权重做决定，但「一边倒」时不摇骰子。
 *
 * @param options 候选与权重；空数组会返回 value: undefined
 * @param random 注入随机源，测试用
 * @returns 选中项 + 这次有没有摇
 */
export function decide<T>(
  options: ReadonlyArray<WeightedOption<T>>,
  random: () => number = Math.random,
): Decision<T> {
  const pool = options.filter((item) => Number.isFinite(item.weight) && item.weight > 0);
  if (pool.length === 0) return { value: undefined, decisive: false, topP: 0, lead: 0 };

  if (pool.length === 1) {
    return { value: pool[0]!.value, decisive: true, topP: 1, lead: 1 };
  }

  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  const ranked = [...pool].sort((a, b) => b.weight - a.weight);
  const topP = ranked[0]!.weight / total;
  const secondP = ranked[1]!.weight / total;
  const lead = topP - secondP;

  // 一边倒：直接采纳，不掷骰子。
  if (topP >= DECISIVE_P && lead >= DECISIVE_LEAD) {
    return { value: ranked[0]!.value, decisive: true, topP, lead };
  }

  // 竞争态：加权抽样。
  let roll = random() * total;
  for (const item of pool) {
    roll -= item.weight;
    if (roll <= 0) return { value: item.value, decisive: false, topP, lead };
  }
  return { value: pool[pool.length - 1]!.value, decisive: false, topP, lead };
}
