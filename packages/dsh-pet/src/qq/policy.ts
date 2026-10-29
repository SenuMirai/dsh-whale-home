/**
 * 群聊策略：什么时候回、回几条、什么时候自己开口、没人理怎么降温。
 *
 * ── 这里全是纯函数 + 一个可注入时钟/随机的状态机 ──
 * 群里的行为是这套系统最容易翻车的地方（话多、刷屏、被冷落还硬凑），所以判定逻辑
 * 必须能在测试里把时间拨来拨去地验证，而不是「上线看看」。所有函数都接受 `now`
 * 与 `random` 参数，默认值就是真实时钟与 Math.random。
 *
 * ── 三条用户明确要的行为 ──
 * 1. **有人聊天 → 主动搭话**：不是每条都插嘴。收到人类消息后开始「去抖窗口」，
 *    窗口结束才掷一次概率，避免一口气连回十条。
 * 2. **一次发一条或多条**：由 `burst.min/max` 控制，概率偏向短的那头（话痨不至于刷屏）。
 * 3. **冷场主动说，越没人理越久**：`firstDelayMs × growth^ignored`，封顶 `maxDelayMs`；
 *    **任何人说话就重置**（`resetOnHuman`）。
 */

import type { GroupPolicy, ProactiveConfig } from './config';
import type { GroupMessage } from './types';

/** 一个群的记忆/状态（只留调度需要的东西） */
export interface GroupState {
  groupId: string;
  /** 最近一次**人类**说话的时间 */
  lastHumanAt?: number;
  /** 最近一次她自己说话的时间（任何类型） */
  lastSelfAt?: number;
  /** 最近一次主动开口的时间 */
  lastProactiveAt?: number;
  /** 连续几次主动开口没人接 */
  ignoredProactive: number;
  /** 已排定的下一次主动开口时间（undefined = 还没排） */
  nextProactiveAt?: number;
  /** 最近的回复时间戳（10 分钟限流窗口用；只保留窗口内的） */
  replyTimes: number[];
  /** 当天主动开口次数（跨天清零） */
  proactiveDay: { day: string; count: number };
  /** 去抖窗口：第一句话到达后设定，窗口结束才决定要不要接 */
  pendingSince?: number;
  /** 窗口里攒了几个人类消息 */
  pendingCount: number;
}

/** 新建一个群状态 */
export function createGroupState(groupId: string): GroupState {
  return {
    groupId,
    ignoredProactive: 0,
    replyTimes: [],
    proactiveDay: { day: '', count: 0 },
    pendingCount: 0,
  };
}

