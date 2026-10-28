/** 私聊分条规则：放在插件目录下，每轮读取，改完不用重启。 */
export type ChatStyle = {
  /** 一条气泡最多多少字，超了再拆 */
  maxBubbleChars: number;
  /** 多短算碎片（两边都短才合并） */
  mergeShortChars: number;
  /** 合并后最多多少字 */
  mergeCombinedChars: number;
  /** 合并时用什么连接 */
  mergeJoiner: string;
  /** 一轮最多几条气泡 */
  maxBubbles: number;
};

export const DEFAULT_CHAT_STYLE: ChatStyle = {
  maxBubbleChars: 120,
  mergeShortChars: 14,
  mergeCombinedChars: 26,
  mergeJoiner: '，',
  maxBubbles: 5,
};

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
};

/** 容错读取：文件缺失或写坏都退回默认值，不让聊天挂掉。 */
export function normalizeChatStyle(raw: unknown): ChatStyle {
  const src = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const joiner =
    typeof src.mergeJoiner === 'string' && src.mergeJoiner !== ''
      ? src.mergeJoiner.slice(0, 4)
      : DEFAULT_CHAT_STYLE.mergeJoiner;
  return {
    maxBubbleChars: clampInt(src.maxBubbleChars, DEFAULT_CHAT_STYLE.maxBubbleChars, 20, 2000),
    mergeShortChars: clampInt(src.mergeShortChars, DEFAULT_CHAT_STYLE.mergeShortChars, 0, 60),
    mergeCombinedChars: clampInt(src.mergeCombinedChars, DEFAULT_CHAT_STYLE.mergeCombinedChars, 10, 200),
    mergeJoiner: joiner,
    maxBubbles: clampInt(src.maxBubbles, DEFAULT_CHAT_STYLE.maxBubbles, 1, 8),
  };
}
