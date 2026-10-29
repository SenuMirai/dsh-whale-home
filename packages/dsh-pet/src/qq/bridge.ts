/**
 * 群聊编排：把「事件 → 策略 → 模型 → 语音/唱歌 → 发出去」这一整条链路焊起来。
 *
 * ── 职责边界 ──
 * - `onebot.ts` 只管连上、收发、重连；
 * - `policy.ts` 只管什么时候该说话（纯函数，可测）；
 * - `llm.ts` / `tts.ts` / `sing.ts` 只管各自的生成；
 * - **本文件是唯一把它们串起来的地方**。宿主内的插件路由、云端 CLI 都调用它，
 *   不存在「第二套编排逻辑」。
 *
 * ── 一次回复的完整流程 ──
 * ```
 * 收到群消息
 *   → 解析（@我？叫我名字？普通聊天？）           onebot.parseMessage
 *   → 策略判定（开关/冷却/限流/去抖窗口）          policy.*
 *   → 组装提示词（人设 + 群上下文 + 场合）         prompt.groupSystemPrompt
 *   → 模型生成 { messages, action }              llm.parseReplyPlan
 *   → 按 action 处理：
 *       text  → 逐条发送
 *       voice → TTS 合成 → 发 record 段
 *       sing  → 乐谱 → 渲染 → 混音 → 发 record 段
 *   → 记账（记忆 + 调度状态 + 统计）
 * ```
 *
 * ── 失败了怎么办 ──
 * **不静默**。生成失败就不发（群里不该出现「抱歉我出错了」这种机器人腔），
 * 但日志里必须有原因，`onError` 回调也会带出去——面板与主人私聊都能看到。
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { policyFor, type GroupPolicy, type QqConfig } from './config';
import { createOpenAiClient, parseReplyPlan, type ChatClient } from './llm';
import { appendTurn, groupMemory, readMemoryFile, recentTurns, transcript, writeMemoryFile } from './memory';
import { OneBotClient, asId, parseMessage } from './onebot';
import {
  CHAT_DEBOUNCE_MS,
  burstGap,
  chatWindowElapsed,
  classifyTrigger,
  clearChatWindow,
  createGroupState,
  nextWakeup,
  noteSelfSpoke,
  observeHuman,
  proactiveVerdict,
  rateVerdict,
  type GroupState,
} from './policy';
import { groupSystemPrompt, ownerHelp, parseOwnerCommand, type SpeakMode } from './prompt';
import { builtinTitles, findBuiltinScore, parseScore, type Score } from '../sound/score';
import { resolveBackend } from '../sound/sing';
import { encodeWave } from '../sound/wav';
import { Speaker, describeFailure } from '../sound/tts';
import type { GroupMessage, ObEvent, ObGroupMessageEvent, ObPrivateMessageEvent, ObSegment, QqAction, SendResult } from './types';

/** 群上下文带多少条给模型（1 条 = 一句） */
const CONTEXT_TURNS = 24;

/** 一个群最多同时渲染几首歌（防止点歌刷屏把 CPU 打满） */
const MAX_CONCURRENT_SING = 1;

/** 编排层依赖的服务（宿主与云端各自注入） */
export interface BridgeDeps {
  config: QqConfig;
  /** 插件用户目录（$DSH_HOME/dsh-whale-girl） */
  userRoot: string;
  /** 人设读取（宿主传现有的 readPersonaOverride；云端读 persona.json） */
  persona: () => string;
  /** 日志 */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** 生成客户端；不传就用 config.llm 自建一个 OpenAI 兼容客户端 */
  llm?: ChatClient;
  /** 时间背景（宿主传 timeContextOf(new Date())；云端自建一份） */
  timeContext?: () => string;
  /** 出错通知（宿主：写日志 + 可选推给主人；云端：写日志） */
  onError?: (message: string) => void;
  /** 状态变化（宿主推 SSE / 云端打印） */
  onState?: () => void;
}

/** 启动结果 */
export type StartResult = { ok: true } | { ok: false; reason: string; message: string };

/** 一个群的运行时统计（面板用） */
export interface RuntimeStats {
  groupId: string;
  name?: string;
  received: number;
  replied: number;
  lastMessageAt?: number;
  lastReplyAt?: number;
  nextProactiveAt?: number;
  state: GroupState;
}