/** 本地日期键（用于「一天最多几次」） */
export function dayKey(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 10 分钟限流窗口 */
export const RATE_WINDOW_MS = 10 * 60_000;

/**
 * 人类说了一句话之后，下一次主动开口要等多久。
 * @param proactive 配置
 * @param ignored 已经被无视了几次（0 = 刚有人理过）
 * @returns 毫秒；`ignored` 越大越久，封顶 `maxDelayMs`
 */
export function proactiveDelay(proactive: ProactiveConfig, ignored: number): number {
  const n = Math.max(0, Math.floor(ignored));
  const raw = proactive.firstDelayMs * Math.pow(proactive.growth, n);
  return Math.min(proactive.maxDelayMs, Math.max(0, Math.round(raw)));
}

/** 这次主动开口该说几条：**大多数时候一条**，偶尔多几条 */
export function planBurst(policy: GroupPolicy, random: () => number = Math.random): number {
  const min = Math.max(1, Math.round(policy.burst.min));
  const max = Math.max(min, Math.round(policy.burst.max));
  if (min === max) return min;
  // 平方偏置：random()² 让尾部的概率快速衰减。
  // 为什么不用「两次取最小」（三角分布）：实测下来 2 条反而最多（1 条只占 43%），
  // 与她「大多数时候一条、偶尔连发」的设定不符。平方偏置下 1 条占 50%、
  // 2 条 37%、3 条 13%——想调成更话痨就把指数调小。
  const biased = Math.pow(random(), 2);
  return min + Math.round(biased * (max - min));
}

/** 连发之间的间隔 */
export function burstGap(policy: GroupPolicy, random: () => number = Math.random): number {
  const [lo, hi] = policy.burst.gapMs;
  return lo + Math.round(random() * Math.max(0, hi - lo));
}

/**
 * 记录一条人类消息，并更新调度状态。
 *
 * 规则（按重要性排序）：
 * 1. 任何人类消息都刷新 `lastHumanAt`；
 * 2. 如果她上次是**主动开口**且之后没人说话，那么这条消息说明「有人接话了」→ 无视计数清零；
 *    即使没人接她、只是别的人在聊，也算「群里有活人」，同样清零（用户要求：有人说话就重置）；
 * 3. 重新排下一次主动开口（`resetOnHuman` 为真时按 0 次被无视算）。
 *
 * @returns 更新后的状态（原地修改并返回）
 */
export function observeHuman(
  state: GroupState,
  policy: GroupPolicy,
  now: number,
  options: { resetOnHuman?: boolean } = {},
): GroupState {
  const reset = options.resetOnHuman ?? policy.proactive.resetOnHuman;
  state.lastHumanAt = now;
  // 有人说话就算「群活着」：无论接的是不是她
  if (reset) state.ignoredProactive = 0;
  state.nextProactiveAt = now + proactiveDelay(policy.proactive, state.ignoredProactive);
  if (state.pendingSince === undefined) state.pendingSince = now;
  state.pendingCount += 1;
  return state;
}

/** 她开口之后的账：主动开口且是「这一轮最后一次」时调用，记一次可能被无视 */
export function noteSelfSpoke(
  state: GroupState,
  policy: GroupPolicy,
  now: number,
  kind: 'reply' | 'proactive',
): GroupState {
  state.lastSelfAt = now;
  state.replyTimes.push(now);
  // 只保留窗口内的，避免数组无限增长
  const cutoff = now - RATE_WINDOW_MS;
  state.replyTimes = state.replyTimes.filter((t) => t >= cutoff);

  if (kind === 'proactive') {
    state.lastProactiveAt = now;
    const day = dayKey(now);
    if (state.proactiveDay.day !== day) state.proactiveDay = { day, count: 0 };
    state.proactiveDay.count += 1;
    // 先按「这次也被无视」排下一次；真有人接话时 observeHuman 会把计数清零并重排
    state.ignoredProactive += 1;
    state.nextProactiveAt = now + proactiveDelay(policy.proactive, state.ignoredProactive);
  }
  return state;
}

/** 限流判定 */
export interface RateVerdict {
  allowed: boolean;
  /** 不允许时的原因（写日志用） */
  reason?: 'cooldown' | 'window-limit';
  /** 还要等多久（毫秒） */
  waitMs?: number;
}

/** 冷却与窗口限流：两条都过了才允许说话 */
export function rateVerdict(state: GroupState, policy: GroupPolicy, now: number): RateVerdict {
  if (state.lastSelfAt !== undefined) {
    const since = now - state.lastSelfAt;
    if (since < policy.cooldownMs) {
      return { allowed: false, reason: 'cooldown', waitMs: policy.cooldownMs - since };
    }
  }
  if (policy.maxRepliesPer10Min > 0) {
    const cutoff = now - RATE_WINDOW_MS;
    const recent = state.replyTimes.filter((t) => t >= cutoff).length;
    if (recent >= policy.maxRepliesPer10Min) {
      // 等到最早那条滑出窗口
      const oldest = state.replyTimes.filter((t) => t >= cutoff).sort((a, b) => a - b)[0];
      const waitMs = oldest === undefined ? policy.cooldownMs : oldest + RATE_WINDOW_MS - now;
      return { allowed: false, reason: 'window-limit', waitMs: Math.max(0, waitMs) };
    }
  }
  return { allowed: true };
}

/** 一条消息值不值得接 */
export type TriggerKind = 'at' | 'call' | 'chat' | 'none';

/**
 * 判断这条消息触发哪种反应。
 *
 * 优先级：被 @ > 叫名字 > （去抖窗口结束后的）闲聊插话。
 * @param botName 机器人在群里的名字（配置的 selfName，可以逗号分隔多个）
 */
export function classifyTrigger(message: GroupMessage, policy: GroupPolicy, botName: string): TriggerKind {
  if (!policy.enabled) return 'none';
  if (message.atSelf && policy.replyOnAt) return 'at';
  if (policy.replyOnName && mentionedByName(message.text, botName)) return 'call';
  if (policy.activeChat && message.text.trim() !== '') return 'chat';
  return 'none';
}

/** 文本里有没有叫到她的名字（支持多个名字，逗号/顿号/斜杠分隔） */
export function mentionedByName(text: string, botName: string): boolean {
  const names = botName
    .split(/[,，、/|\s]+/)
    .map((n) => n.trim())
    .filter((n) => n !== '');
  return names.some((name) => text.includes(name));
}

/** 去抖窗口：一个人说完一句，等这么久看还有没有人接着说（有就继续等） */
export const CHAT_DEBOUNCE_MS = 6_000;

/**
 * 去抖窗口是否已经结束（可以决定要不要插话了）。
 * 窗口内又有新消息 → `pendingSince` 被 observeHuman 保留原值？不——
 * 这里刻意用「第一句话的时间」而不是最后一句：否则群一直有人说话，她永远不接。
 * 窗口结束的语义是「这波人说话的开头已经过去 6 秒」，之后掷一次概率。
 */
export function chatWindowElapsed(state: GroupState, now: number): boolean {
  if (state.pendingSince === undefined) return false;
  return now - state.pendingSince >= CHAT_DEBOUNCE_MS;
}

/** 清掉去抖窗口（决定完就清，等下一次有人说话重新开窗） */
export function clearChatWindow(state: GroupState): void {
  state.pendingSince = undefined;
  state.pendingCount = 0;
}

/** 冷场判定结果 */
export interface ProactiveVerdict {
  fire: boolean;
  /** 不触发时的原因（诊断用） */
  reason?: 'disabled' | 'not-scheduled' | 'too-soon' | 'not-idle' | 'daily-cap' | 'cooldown' | 'busy';
  /** 还有多久（毫秒） */
  waitMs?: number;
}

/**
 * 现在该不该主动开口。
 *
 * 四道闸：开关 → 排定时间到没到 → 冷场够不够久 → 当天次数/冷却。
 * 「冷场够不够久」与「排定时间」是**两条不同的线**：前者防止在别人正聊天时插话，
 * 后者负责「越没人理越久」的退避。两条都过才开口。
 */
export function proactiveVerdict(
  state: GroupState,
  policy: GroupPolicy,
  now: number,
  options: { busy?: boolean } = {},
): ProactiveVerdict {
  const cfg = policy.proactive;
  if (!cfg.enabled) return { fire: false, reason: 'disabled' };
  if (!policy.enabled) return { fire: false, reason: 'disabled' };
  if (options.busy === true) return { fire: false, reason: 'busy' };

  // 从没人说过话的群不主动开口：那是冷启动，得先有人搭理才轮到它装熟
  if (state.lastHumanAt === undefined) return { fire: false, reason: 'not-scheduled' };

  // 冷场够不够久：这条闸要**先**判，它才是「现在能不能开口」的物理条件。
  // 排定时间只是「还要不要等更久」的退避，两者是两条独立的线。
  const idle = now - (state.lastHumanAt ?? now);
  if (idle < cfg.minIdleMs) {
    return { fire: false, reason: 'not-idle', waitMs: cfg.minIdleMs - idle };
  }

  if (state.nextProactiveAt === undefined) {
    const wait = proactiveDelay(cfg, state.ignoredProactive);
    return { fire: false, reason: 'not-scheduled', waitMs: wait };
  }
  const wait = state.nextProactiveAt - now;
  if (wait > 0) return { fire: false, reason: 'not-scheduled', waitMs: wait };

  const day = dayKey(now);
  const usedToday = state.proactiveDay.day === day ? state.proactiveDay.count : 0;
  if (cfg.maxPerDay > 0 && usedToday >= cfg.maxPerDay) {
    return { fire: false, reason: 'daily-cap' };
  }

  const rate = rateVerdict(state, policy, now);
  if (!rate.allowed) return { fire: false, reason: 'cooldown', waitMs: rate.waitMs };

  return { fire: true };
}

/** 下一次该在什么时候检查（用于定时器规划：避免每秒空转） */
export function nextWakeup(state: GroupState, policy: GroupPolicy, now: number): number | undefined {
  const candidates: number[] = [];
  if (state.nextProactiveAt !== undefined && policy.proactive.enabled) candidates.push(state.nextProactiveAt);
  if (state.pendingSince !== undefined) candidates.push(state.pendingSince + CHAT_DEBOUNCE_MS);
  if (state.lastSelfAt !== undefined) candidates.push(state.lastSelfAt + policy.cooldownMs);
  if (state.nextProactiveAt !== undefined && state.lastHumanAt !== undefined) {
    candidates.push(state.lastHumanAt + policy.proactive.minIdleMs);
  }
  const future = candidates.filter((t) => t > now);
  if (future.length === 0) return undefined;
  return Math.min(...future);
}
