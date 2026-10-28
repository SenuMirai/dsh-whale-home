/**
 * 安全防护：账号级出站闸门。
 *
 * ── 为什么单独一个模块 ────────────────────────────────────────────────
 * 原来每个群各算各的：冷却、10 分钟窗口、直接回复上限，全是「按群」的。
 * 但腾讯封号看的是**这个号**，不是「某个群里的这个号」。
 * 四个群各自「刚好没超」，合起来就是四倍。
 *
 * 所以这里做一本账号级总账：私聊、群聊、主动开口、说说，全部从同一个配额里扣。
 *
 * ── 设计前提（别写成内容审查）──────────────────────────────────────
 * 这套东西管的是「频率与时机」，不管她说什么、是什么性格。
 * 目标是让她**安全地自由**：少发、发得像人，而不是把话削平。
 * 任何在这里加「内容好坏判断」的改动都属于越界。
 *
 * ── 四段结构 ──────────────────────────────────────────────────────
 *   发送前  准入：配额够不够、是不是在静默期、内容形态有没有风险
 *   发送中  节奏：分条间隔随机抖动、按字数加打字延迟
 *   发送后  分类：这次失败是可恢复的，还是被拦了
 *   恢复    什么时候敢再开口
 */

/** 安全档位。默认 standard。 */
export type SafetyProfile = 'unlimited' | 'loose' | 'standard' | 'strict';

/** 经济档位：按谷时/峰时调收敛程度。和安全档位正交。 */
export type EconomyProfile = 'off' | 'balanced' | 'frugal';

export const SAFETY_PROFILE_LABEL: Record<SafetyProfile, string> = {
  unlimited: '无限制',
  loose: '宽松',
  standard: '标准',
  strict: '保守',
};

export const ECONOMY_PROFILE_LABEL: Record<EconomyProfile, string> = {
  off: '不看成本',
  balanced: '峰时收敛',
  frugal: '峰时只回应',
};

export type SafetySettings = {
  enabled: boolean;
  profile: SafetyProfile;
  economy: EconomyProfile;
  /** 疑似风控时私聊留一条通道，别把自己也闷死。 */
  privateExempt: boolean;

  // ── 频率与时机 ──
  /** 每分钟最多几条（0 = 不限） */
  globalPerMinute: number;
  /** 每小时最多几条（0 = 不限） */
  globalPerHour: number;
  /** 连续发这么多条之后…（0 = 不静默） */
  burstAfter: number;
  /** …强制静默几分钟 */
  burstSilenceMinutes: number;
  /** 深夜自动降频 */
  nightThrottle: boolean;
  /** 深夜降频起止小时（含起不含止） */
  nightStart: number;
  nightEnd: number;

  // ── 失败与恢复 ──
  /** 连续失败几次开始退避（0 = 不因失败退避） */
  failureThreshold: number;
  /** 触发后静默几分钟 */
  silenceMinutes: number;
  /** 识别到风控迹象立刻停手 */
  stopOnRiskSignal: boolean;

  // ── 行为拟人化（默认全 0：连发间隔本来就已经有随机抖动，见 policy.burstGapMs）──
  // 这几个是「额外再加一层」的旋钮，默认不开，免得多等一两秒把回复拖慢。
  /** 分条间隔随机下限（毫秒） */
  jitterMinMs: number;
  /** 分条间隔随机上限（毫秒） */
  jitterMaxMs: number;
  /** 每字额外延迟（毫秒），模拟打字 */
  typingPerCharMs: number;

  // ── 内容形态（只管形态，不管意思）──
  /** 拦住带链接的发言 */
  blockLinks: boolean;
  /** 拦住短时间内重复同一句 */
  blockRepeat: boolean;
  /** 「短时间」的窗口（分钟） */
  repeatWindowMinutes: number;

  // ── 账号健康 ──
  /** 健康探针间隔（分钟，0 = 关闭） */
  healthProbeMinutes: number;
  /** 每天给一次汇总 */
  dailySummary: boolean;

  // ── 谷时（经济档位用）──
  /** 谷时开始小时 */
  offPeakStart: number;
  /** 谷时结束小时 */
  offPeakEnd: number;
};