/**
 * QQ 群桥。
 *
 * 生命周期：`start()` → 连 NapCat、挂事件 → `stop()` 收尾。
 * 所有对外动作都从 `handleGroupMessage` / `handleOwnerMessage` 进来，**没有别的入口**。
 */
export class QqBridge {
  private readonly deps: BridgeDeps;
  private config: QqConfig;
  private client: OneBotClient | undefined;
  private llm: ChatClient;
  private speaker: Speaker | undefined;
  private readonly states = new Map<string, GroupState>();
  private readonly stats = new Map<string, RuntimeStats>();
  private memory = readMemoryFile('').memory;
  private memoryPath = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  /** 正在处理中的群（同一个群不并发回复） */
  private readonly busy = new Set<string>();
  /** 全局静音（主人私聊控制） */
  private muted = false;
  /**
   * 「群主/管理员」的 QQ 号集合（没配 ownerQq 时用来认主人）。
   *
   * 为什么存起来而不是每次现查：群成员列表要额外调接口（`get_group_member_list`），
   * 而消息事件里**本来就带 `sender.role`**——顺手记下就行，零额外请求。
   */
  private readonly ownerCandidates = new Set<string>();
  private singsInFlight = 0;
  private lastError: string | undefined;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
    this.config = deps.config;
    this.llm = deps.llm ?? createOpenAiClient(this.config.llm);
  }

  /** 当前状态快照（面板/HTTP 接口用；不含任何聊天内容） */
  snapshot(): {
    running: boolean;
    muted: boolean;
    link: unknown;
    selfQq: string;
    llm: string;
    groups: Array<{ groupId: string; name?: string; received: number; replied: number; nextProactiveAt?: number; enabled: boolean }>;
    lastError?: string;
  } {
    const groups = [...this.stats.values()].map((stat) => ({
      groupId: stat.groupId,
      ...(stat.name === undefined ? {} : { name: stat.name }),
      received: stat.received,
      replied: stat.replied,
      ...(stat.state.nextProactiveAt === undefined ? {} : { nextProactiveAt: stat.state.nextProactiveAt }),
      enabled: this.policyOf(stat.groupId).enabled,
    }));
    return {
      running: this.running,
      muted: this.muted,
      link: this.client?.linkState ?? { status: 'idle' },
      selfQq: this.client?.selfQq ?? '',
      llm: this.llm.label,
      groups,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }

  /** 启动：连 OneBot、加载记忆、开始调度 */
  async start(): Promise<StartResult> {
    if (this.running) return { ok: true };
    if (!this.config.enabled) {
      return { ok: false, reason: 'disabled', message: 'QQ 群接入没有启用（qq.json 的 enabled 为 false）' };
    }
    if (process.versions.node !== undefined) {
      const major = Number(process.versions.node.split('.')[0] ?? 0);
      const minor = Number(process.versions.node.split('.')[1] ?? 0);
      if (major < 22 || (major === 22 && minor < 4)) {
        return {
          ok: false,
          reason: 'node-too-old',
          message: `需要 Node ≥ 22.4（内置 WebSocket），当前 ${process.versions.node}`,
        };
      }
    }

    this.memoryPath = join(this.deps.userRoot, 'qq-memory.json');
    const loaded = readMemoryFile(this.memoryPath);
    this.memory = loaded.memory;
    if (loaded.problem !== undefined) this.log('warn', loaded.problem);

    this.speaker = new Speaker({
      userRoot: this.deps.userRoot,
      cache: {
        dir: this.config.tts.cacheDir !== '' ? this.config.tts.cacheDir : join(this.deps.userRoot, 'cache', 'tts'),
      },
      ...(this.config.tts.pythonPath === '' ? {} : { ffmpeg: undefined }),
    });

    this.client = new OneBotClient({
      url: this.config.url,
      httpUrl: this.config.httpUrl,
      token: this.config.token,
      log: (level, message) => this.log(level, message),
    });
    this.client.on('state', () => this.deps.onState?.());
    this.client.on('event', (event: ObEvent) => {
      void this.onEvent(event);
    });
    this.client.on('error', (message: string) => this.recordError(message));

    this.running = true;
    this.client.connect();
    this.scheduleTick();
    this.deps.onState?.();
    this.log('info', `QQ 群桥已启动：${this.config.url}（模式 ${this.config.mode}）`);
    return { ok: true };
  }

  /** 停止：断开连接、清定时器 */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const client = this.client;
    this.client = undefined;
    if (client !== undefined) await client.close();
    this.deps.onState?.();
    this.log('info', 'QQ 群桥已停止');
  }

  /** 主人私聊来的指令（不在群里做任何回应） */
  async handleOwnerMessage(text: string): Promise<string> {
    const command = parseOwnerCommand(text);
    switch (command.kind) {
      case 'status': {
        const snap = this.snapshot();
        const link = snap.link as { status?: string; selfId?: string };
        const lines = [
          `连接：${link.status ?? '未知'}${link.selfId !== undefined && link.selfId !== '' ? `（${link.selfId}）` : ''}`,
          `模型：${snap.llm}`,
          `静音：${snap.muted ? '是' : '否'}`,
          `群数：${snap.groups.length}`,
        ];
        for (const group of snap.groups.slice(0, 10)) {
          lines.push(`· ${group.groupId}${group.name === undefined ? '' : ` ${group.name}`}：收 ${group.received} / 回 ${group.replied}${group.enabled ? '' : '（关闭）'}`);
        }
        if (snap.lastError !== undefined) lines.push(`最后错误：${snap.lastError}`);
        return lines.join('\n');
      }
      case 'groups': {
        // 拉真实的群列表：主人不清楚群号时，用这个比翻 QQ 设置快
        const result = await this.listGroups();
        if (!result.ok) return `拉群列表失败：${result.message}`;
        if (result.groups.length === 0) return '这个号一个群都没加。把机器人拉进群之后再发「群列表」。';
        const lines = ['我所在的群：'];
        for (const group of result.groups) {
          const enabled = this.policyOf(group.groupId).enabled;
          lines.push(`· ${group.groupId} ${group.name}${enabled ? '' : '（未启用）'}`);
        }
        lines.push('', '要让某个群能聊，把它加到 qq.json 的 groups 里并把 enabled 设成 true。');
        return lines.join('\n');
      }
      case 'mute':
        this.muted = true;
        return '已全局静音，群里不再说话（私聊仍可下指令）';
      case 'unmute':
        this.muted = false;
        return '已取消静音';
      case 'pause': {
        const policy = this.policyOf(command.groupId);
        policy.enabled = false;
        this.config.groups[command.groupId] = policy;
        return `群 ${command.groupId} 已暂停（仅本次运行有效，要永久生效请改 qq.json）`;
      }
      case 'resume': {
        const policy = this.policyOf(command.groupId);
        policy.enabled = true;
        this.config.groups[command.groupId] = policy;
        return `群 ${command.groupId} 已恢复`;
      }
      case 'say': {
        const result = await this.sendSegments(command.groupId, [{ type: 'text', data: { text: command.text } }]);
        return result.ok ? `已发到群 ${command.groupId}` : `发送失败：${result.message}`;
      }
      case 'sing': {
        const result = await this.singInGroup(command.groupId, command.song);
        return result.ok ? `已在群 ${command.groupId} 唱完` : `唱歌失败：${result.message}`;
      }
      case 'help':
        return ownerHelp(this.config.selfName);
      case 'unknown':
        return `没听懂这条指令：${command.raw.slice(0, 40)}。发「帮助」看能做什么。`;
      default:
        return '未知指令';
    }
  }

  /** 事件入口（WS 上报与 HTTP POST 上报共用） */
  async onEvent(event: ObEvent): Promise<void> {
    if (event.post_type === 'message') {
      if ((event as ObGroupMessageEvent).message_type === 'group') {
        await this.handleGroupMessage(event as ObGroupMessageEvent);
        return;
      }
      if ((event as ObPrivateMessageEvent).message_type === 'private') {
        await this.handlePrivateMessage(event as ObPrivateMessageEvent);
      }
    }
  }

  /** 私聊：只认主人，其它人一律不理（也不回复，避免被当成客服） */
  private async handlePrivateMessage(event: ObPrivateMessageEvent): Promise<void> {
    const userId = asId(event.user_id);
    const selfId = this.client?.selfQq ?? '';
    if (userId === selfId) return;
    if (!this.isOwner(userId)) {
      this.log('debug', `忽略非主人私聊 from=${userId}`);
      return;
    }
    const parsed = parseMessage(event.message, selfId);
    if (parsed.text.trim() === '') return;
    try {
      const reply = await this.handleOwnerMessage(parsed.text);
      await this.sendPrivate(userId, [{ type: 'text', data: { text: reply } }]);
    } catch (e) {
      this.recordError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 这个人算不算「主人」。
   *
   * 两条路，任一条成立就是：
   *   1. 配置里写了 `ownerQq` 且对得上（最明确）；
   *   2. **在群里当过群主或管理员**——这条是为了省掉「主人得先去查自己 QQ 号」这一步。
   *      毕竟群主就主人一个，机器人被拉进哪个群，那个群的群主就是他。
   *
   * 第 2 条会带来一个必须接受的后果：**别人自己拉一个群、自己当群主、把机器人拉进去**，
   * 那个人就拿到了管理权限（能私聊 `暂停`/`静音`/`说`）。
   * 但注意：这些指令的杀伤范围只有「那个群」和「全局静音」——没有删除数据、没有改配置、
   * 没有对外发言（`说` 只能发到他自己管的那个群）。
   * 如果哪天觉得这条太宽，填上 `ownerQq` 就把路 2 关掉了（见下）。
   */
  private isOwner(userId: string): boolean {
    const configured = this.config.ownerQq.trim();
    if (configured !== '') return userId === configured;
    // 没配 ownerQq 时才放开「见过的群主/管理员」
    return this.ownerCandidates.has(userId);
  }

  /** 群消息：解析 → 记账 → 判定 → 行动 */
  private async handleGroupMessage(event: ObGroupMessageEvent): Promise<void> {
    const selfId = asId(event.self_id) || this.client?.selfQq || '';
    const groupId = asId(event.group_id);
    const userId = asId(event.user_id);
    if (groupId === '' || userId === '' || userId === selfId) return;

    // 顺手记住群主/管理员：没配 ownerQq 时靠这个认出「主人」。
    // 放在 enabled 判断**之前**：即使这个群暂时关着也能学到谁是管理员，
    // 否则「先关着观察两天再开」的用法里，主人始终发不了指令。
    const senderRole = String(event.sender?.role ?? 'member');
    if (senderRole === 'owner' || senderRole === 'admin') {
      this.ownerCandidates.add(userId);
    }

    const policy = this.policyOf(groupId);
    if (!policy.enabled) {
      // 没开的群连统计都不记：不收集没在用的群的消息
      return;
    }

    const parsed = parseMessage(event.message, selfId);
    const sender = event.sender ?? {};
    const name = String(sender.card !== undefined && sender.card !== '' ? sender.card : (sender.nickname ?? userId));
    const message: GroupMessage = {
      groupId,
      userId,
      name,
      role: senderRole,
      text: parsed.text,
      atSelf: parsed.atSelf,
      callSelf: parsed.text.includes(this.config.selfName),
      atAll: parsed.atAll,
      at: (event.time === undefined ? Date.now() : Number(event.time) * 1000) || Date.now(),
      messageId: asId(event.message_id),
      hasImage: parsed.hasImage,
      images: parsed.images.slice(0, 2),
      hasVoice: parsed.hasVoice,
    };

    const now = Date.now();
    const state = this.stateOf(groupId);
    const stat = this.statOf(groupId);
    stat.received += 1;
    stat.lastMessageAt = now;

    if (message.text.trim() !== '') {
      appendTurn(this.memory, groupId, { role: 'user', name, text: message.text.slice(0, 500), ts: now });
      this.persistMemory();
    }

    // 人类说话 → 刷新冷场计时（并重排下一次主动开口）
    observeHuman(state, policy, now);
    this.deps.onState?.();

    if (this.muted) {
      this.log('debug', '全局静音中，只记账不说话');
      return;
    }

    const trigger = classifyTrigger(message, policy, this.config.selfName);
    if (trigger === 'none') return;

    // @ 与叫名字：立刻回（不受去抖窗口影响，但受冷却/限流约束）
    // 「叫名字」在提示词里与 @ 同一档：都是明确的「在跟你说话」
    if (trigger === 'at' || trigger === 'call') {
      clearChatWindow(state);
      await this.replyTo(groupId, policy, message, 'at', now);
      return;
    }

    // 普通聊天：等去抖窗口结束再掷概率（见 policy.chatWindowElapsed 的注释）
    this.log('debug', `群 ${groupId} 有闲聊，等去抖窗口后决定是否插话`);
    this.scheduleTick();
  }

  /**
   * 回一条消息（@ / 叫名字 / 抽中插话 / 主动开口）。
   * @param mode 'at' | 'chat' | 'proactive'
   */
  private async replyTo(
    groupId: string,
    policy: GroupPolicy,
    message: GroupMessage | undefined,
    mode: SpeakMode,
    now: number,
  ): Promise<void> {
    if (this.busy.has(groupId)) {
      this.log('debug', `群 ${groupId} 正在回复中，跳过这次`);
      return;
    }
    const state = this.stateOf(groupId);
    const verdict = rateVerdict(state, policy, now);
    if (!verdict.allowed) {
      this.log('info', `群 ${groupId} 触发${mode}，但被${verdict.reason === 'cooldown' ? '冷却' : '频率限制'}挡住（还要等 ${Math.ceil((verdict.waitMs ?? 0) / 1000)} 秒）`);
      return;
    }

    this.busy.add(groupId);
    try {
      const group = groupMemory(this.memory, groupId);
      const turns = recentTurns(group, CONTEXT_TURNS);
      const system = groupSystemPrompt({
        persona: this.deps.persona(),
        selfName: this.config.selfName,
        mode,
        transcript: transcript(turns, this.config.selfName, now),
        ...(message === undefined || message.text === '' ? {} : { incoming: `${message.name}：${message.text}` }),
        burstRange: [policy.burst.min, policy.burst.max],
        allowVoice: policy.voiceChance > 0,
        allowSing: policy.singOnRequest,
        timeContext: this.deps.timeContext?.(),
        hasImage: message?.hasImage === true,
      });

      const result = await this.llm.chat(
        [
          { role: 'system', content: system },
          {
            role: 'user',
            content:
              mode === 'proactive'
                ? '（现在群里安静了一会儿，你主动说点什么。）'
                : message === undefined
                  ? '（说点什么。）'
                  : `${message.name}：${message.text}`,
          },
        ],
        { maxTokens: Math.min(600, Math.max(120, 60 * policy.burst.max)) },
      );
      if (!result.ok) {
        this.recordError(`生成失败（${result.reason}）：${result.message}`);
        return;
      }

      const plan = parseReplyPlanSafe(result.text, policy);
      if (plan.messages.length === 0) {
        this.recordError('模型没有产出可发送的消息（回复为空）');
        return;
      }

      const sentCount = await this.deliver(groupId, policy, plan, now, mode);
      if (sentCount > 0) {
        const stat = this.statOf(groupId);
        stat.replied += sentCount;
        stat.lastReplyAt = Date.now();
        noteSelfSpoke(state, policy, Date.now(), mode === 'proactive' ? 'proactive' : 'reply');
        if (mode === 'proactive') {
          this.log('info', `群 ${groupId} 主动开口（第 ${state.ignoredProactive} 次之后，下次窗口 ${Math.round(((state.nextProactiveAt ?? 0) - Date.now()) / 60000)} 分钟）`);
        }
      }
    } catch (e) {
      this.recordError(`回复流程异常：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.busy.delete(groupId);
      this.deps.onState?.();
      this.scheduleTick();
    }
  }

  /** 把计划变成实际发出的消息；返回成功条数 */
  private async deliver(
    groupId: string,
    policy: GroupPolicy,
    plan: { messages: string[]; action: 'text' | 'voice' | 'sing'; song?: string },
    now: number,
    mode: SpeakMode,
  ): Promise<number> {
    // 唱歌优先级最高：整段是一条语音，不用连发
    if (plan.action === 'sing' && policy.singOnRequest) {
      const sung = await this.singInGroup(groupId, plan.song);
      if (sung.ok) {
        this.appendAssistant(groupId, `（唱了一首：${plan.song ?? '即兴'}）`, now);
        return 1;
      }
      this.log('warn', `唱歌失败，改用文字：${sung.message}`);
    }

    // 语音：把这几条连起来念（单独发一条 record，文字仍按条发）
    if (plan.action === 'voice' && policy.voiceChance > 0) {
      const text = plan.messages.join('，');
      const voiceOk = await this.speakInGroup(groupId, text);
      if (voiceOk) {
        this.appendAssistant(groupId, text, now);
        return 1;
      }
      this.log('warn', '语音发送失败，退回文字');
    }

    // 文字：按连发配置发（模型给的条数优先，但不超过策略上限）
    const limit = Math.max(1, policy.burst.max);
    const messages = plan.messages.slice(0, limit);
    let sent = 0;
    for (const [index, text] of messages.entries()) {
      if (index > 0) {
        const gap = burstGap(policy);
        this.log('debug', `连发间隔 ${gap} ms`);
        await new Promise<void>((resolve) => setTimeout(resolve, gap));
      }
      const result = await this.sendSegments(groupId, [{ type: 'text', data: { text } }]);
      if (!result.ok) {
        this.log('warn', `发送失败（${result.reason}）：${result.message}`);
        break;
      }
      sent += 1;
      this.appendAssistant(groupId, text, Date.now());
      if (mode === 'proactive') break; // 主动开口只发一条，不连发
    }
    return sent;
  }

  /** 在群里说一段话（语音） */
  private async speakInGroup(groupId: string, text: string): Promise<boolean> {
    const speaker = this.speaker;
    if (speaker === undefined) return false;
    const tts = this.config.tts;
    const result = await speaker.speak(text, {
      voice: tts.voice,
      rate: tts.rate,
      pitch: tts.pitch,
      volume: tts.volume,
    });
    if (!result.ok) {
      this.recordError(`语音合成失败：${describeFailure(result)}`);
      return false;
    }
    // QQ 的 record 段：NapCat 会用内置 ffmpeg 把 WAV 转成 silk
    const path = this.audioPath(`voice-${Date.now()}.wav`);
    try {
      writeFileSync(path, encodeWave(result.pcm));
    } catch (e) {
      this.recordError(`音频落盘失败：${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    const sent = await this.sendSegments(groupId, [{ type: 'record', data: { file: path } }]);
    if (!sent.ok) {
      this.log('warn', `语音发送失败（${sent.reason}）：${sent.message}`);
      return false;
    }
    return true;
  }

  /** 在群里唱一首（A 档：TTS 声线 + 音高校准 + 混音） */
  private async singInGroup(groupId: string, song: string | undefined): Promise<SendResult> {
    if (this.singsInFlight >= MAX_CONCURRENT_SING) {
      return { ok: false, reason: 'rate-limited', message: '上一个点歌还在合成，稍等' };
    }
    const score = this.resolveScore(song);
    if (score === undefined) {
      return {
        ok: false,
        reason: 'error',
        message: song === undefined ? '没指定唱什么。会唱：' + builtinTitles().join('、') : `没有这首歌：${song}`,
      };
    }
    const speaker = this.speaker;
    if (speaker === undefined) return { ok: false, reason: 'not-connected', message: '语音服务未就绪' };

    const { backend, warning } = resolveBackend(this.config.sing.backend);
    if (warning !== undefined) this.log('warn', warning);

    this.singsInFlight += 1;
    try {
      const rendered = await backend.render(
        score,
        {
          label: `edge-tts:${this.config.tts.voice}`,
          speak: async (text: string) => {
            const result = await speaker.speak(text, {
              voice: this.config.tts.voice,
              rate: this.config.tts.rate,
            });
            if (!result.ok) return { ok: false as const, reason: result.reason, message: describeFailure(result) };
            return { ok: true as const, audio: result.pcm };
          },
        },
        {
          transpose: this.config.sing.transpose,
          mix: this.config.sing.mix,
          ...(this.config.sing.voicebankDir === '' ? {} : { voicebankDir: this.config.sing.voicebankDir }),
          ...(this.config.sing.rvcModel === '' ? {} : { rvcModel: this.config.sing.rvcModel }),
          onProgress: (done, total) => {
            if (done % 8 === 0 || done === total) this.log('debug', `唱歌渲染 ${done}/${total}`);
          },
        },
      );
      if (!rendered.ok) {
        this.recordError(`唱歌失败（${rendered.reason}）：${rendered.message}`);
        return { ok: false, reason: 'error', message: rendered.message };
      }

      const path = this.audioPath(`sing-${Date.now()}.wav`);
      writeFileSync(path, rendered.wav);
      this.log(
        'info',
        `唱歌完成：${score.title}，${rendered.report.duration.toFixed(1)} 秒，${rendered.report.notes} 个音`,
      );
      return await this.sendSegments(groupId, [
        { type: 'text', data: { text: `♪ ${score.title}` } },
        { type: 'record', data: { file: path } },
      ]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.recordError(`唱歌异常：${message}`);
      return { ok: false, reason: 'error', message };
    } finally {
      this.singsInFlight -= 1;
    }
  }

  /** 找乐谱：内置优先，其次 scoreDir 下的同名文件 */  private resolveScore(song: string | undefined): Score | undefined {
    const wanted = (song ?? '').trim();
    if (wanted !== '') {
      const builtin = findBuiltinScore(wanted);
      if (builtin !== undefined) return builtin;
    }
    if (this.config.sing.scoreDir !== '') {
      const dir = this.config.sing.scoreDir;
      try {
        const files = readdirSync(dir).filter((file) => file.endsWith('.json'));
        const lowered = wanted.toLowerCase();
        const hit = files.find((file) => lowered !== '' && file.toLowerCase().includes(lowered)) ?? (wanted === '' ? files[0] : undefined);
        if (hit !== undefined) {
          const parsed = parseScore(JSON.parse(readFileSync(join(dir, hit), 'utf8').replace(/^\uFEFF/, '')));
          if (parsed.ok) return parsed.score;
          this.log('warn', `乐谱 ${hit} 解析失败：${parsed.reason}`);
        }
      } catch (e) {
        this.log('warn', `读乐谱目录失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (wanted === '') {
      // 没指定：随机来一首内置的（固定取「小星星」，避免同一晚总唱同一首时没变化——随机在这里没意义）
      return findBuiltinScore('小星星');
    }
    return undefined;
  }

  /** 发消息段（自动分段：QQ 单条上限约 4500 字节，长文本要拆） */
  private async sendSegments(groupId: string, segments: ObSegment[]): Promise<SendResult> {
    const client = this.client;
    if (client === undefined) return { ok: false, reason: 'not-connected', message: 'QQ 连接未建立' };
    return client.sendGroupMsg(groupId, segments);
  }

  /** 发私聊 */
  private async sendPrivate(userId: string, segments: ObSegment[]): Promise<SendResult> {
    const client = this.client;
    if (client === undefined) return { ok: false, reason: 'not-connected', message: 'QQ 连接未建立' };
    return client.sendPrivateMsg(userId, segments);
  }

  /**
   * 拉机器人所在的群列表（`get_group_list`）。
   *
   * 为什么需要它：主人第一次配 qq.json 时得填群号，而群号在 QQ 客户端里要翻好几层才看得到。
   * 有了这个，直接私聊「群列表」就行，复制粘贴即可。
   *
   * 注意：NapCat 的 `get_group_list` 返回的是**机器人加入的全部群**，
   * 与 qq.json 里配置的群是两回事（后者决定"哪些群允许说话"）。
   */
  private async listGroups(): Promise<
    { ok: true; groups: Array<{ groupId: string; name: string }> } | { ok: false; message: string }
  > {
    const client = this.client;
    if (client === undefined) return { ok: false, message: 'QQ 连接未建立' };
    const response = await client.call('get_group_list');
    if (response.status !== 'ok') {
      return { ok: false, message: response.message ?? `接口返回 ${response.status ?? '失败'}` };
    }
    const data = response.data;
    if (!Array.isArray(data)) return { ok: false, message: '返回里没有群列表（data 不是数组）' };
    const groups = data
      .map((item) => {
        const record = item as { group_id?: unknown; group_name?: unknown };
        const groupId = asId(record.group_id);
        const name = typeof record.group_name === 'string' ? record.group_name : '（无名）';
        return { groupId, name };
      })
      .filter((group) => group.groupId !== '');
    return { ok: true, groups };
  }

  /** 定时巡检：去抖窗口到点、冷场到点、冷却结束 */
  private scheduleTick(): void {
    if (!this.running || this.timer !== undefined) return;
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const [groupId, state] of this.states) {
      const policy = this.policyOf(groupId);
      if (!policy.enabled) continue;
      const wake = nextWakeup(state, policy, now);
      if (wake !== undefined) next = Math.min(next, wake);
      // 去抖窗口到点 → 掷概率决定插不插话
      if (chatWindowElapsed(state, now) && !this.busy.has(groupId) && !this.muted) {
        clearChatWindow(state);
        if (Math.random() < policy.replyChance) {
          void this.replyTo(groupId, policy, undefined, 'chat', now);
        }
      }
      // 冷场 → 主动开口
      const verdict = proactiveVerdict(state, policy, now, { busy: this.busy.has(groupId) });
      if (verdict.fire) {
        void this.replyTo(groupId, policy, undefined, 'proactive', now);
      }
    }
    const delay = Math.max(250, Math.min(30_000, Number.isFinite(next) ? next - now : 30_000));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scheduleTick();
    }, delay);
    // 定时器不该阻止进程退出
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** 取（或建）群状态 */
  private stateOf(groupId: string): GroupState {
    const found = this.states.get(groupId);
    if (found !== undefined) return found;
    const created = createGroupState(groupId);
    this.states.set(groupId, created);
    this.statOf(groupId);
    return created;
  }

  /** 取（或建）群统计 */
  private statOf(groupId: string): RuntimeStats {
    const found = this.stats.get(groupId);
    if (found !== undefined) return found;
    const created: RuntimeStats = { groupId, received: 0, replied: 0, state: this.stateOf(groupId) };
    this.stats.set(groupId, created);
    return created;
  }

  /** 群策略（显式配置优先） */
  private policyOf(groupId: string): GroupPolicy {
    return policyFor(this.config, groupId);
  }

  /** 记忆落盘（失败只记日志，不影响对话） */
  private persistMemory(): void {
    if (this.memoryPath === '') return;
    try {
      writeMemoryFile(this.memoryPath, this.memory);
    } catch (e) {
      this.log('warn', `写群记忆失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 把她说的话记进上下文 */
  private appendAssistant(groupId: string, text: string, ts: number): void {
    appendTurn(this.memory, groupId, { role: 'assistant', name: this.config.selfName, text: text.slice(0, 500), ts });
    this.persistMemory();
  }

  /** 音频落盘目录（每次启动清理一次旧的，避免占满磁盘） */
  private audioPath(file: string): string {
    const dir = join(this.deps.userRoot, 'cache', 'qq-audio');
    mkdirSync(dir, { recursive: true });
    return join(dir, file);
  }

  private recordError(message: string): void {
    this.lastError = message;
    this.log('error', message);
    this.deps.onError?.(message);
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    if (level === 'debug' && this.config.logLevel !== 'debug') return;
    this.deps.log(level, message);
  }
}

/**
 * 解析模型输出，并把条数夹到策略允许的范围。
 *
 * 单独抽出来是因为「模型给了 8 条但我们最多发 3 条」这种情况必须有确定行为：
 * 截断（保留前面几条），不是随机丢。前面的通常是主回应。
 */
export function parseReplyPlanSafe(
  raw: string,
  policy: GroupPolicy,
): { messages: string[]; action: 'text' | 'voice' | 'sing'; song?: string } {
  const plan = parseReplyPlan(raw);
  return { ...plan, messages: clampMessages(plan.messages, policy) };
}

/** 一行 QqAction → 消息段（给宿主路由用；唱歌/语音需要额外处理，这里只覆盖简单类型） */
export function actionToSegments(action: QqAction): ObSegment[] {
  switch (action.kind) {
    case 'text':
      return [{ type: 'text', data: { text: action.text } }];
    case 'at':
      return [{ type: 'at', data: { qq: action.qq } }];
    case 'face':
      return [{ type: 'face', data: { id: action.id } }];
    case 'image':
      return [{ type: 'image', data: { file: action.file } }];
    case 'record':
      return [{ type: 'record', data: { file: action.file } }];
    case 'voice':
      // 语音要先合成：返回占位，由 QqBridge.speakInGroup 处理
      return [{ type: 'text', data: { text: action.speak ?? action.text } }];
    default:
      return [];
  }
}

/** 把一段候选消息按策略裁剪（条数上限 + 单条长度上限） */
export function clampMessages(messages: string[], policy: GroupPolicy): string[] {
  return messages
    .slice(0, Math.max(1, policy.burst.max))
    .map((text) => (text.length > 300 ? `${text.slice(0, 300)}…` : text))
    .filter((text) => text.trim() !== '');
}

/** 去抖窗口时长（导出给测试与文档用） */
export const debounceMs = CHAT_DEBOUNCE_MS;