/** 各档位的具体阈值。切换档位 = 换这一整组数。 */
export const SAFETY_PRESETS: Record<SafetyProfile, Omit<SafetySettings, 'enabled' | 'profile' | 'economy' | 'privateExempt' | 'offPeakStart' | 'offPeakEnd' | 'nightStart' | 'nightEnd' | 'repeatWindowMinutes' | 'healthProbeMinutes' | 'dailySummary'>> = {
  unlimited: {
    globalPerMinute: 0,
    globalPerHour: 0,
    burstAfter: 0,
    burstSilenceMinutes: 0,
    nightThrottle: false,
    failureThreshold: 0,
    silenceMinutes: 0,
    stopOnRiskSignal: false,
    jitterMinMs: 0,
    jitterMaxMs: 0,
    typingPerCharMs: 0,
    blockLinks: false,
    blockRepeat: false,
  },
  loose: {
    globalPerMinute: 20,
    globalPerHour: 400,
    burstAfter: 15,
    burstSilenceMinutes: 3,
    nightThrottle: false,
    failureThreshold: 4,
    silenceMinutes: 5,
    stopOnRiskSignal: true,
    jitterMinMs: 0,
    jitterMaxMs: 0,
    typingPerCharMs: 0,
    blockLinks: false,
    blockRepeat: false,
  },
  standard: {
    globalPerMinute: 8,
    globalPerHour: 150,
    // 2026-10-28：6→10。6 句在一分钟的活跃群聊里太常见，判刷屏是误伤。
    burstAfter: 10,
    burstSilenceMinutes: 5,
    nightThrottle: true,
    failureThreshold: 2,
    silenceMinutes: 10,
    stopOnRiskSignal: true,
    jitterMinMs: 0,
    jitterMaxMs: 0,
    typingPerCharMs: 0,
    blockLinks: true,
    blockRepeat: true,
  },
  strict: {
    globalPerMinute: 3,
    globalPerHour: 60,
    burstAfter: 6,
    burstSilenceMinutes: 15,
    nightThrottle: true,
    failureThreshold: 2,
    silenceMinutes: 15,
    stopOnRiskSignal: true,
    jitterMinMs: 0,
    jitterMaxMs: 0,
    typingPerCharMs: 0,
    blockLinks: true,
    blockRepeat: true,
  },
};

/** 经济档位：峰时把配额乘这个系数，谷时乘那个。 */
export const ECONOMY_FACTORS: Record<EconomyProfile, { peak: number; offPeak: number }> = {
  off: { peak: 1, offPeak: 1 },
  balanced: { peak: 0.7, offPeak: 1.3 },
  frugal: { peak: 0.35, offPeak: 1.5 },
};

export const DEFAULT_SAFETY: SafetySettings = {
  enabled: true,
  profile: 'standard',
  economy: 'off',
  privateExempt: true,
  ...SAFETY_PRESETS.standard,
  nightStart: 1,
  nightEnd: 7,
  repeatWindowMinutes: 10,
  healthProbeMinutes: 60,
  dailySummary: true,
  offPeakStart: 0,
  offPeakEnd: 8,
};

/** 失败分类。分语义，不分重试次数。 */
export type FailureKind =
  | 'network'      // 网络抖动，可重试
  | 'timeout'      // 超时，可重试但只一次
  | 'risk'         // 被拦 / 被过滤，绝不重试
  | 'mute'         // 被禁言，别硬发
  | 'upload'       // 媒体上传失败，可重试
  | 'unknown';

const RISK_HINTS = ['风控', '风险', '频繁', '太快', 'too fast', 'frequency', 'filtered', '被过滤', '敏感', 'blocked'];
const MUTE_HINTS = ['禁言', 'muted', 'shutup', '被踢', 'kick'];
const NETWORK_HINTS = ['timeout', '超时', 'ECONNRESET', 'ETIMEDOUT', '网络', 'socket'];

/** 把一条错误文案/错误码分类。 */
export function classifyFailure(message: string, retcode?: number): FailureKind {
  const text = String(message ?? '').toLowerCase();
  if (MUTE_HINTS.some((h) => text.includes(h.toLowerCase()))) return 'mute';
  if (RISK_HINTS.some((h) => text.includes(h.toLowerCase()))) return 'risk';
  if (text.includes('upload') || text.includes('上传')) return 'upload';
  if (NETWORK_HINTS.some((h) => text.includes(h.toLowerCase()))) return 'network';
  // 腾讯侧常见的风控码段（正数小码多为业务拒绝）
  if (typeof retcode === 'number' && [1200, 1201, 1202].includes(retcode)) return 'risk';
  if (retcode === 1) return 'risk';
  return 'unknown';
}

/** 这类失败该不该重试。默认不重试。 */
export function isRetryable(kind: FailureKind): boolean {
  return kind === 'network' || kind === 'upload';
}

export type Blocked = {
  ok: false;
  /** 命中的规则 id，给界面显示用 */
  rule: string;
  /** 一句人话，说明为什么被拦、什么时候能再说 */
  reason: string;
  /** 解禁时间戳（毫秒）；0 表示需要人工干预 */
  until: number;
};

export type Allowed = {
  ok: true;
  /** 建议等多久再发（拟人化节奏） */
  delayMs: number;
};

export type Verdict = Allowed | Blocked;

export type SafetyStats = {
  sentLastMinute: number;
  sentLastHour: number;
  sentToday: number;
  consecutiveFailures: number;
  silencedUntil: number;
  lastBlock: { rule: string; reason: string; at: number } | null;
  blocksToday: { rule: string; count: number }[];
  profile: SafetyProfile;
  economy: EconomyProfile;
  isOffPeak: boolean;
};

const MINUTE = 60_000;
/** 同一句在窗口内出现几次算刷屏。3 次：说两遍是正常强调，第三遍才像复读。 */
const REPEAT_ALLOWED = 3;
const HOUR = 3_600_000;

/** 判断现在是不是谷时。 */
export function isOffPeak(now: number, startHour: number, endHour: number): boolean {
  const hour = new Date(now).getHours();
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/** 深夜时段。 */
function isNight(now: number, startHour: number, endHour: number): boolean {
  return isOffPeak(now, startHour, endHour);
}

/** 简单链接检测：http(s):// 或裸域名。只管形态。 */
export function looksLikeLink(text: string): boolean {
  return /https?:\/\//iu.test(text) || /\b[\w-]+\.(com|cn|net|org|io|me|xyz|top)\b/iu.test(text);
}

/**
 * 账号级出站闸门。
 *
 * 一个进程一个实例，所有发送路径共用。
 */
export class SafetyGuard {
  /** 最近一小时内的出站时间戳（升序）。 */
  private sent: number[] = [];
  /** 连续失败次数。一次成功清零。 */
  private failures = 0;
  /** 静默到什么时候。 */
  private silencedUntil = 0;
  /** 连续的短句（用于「连发 N 条后静默」）。 */
  private burst = 0;
  private burstLastAt = 0;
  /** 最近的发言文本，用于重复检测。 */
  private recent: { text: string; at: number }[] = [];
  /** 今日拦截统计。 */
  private blocks: { rule: string; at: number }[] = [];
  private lastBlock: { rule: string; reason: string; at: number } | null = null;

  private settings: SafetySettings;

  constructor(settings: SafetySettings) {
    this.settings = settings;
  }

  update(settings: SafetySettings): void {
    this.settings = settings;
  }

  /** 清空所有计数（人工「解除静默」用）。 */
  reset(): void {
    this.sent = [];
    this.failures = 0;
    this.silencedUntil = 0;
    this.burst = 0;
    this.blocks = [];
    this.lastBlock = null;
  }

  /** 有效配额：经济档位按谷峰缩放。 */
  private quota(now: number): { perMinute: number; perHour: number } {
    const s = this.settings;
    if (!s.enabled || s.profile === 'unlimited') return { perMinute: 0, perHour: 0 };
    const offPeak = isOffPeak(now, s.offPeakStart, s.offPeakEnd);
    const factor = ECONOMY_FACTORS[s.economy] ?? { peak: 1, offPeak: 1 };
    const k = offPeak ? factor.offPeak : factor.peak;
    const scale = (n: number) => (n <= 0 ? 0 : Math.max(1, Math.round(n * k)));
    return { perMinute: scale(s.globalPerMinute), perHour: scale(s.globalPerHour) };
  }

  private prune(now: number): void {
    const cut = now - HOUR;
    while (this.sent.length > 0 && this.sent[0]! < cut) this.sent.shift();
    const repeatCut = now - this.settings.repeatWindowMinutes * MINUTE;
    while (this.recent.length > 0 && this.recent[0]!.at < repeatCut) this.recent.shift();
    const dayStart = new Date(now).setHours(0, 0, 0, 0);
    while (this.blocks.length > 0 && this.blocks[0]!.at < dayStart) this.blocks.shift();
  }

  private block(rule: string, reason: string, until: number, now: number): Blocked {
    this.blocks.push({ rule, at: now });
    this.lastBlock = { rule, reason, at: now };
    return { ok: false, rule, reason, until };
  }

  /**
   * 发送前准入 + 节奏建议。
   *
   * @param text 要发的内容（只管形态：链接、重复）
   * @param options.isPrivate 私聊豁免用
   * @param options.now 注入时间，测试用
   */
  check(text: string, options: { isPrivate?: boolean; now?: number } = {}): Verdict {
    const now = options.now ?? Date.now();
    const s = this.settings;
    this.prune(now);

    if (!s.enabled || s.profile === 'unlimited') {
      return { ok: true, delayMs: 0 };
    }

    // ① 静默期：疑似风控时连私聊都要看一眼，除非开了私聊豁免
    if (this.silencedUntil > now) {
      const exempt = s.privateExempt && options.isPrivate === true;
      if (!exempt) {
        return this.block(
          'silence',
          `正在静默，${Math.ceil((this.silencedUntil - now) / MINUTE)} 分钟后才能再说话`,
          this.silencedUntil,
          now,
        );
      }
    }

    // ② 全局限流（账号级，所有出站共用）
    //
    // 2026-10-28 修：私聊不再受「每分钟」和「连发」两道闸。
    // 事故：主人和她一对一聊天，她连着说了 6 句（每句一个气泡），
    // 被 burst 判成刷屏 → 「歇 8 分钟」→ 后面的话全被丢掉，主人在 QQ 上
    // 只看到半截。和主人一对一说话本来就不是风险行为，腾讯也不会因此封号。
    // 群聊保留全部闸门；私聊只留「每小时」这一道兜底，防止失控。
    const isPrivateChat = options.isPrivate === true;
    const q = this.quota(now);
    if (q.perMinute > 0 && !isPrivateChat) {
      const lastMinute = this.sent.filter((t) => t > now - MINUTE).length;
      if (lastMinute >= q.perMinute) {
        const oldest = this.sent.find((t) => t > now - MINUTE) ?? now;
        const until = oldest + MINUTE;
        return this.block('rate-minute', `这一分钟已经发了 ${lastMinute} 条（上限 ${q.perMinute}），等一下`, until, now);
      }
    }
    if (q.perHour > 0) {
      if (this.sent.length >= q.perHour) {
        const until = this.sent[0]! + HOUR;
        return this.block('rate-hour', `这一小时已经发了 ${this.sent.length} 条（上限 ${q.perHour}），缓一缓`, until, now);
      }
    }

    // ③ 深夜降频（只对群；和主人一对一聊到几点都是正常事）
    if (!isPrivateChat && s.nightThrottle && isNight(now, s.nightStart, s.nightEnd)) {
      const nightCap = q.perMinute > 0 ? Math.max(1, Math.ceil(q.perMinute / 2)) : 0;
      if (nightCap > 0) {
        const lastMinute = this.sent.filter((t) => t > now - MINUTE).length;
        if (lastMinute >= nightCap) {
          return this.block('night', '深夜了，先少说两句', now + MINUTE, now);
        }
      }
    }

    // ④ 内容形态（只对群）。
    // 私聊不拦链接、不拦重复：跟主人说「晚安」说三次、发个链接给他看，
    // 都不是会被封号的行为。这两条是给群聊防「刷屏/外链」用的。
    if (!isPrivateChat) {
      if (s.blockLinks && looksLikeLink(text)) {
        return this.block('link', '这条带链接，容易被判成外链推广，先不发了', 0, now);
      }
      if (s.blockRepeat) {
        const same = this.recent.filter((r) => r.text === text.trim()).length;
        if (same >= REPEAT_ALLOWED) {
          return this.block('repeat', `这句在 ${s.repeatWindowMinutes} 分钟内已经说过 ${same} 次，不重复了`, 0, now);
        }
      }
    }

    // ⑤ 连发静默：连续说太多句，强制歇一会儿（只针对群聊，私聊不拦）
    if (!isPrivateChat && s.burstAfter > 0 && this.burst >= s.burstAfter) {
      const until = (this.burstLastAt || now) + s.burstSilenceMinutes * MINUTE;
      if (until > now) {
        this.burst = 0;
        this.silencedUntil = until;
        return this.block('burst', `连着说了 ${s.burstAfter} 句，歇 ${s.burstSilenceMinutes} 分钟`, until, now);
      }
    }

    // 节奏建议：抖动 + 按字数加延迟
    const delayMs = this.paceDelay(text, now);
    return { ok: true, delayMs };
  }

  /** 拟人化延迟。返回 0 表示不用等。 */
  private paceDelay(text: string, now: number): number {
    const s = this.settings;
    let base = 0;
    if (s.jitterMaxMs > 0) {
      const lo = Math.max(0, s.jitterMinMs);
      const hi = Math.max(lo, s.jitterMaxMs);
      base = lo + Math.random() * (hi - lo);
    }
    const typing = Math.max(0, s.typingPerCharMs) * Math.min(120, [...String(text ?? '')].length);
    return Math.round(base + typing);
  }

  /** 发送成功：记账。 */
  onSent(text: string, now = Date.now()): void {
    this.sent.push(now);
    this.failures = 0;
    const trimmed = String(text ?? '').trim().slice(0, 200);
    if (trimmed !== '') this.recent.push({ text: trimmed, at: now });
    // 注意：连发计数**不在这里**。
    //
    // 2026-10-28 事故：这里原来每发**一个气泡**就 +1，而她一条回复常常分成
    // 五个气泡。于是「连着说了 10 句」其实是两条正常回复，却被判成刷屏、
    // 静默 5 分钟——群里就彻底不接话了。连发该按**回复轮数**算，用 onReplied()。
  }

  /**
   * 一轮回复发出去了（不论几个气泡）——连发计数在这里 +1。
   *
   * 判定「她是不是在刷屏」要看她连回了多少人，不是看一条回复拆成几段。
   */
  onReplied(now = Date.now()): void {
    if (now - this.burstLastAt < MINUTE) this.burst += 1;
    else this.burst = 1;
    this.burstLastAt = now;
  }

  /**
   * 发送失败：分语义处置。
   * @returns 是否需要立刻停手
   */
  onFailed(kind: FailureKind, now = Date.now()): { stop: boolean; reason?: string } {
    const s = this.settings;
    if (!s.enabled || s.profile === 'unlimited') return { stop: false };

    if (kind === 'risk' || kind === 'mute') {
      if (s.stopOnRiskSignal) {
        this.silencedUntil = now + s.silenceMinutes * MINUTE;
        this.lastBlock = { rule: `failure-${kind}`, reason: kind === 'mute' ? '被禁言了，先停手' : '疑似被风控拦下，先停手', at: now };
        return { stop: true, reason: this.lastBlock.reason };
      }
      return { stop: false };
    }

    this.failures += 1;
    if (s.failureThreshold > 0 && this.failures >= s.failureThreshold) {
      this.silencedUntil = now + s.silenceMinutes * MINUTE;
      this.lastBlock = { rule: 'failure-backoff', reason: `连续失败 ${this.failures} 次，静默 ${s.silenceMinutes} 分钟`, at: now };
      return { stop: true, reason: this.lastBlock.reason };
    }
    return { stop: false };
  }

  stats(now = Date.now()): SafetyStats {
    this.prune(now);
    const dayStart = new Date(now).setHours(0, 0, 0, 0);
    const byRule = new Map<string, number>();
    for (const b of this.blocks) byRule.set(b.rule, (byRule.get(b.rule) ?? 0) + 1);
    return {
      sentLastMinute: this.sent.filter((t) => t > now - MINUTE).length,
      sentLastHour: this.sent.length,
      sentToday: this.sent.filter((t) => t >= dayStart).length,
      consecutiveFailures: this.failures,
      silencedUntil: this.silencedUntil > now ? this.silencedUntil : 0,
      lastBlock: this.lastBlock,
      blocksToday: [...byRule.entries()].map(([rule, count]) => ({ rule, count })),
      profile: this.settings.profile,
      economy: this.settings.economy,
      isOffPeak: isOffPeak(now, this.settings.offPeakStart, this.settings.offPeakEnd),
    };
  }
}
