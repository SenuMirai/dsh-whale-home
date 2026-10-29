/**
 * dsh-qq-group —— 独立于桌宠的 QQ 群聊插件。
 *
 * 数据全部在 `$DSH_HOME/dsh-qq-group/`：
 *   qq.json        连接/群策略/语音/唱歌
 *   settings.json  人设、主动/被动、模型选择、表情包自动收藏
 *   qq-memory.json 群聊记忆
 *   diary.json     鲸鱼娘的日记（群聊 + 内心吐槽）
 *   stickers/      表情包池（自己收藏的 + 群友发的）
 *
 * 路由前缀 `/dsh-qq-group`；设置页由同包 client.js 挂到 settings.section。
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { DEFAULT_SAFETY, SAFETY_PRESETS, type SafetyProfile, type SafetySettings } from './qq/safety';

import { BlockAssembler, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GroupPolicy, QqConfig, QqRvcConfig } from './qq/config';
import type { DiaryEntry, ProfileStore } from './qq/bridge';
import type { ObSegment } from './qq/types';
import { runComputerTool } from './qq/computer';
import { ComputerHost } from './qq/computer-host';
import { readWorldBridge, readWorldMemory, syncWorldPermanent, syncWorldPersona, WorldRelay, writeWorldDiary, writeWorldPersona, writeWorldPrompt, writeWorldSelf } from './qq/world';
import {
  autoRecallTraces,
  deleteTraces,
  effectiveHalfLife,
  loadTraces,
  makeTrace,
  rankTraces,
  recallForChat,
  recallTraces,
  saveTraces,
  traceActivation,
  renderTraceBlock,
  syncTracePrompt,
  tracePromptBlock,
  updateTrace,
  upsertTrace,
  writeTrace,
  type MemoryTrace,
} from './qq/memory-traces';
import {
  appendQqDiarySection,
  appendQqTurn,
  extractArchiveDirectives,
  fragmentHint,
  keepAlbumImage,
  readMemoryPolicy,
  readMergedDiary,
  readRecentTurns,
} from './qq/memory-center';
import {
  addPermanent,
  deletePermanent,
  listPermanent,
  promotePermanent,
  readPermanentStore,
  replacePermanent,
  writePermanentStore,
  type PermanentScope,
} from './qq/permanent';
import {
  createStickerHub,
  deleteStickers,
  listStickerInfo,
  listStickerRepos,
  moveStickers,
  stickerFile,
  stickerFolder,
  updateStickerMeta,
  updateStickerRepos,
} from './qq/stickers';
import {
  createSelfieHub,
  deleteSelfie,
  listSelfies,
  saveSelfie,
  selfieDir,
  selfieFile,
} from './qq/selfies';
import { DEFAULT_OWNER_PRIORITY } from './qq/prompt';
import { listMemories as listMemoriesV3, readMemoryStore as readMemoryStoreV3 } from './qq/memory-v3';
import { DEFAULT_SCORE_WEIGHTS, type ScoreRules, type ScoreWeights } from './qq/triggers';
import { scanRvcModels } from './qq/rvc-models';
import { createCommandRvcConverter } from './sound/rvc';
import {
  getProfile,
  listProfiles,
  noteContinuation,
  noteHostility,
  noteQuote,
  noteReply as noteProfileReply,
  readProfiles,
  touchUser,
  writeProfiles,
  DEFAULT_PROFILE_RULES,
  type ProfileRules,
  type ProfileFile,
} from './qq/profiles';
import { createQqHost, qqConfigPath, readQqConfig } from './qq-host';
import { Speaker, describeFailure } from './sound/tts';
import { encodeWave } from './sound/wav';
import {
  appendUsage,
  currentMonth,
  entryCredits,
  localDay,
  readUsage,
  summarize,
  usageKey,
  type UsageEntry,
} from './qq/usage';

// 测试要拿真实预设值去核对界面文案，所以从这里转出去（运行时行为不受影响）。
export { SAFETY_PRESETS } from './qq/safety';

export const name = 'dsh-qq-group';
export const inject = ['webServer', 'llm', 'agentDefaultModel'];

type ModelRef = { provider: string; model: string };
type Settings = {
  persona: string;
  /** 多个人设卡片；persona 保留为兼容旧配置/当前文本 */
  personas: Array<{ id: string; name: string; text: string }>;
  /** 群号 -> 人设卡片 id；空 = 跟随全局 */
  groupPersonaIds: Record<string, string>;
  /** 可编辑的主人优先级提示；空 = 使用内置默认 */
  ownerPriorityPrompt: string;
  activePersonaId: string;
  /** QQ空间：是否启用、发布模式、可见范围与频率 */
  qzone: {
    enabled: boolean;
    mode: 'manual' | 'draft' | 'auto';
    ugcRight: number;
    dailyLimit: number;
    minIntervalMinutes: number;
    /** 配图模式：关闭 / 固定张数 / 区间随机 / 模型决定 */
    imageMode: 'off' | 'fixed' | 'range' | 'model';
    imageFixed: number;
    imageMin: number;
    imageMax: number;
    /** 允许取图的表情包仓库 id；空 = 全部 */
    imageRepos: string[];
    /** 文本 @：关闭 / 名单随机 / 模型决定 */
    mentionMode: 'off' | 'list' | 'model';
    mentionList: Array<{ qq: string; name: string }>;
    mentionChance: number;
    /** Qzone cookie 远程读取（默认关闭，需明确接受风险） */
    remoteEnabled: boolean;
    remoteRiskAccepted: boolean;
    remoteLimit: number;
    /** 读取评论（默认关闭，需明确接受风险） */
    commentEnabled: boolean;
    commentRiskAccepted: boolean;
    /**
     * @deprecated 2026-10-28 起不再起作用。
     * 以前用它掷骰决定「这条说说发不发」，现在发不发由她自己判断
     * （问她「现在想发吗」，不想就回「不发」）。
     * 字段留着只为读旧 settings.json 不报错，界面上已经移除。
     */
    autoChance: number;
  };
  permanent: {
    enabled: boolean;
    /** 自动记录名单里的人和主人说的话 */
    autoCapture: boolean;
    /** 额外重要的人（QQ 号）；主人始终包含 */
    people: string[];
    /** 每个群/会话的容量；满了只封存不删除 */
    capacity: number;
    /** 全局主人记忆容量 */
    globalCapacity: number;
    recallLimit: number;
    recallChars: number;
  };
  computerUse: {
    /** 仅主人私聊，且必须 /电脑 前缀 */
    enabled: boolean;
    maxSteps: number;
  };
  worldBridge: {
    enabled: boolean;
    worldId: string;
    /**
     * 主人私聊走哪个世界。留空 = 和 worldId 同一个。
     * 填了之后群聊仍然用 worldId，只有「主人私聊」那一路切过去——
     * 两个世界的人设、记忆、日记各过各的，互不污染。
     */
    privateWorldId: string;
    worldDir: string;
    privateBackend: 'world' | 'plugin' | 'chat';
    /** DSH 启动后主动叫醒她，不用等兜底闹钟 */
    wakeOnStart: boolean;
    /** 私聊攒消息窗口（毫秒）：连着打字时等一小会儿合成一整段。0 = 不攒。 */
    settleMs: number;
  };
  /**
   * 群聊实况灌进记忆的数量。两个数分开管：
   * 一个是「记忆块里带几条」（进 prompt，吃上下文），
   * 一个是「群近况.md 里留几条」（文件，只占磁盘）。
   */
  groupDigest: {
    /** 拼进 world-prompt 记忆块的最近几条；0 = 不灌 */
    memoryLines: number;
    /** room/群近况.md 滚动保留几条 */
    fileLines: number;
  };
  /**
   * 群聊和私聊共用一个 transcript：互相能看见对方最近的几句原话。
   * 关掉就各看各的。默认关。
   */
  sharedTranscript: {
    enabled: boolean;
    /** 每边带多少条 */
    turns: number;
    /**
     * 群聊里允不允许提到主人的生活细节。
     * 关着：只有主人在群里说话时才带私聊原话，并提示别复述。
     * 开着：群友说话也带，也不再提示别复述——她会偶尔漏一点，那是活的。
     */
    revealToGroup: boolean;
  };
  mode: 'passive' | 'proactive';
  model: ModelRef;
  /** 备用模型：主模型只回 reasoning / 空回复时切一次 */
  fallbackModel: ModelRef;
  /** 推理档位（空 = 跟随模型默认；具体档位来自模型能力） */
  reasoningEffort: string;
  /** 每个 provider/model 的上下文窗口覆盖（tokens；0/缺省 = 跟随模型能力） */
  contextWindows: Record<string, number>;
  /** 自动收藏群友发的图片/表情包 */
  stickerSave: boolean;
  /** 入库过滤：smart = 只收像表情包的；all = 所有图都进暂存区 */
  stickerFilter: 'smart' | 'all';
  /** 新图默认放哪个仓库 */
  stickerSaveRepo: string;
  /** 入库后是否自动让模型猜含义（默认关，省 token） */
  stickerAnalyzeOnSave: boolean;
  /** 表情包仓库最多保留多少张（超过删最旧） */
  stickerMax: number;
  /** 表情包仓库最多占多少 MB（超过删最旧） */
  stickerMaxMB: number;
  /** DSH 启动时自动连接（默认开） */
  autoStart: boolean;
  /** 点启动时自动拉起 NapCat（默认开） */
  autoLaunchNapcat: boolean;
  /** NapCat 启动脚本/快捷方式路径 */
  napcatLauncher: string;
  /** 白名单：固定价值评分下限 */
  whitelist: string[];
  whitelistFloor: number;
  /** 黑名单：固定价值评分上限 */
  blacklist: string[];
  blacklistCeil: number;
  /** 夜间免打扰 */
  nightDnd: { enabled: boolean; startHour: number; endHour: number };
  /** 夜间命中时从价值评分里扣多少分 */
  nightPenalty: number;
  /** 价值评分的全部权重 */
  scoreWeights: ScoreWeights;
  /** 熟识度/好感度的全部增减规则 */
  profileRules: ProfileRules;
  /** 主人全局熟识度（所有群共用） */
  ownerFamiliarity: number;
  /** 主人全局好感度（所有群共用） */
  ownerAffinity: number;
  /** 被怼/嘲讽时让模型判断并扣好感 */
  hostilityJudge: boolean;
  /** DSH 退出后自动清理认证 cookie（Windows；阈值 20） */
  cookieWatch: boolean;
  /** 用户导入的 edge-tts 音色条目（内置音色不在这里） */
  customVoices: Array<{ id: string; label: string }>;
  /** 模型积分单价：`provider/model` → 每百万 token 积分 */
  usageRates: Record<string, number>;
  /** 手动记的余额（用于估算剩余） */
  balance: { credits: number; setAt: number } | null;
  /**
   * 安全防护（账号级出站闸门）。
   * 管的是「频率与时机」，不是她说什么 —— 别在这里加内容好坏判断。
   */
  safety: SafetySettings;
};

const DEFAULT_PERSONA =
  '你是主人 QQ 群里的鲸鱼娘：聪明、偶尔偷懒、傲娇但很爱主人。说话自然口语，不写动作神态，不暴露自己是 AI。';

declare const __DSH_PLUGIN_VERSION__: string | undefined;
const PLUGIN_VERSION =
  typeof __DSH_PLUGIN_VERSION__ === 'string' ? __DSH_PLUGIN_VERSION__ : '0.0.0-dev';
const PLUGIN_STARTED_AT = Date.now();
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/** 磁盘 package.json 的版本；用于判断运行中的代码是否落后于当前构建。 */
function diskPluginVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** 当前生效的人设：优先群绑定卡片，其次全局激活卡片，最后旧 persona 字段/默认。 */function activePersona(settings: Settings, groupId?: string): string {
  const boundId = groupId === undefined ? '' : settings.groupPersonaIds[groupId] ?? '';
  const bound = settings.personas.find((item) => item.id === boundId);
  if (bound !== undefined && bound.text.trim() !== '') return bound.text.trim();
  const card = settings.personas.find((item) => item.id === settings.activePersonaId);
  return (card?.text ?? settings.persona).trim() || DEFAULT_PERSONA;
}

const DEFAULT_SETTINGS: Settings = {
  persona: '',
  personas: [],
  groupPersonaIds: {},
  ownerPriorityPrompt: DEFAULT_OWNER_PRIORITY,
  activePersonaId: '',
  qzone: {
    enabled: false,
    mode: 'draft',
    ugcRight: 64,
    dailyLimit: 1,
    minIntervalMinutes: 120,
    imageMode: 'off',
    imageFixed: 0,
    imageMin: 0,
    imageMax: 3,
    imageRepos: [],
    mentionMode: 'off',
    mentionList: [],
    mentionChance: 0.3,
    remoteEnabled: false,
    remoteRiskAccepted: false,
    remoteLimit: 10,
    commentEnabled: false,
    commentRiskAccepted: false,
    autoChance: 0.2,
  },
  permanent: {
    enabled: true,
    // 2026-10-28 关掉自动记录：永久记忆只当「手填的群规 / 人物 / 群事件」用。
    // 原来会把主人每句话都抄进来，既少有人读，又和记忆痕迹重复。
    // 存量数据不受影响，手动添加照常可用。
    autoCapture: false,
    people: [],
    capacity: 200,
    globalCapacity: 100,
    recallLimit: 12,
    recallChars: 1500,
  },
  computerUse: {
    enabled: false,
    maxSteps: 3,
  },
  sharedTranscript: {
    enabled: false,
    turns: 12,
    revealToGroup: false,
  },
  worldBridge: {
    enabled: false,
    worldId: 'default',
    privateWorldId: '',
    worldDir: '',
    privateBackend: 'chat',
    wakeOnStart: false,
    settleMs: 1200,
  },
  groupDigest: {
    memoryLines: 12,
    fileLines: 40,
  },
  mode: 'passive',
  model: { provider: '', model: '' },
  fallbackModel: { provider: '', model: '' },
  reasoningEffort: '',
  contextWindows: {},
  stickerSave: false,
  stickerFilter: 'smart',
  stickerSaveRepo: 'inbox',
  stickerAnalyzeOnSave: false,
  stickerMax: 300,
  stickerMaxMB: 200,
  autoStart: false,
  autoLaunchNapcat: true,
  napcatLauncher: 'start-napcat.bat',
  whitelist: [],
  whitelistFloor: 95,
  blacklist: [],
  blacklistCeil: 5,
  nightDnd: { enabled: true, startHour: 23, endHour: 8 },
  nightPenalty: 20,
  scoreWeights: { ...DEFAULT_SCORE_WEIGHTS },
  profileRules: { ...DEFAULT_PROFILE_RULES },
  ownerFamiliarity: 60,
  ownerAffinity: 80,
  hostilityJudge: true,
  cookieWatch: true,
  customVoices: [
    { id: '三月七', label: '三月七 · v2ProPlus' },
    { id: '银狼', label: '银狼 · v2ProPlus' },
  ],
  usageRates: {},
  balance: null,
  safety: DEFAULT_SAFETY,
};

const settingsPath = (root: string): string => join(root, 'settings.json');
const diaryPath = (root: string): string => join(root, 'diary.json');
const DIARY_CAP = 1000;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function readSettings(root: string): Settings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(root), 'utf8')) as Partial<Settings>;
    const number = (value: unknown, fallback: number, min: number, max: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    const qqList = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && /^\d{5,12}$/.test(item.trim())).map((item) => item.trim())
        : [];
    const scoreWeights = (value: unknown): ScoreWeights => {
      const src = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      const pick = (key: keyof ScoreWeights, fallback: number, min = 0, max = 1000): number =>
        typeof src[key] === 'number' && Number.isFinite(src[key] as number)
          ? Math.min(max, Math.max(min, Math.round(src[key] as number)))
          : fallback;
      return {
        base: pick('base', DEFAULT_SCORE_WEIGHTS.base, 0, 100),
        keywordMultiplier: pick('keywordMultiplier', DEFAULT_SCORE_WEIGHTS.keywordMultiplier),
        memberMultiplier: pick('memberMultiplier', DEFAULT_SCORE_WEIGHTS.memberMultiplier),
        sameSpeaker: pick('sameSpeaker', DEFAULT_SCORE_WEIGHTS.sameSpeaker),
        continuation: pick('continuation', DEFAULT_SCORE_WEIGHTS.continuation),
        directContinuation: pick('directContinuation', DEFAULT_SCORE_WEIGHTS.directContinuation),
        secondPerson: pick('secondPerson', DEFAULT_SCORE_WEIGHTS.secondPerson),
        atOtherPenalty: pick('atOtherPenalty', DEFAULT_SCORE_WEIGHTS.atOtherPenalty),
        replyOtherPenalty: pick('replyOtherPenalty', DEFAULT_SCORE_WEIGHTS.replyOtherPenalty),
        familiarityMax: pick('familiarityMax', DEFAULT_SCORE_WEIGHTS.familiarityMax),
        affinityMax: pick('affinityMax', DEFAULT_SCORE_WEIGHTS.affinityMax),
        ignoredPenalty: pick('ignoredPenalty', DEFAULT_SCORE_WEIGHTS.ignoredPenalty),
        singleMessagePenalty: pick('singleMessagePenalty', DEFAULT_SCORE_WEIGHTS.singleMessagePenalty),
        shortMessagePenalty: pick('shortMessagePenalty', DEFAULT_SCORE_WEIGHTS.shortMessagePenalty),
        shortMessageChars: pick('shortMessageChars', DEFAULT_SCORE_WEIGHTS.shortMessageChars, 0, 100),
      };
    };
    const profileRules = (value: unknown): ProfileRules => {
      const src = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      const out: ProfileRules = { ...DEFAULT_PROFILE_RULES };
      for (const key of Object.keys(DEFAULT_PROFILE_RULES) as Array<keyof ProfileRules>) {
        const candidate = src[key];
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
          out[key] = Math.min(1000, Math.max(0, candidate));
        }
      }
      return out;
    };
    const nightRaw = raw.nightDnd;
    const night =
      nightRaw !== null && typeof nightRaw === 'object'
        ? {
            enabled: (nightRaw as { enabled?: unknown }).enabled !== false,
            startHour: number((nightRaw as { startHour?: unknown }).startHour, 23, 0, 23),
            endHour: number((nightRaw as { endHour?: unknown }).endHour, 8, 0, 23),
          }
        : DEFAULT_SETTINGS.nightDnd;
    const personas = Array.isArray(raw.personas)
      ? raw.personas
          .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
          .map((item) => ({
            id: typeof item.id === 'string' && item.id !== '' ? item.id : `persona-${Math.random().toString(36).slice(2, 10)}`,
            name: typeof item.name === 'string' ? item.name.slice(0, 60) : '未命名',
            text: typeof item.text === 'string' ? item.text.slice(0, 20_000) : '',
          }))
          .slice(0, 30)
      : [];
    const activePersonaId = typeof raw.activePersonaId === 'string' ? raw.activePersonaId : '';
    const groupPersonaIds = Object.fromEntries(
      Object.entries(raw.groupPersonaIds ?? {})
        .filter(([groupId, id]) => groupId !== '' && typeof id === 'string' && id !== '')
        .slice(0, 200),
    ) as Record<string, string>;
    return {
      persona: typeof raw.persona === 'string' ? raw.persona : '',
      personas,
      groupPersonaIds,
      ownerPriorityPrompt:
        typeof raw.ownerPriorityPrompt === 'string' ? raw.ownerPriorityPrompt : DEFAULT_OWNER_PRIORITY,
      activePersonaId,
      qzone: (() => {
        const source =
          raw.qzone !== null && typeof raw.qzone === 'object'
            ? (raw.qzone as Record<string, unknown>)
            : {};
        return {
          enabled: source.enabled === true,
          mode: source.mode === 'auto' ? 'auto' : source.mode === 'manual' ? 'manual' : 'draft',
          ugcRight: [1, 4, 16, 64, 128].includes(Number(source.ugcRight)) ? Number(source.ugcRight) : 64,
          dailyLimit: Math.round(clampNumber(source.dailyLimit, 0, 20, 1)),
          minIntervalMinutes: Math.round(clampNumber(source.minIntervalMinutes, 0, 1440, 120)),
          imageMode:
            source.imageMode === 'fixed' || source.imageMode === 'range' || source.imageMode === 'model'
              ? source.imageMode
              : 'off',
          imageFixed: Math.round(clampNumber(source.imageFixed, 0, 9, 0)),
          imageMin: Math.round(clampNumber(source.imageMin, 0, 9, 0)),
          imageMax: Math.round(clampNumber(source.imageMax, 0, 9, 3)),
          imageRepos: Array.isArray(source.imageRepos)
            ? source.imageRepos.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 50)
            : [],
          mentionMode:
            source.mentionMode === 'list' || source.mentionMode === 'model' ? source.mentionMode : 'off',
          mentionList: Array.isArray(source.mentionList)
            ? source.mentionList
                .filter(
                  (x): x is { qq: string; name: string } =>
                    x !== null &&
                    typeof x === 'object' &&
                    /^\d{5,12}$/.test(String((x as { qq?: unknown }).qq ?? '')),
                )
                .map((x) => ({
                  qq: String(x.qq),
                  name:
                    typeof x.name === 'string' && x.name.trim() !== ''
                      ? x.name.trim().slice(0, 30)
                      : String(x.qq),
                }))
                .slice(0, 50)
            : [],
          mentionChance: clampNumber(source.mentionChance, 0, 1, 0.3),
          remoteEnabled: source.remoteEnabled === true,
          remoteRiskAccepted: source.remoteRiskAccepted === true,
          remoteLimit: Math.round(clampNumber(source.remoteLimit, 1, 50, 10)),
          commentEnabled: source.commentEnabled === true,
          commentRiskAccepted: source.commentRiskAccepted === true,
          autoChance: clampNumber(source.autoChance, 0, 1, 0.2),
        };
      })(),
      permanent: (() => {
        const source =
          raw.permanent !== null && typeof raw.permanent === 'object'
            ? (raw.permanent as Record<string, unknown>)
            : {};
        return {
          enabled: source.enabled !== false,
          autoCapture: source.autoCapture !== false,
          people: Array.isArray(source.people)
            ? Array.from(
                new Set(
                  source.people
                    .map((x) => String(x).trim())
                    .filter((x) => /^\d{5,12}$/.test(x)),
                ),
              ).slice(0, 50)
            : [],
          capacity: Math.round(clampNumber(source.capacity, 10, 5000, 200)),
          globalCapacity: Math.round(clampNumber(source.globalCapacity, 10, 2000, 100)),
          recallLimit: Math.round(clampNumber(source.recallLimit, 1, 50, 12)),
          recallChars: Math.round(clampNumber(source.recallChars, 200, 8000, 1500)),
        };
      })(),
      computerUse: (() => {
        const source =
          raw.computerUse !== null && typeof raw.computerUse === 'object'
            ? (raw.computerUse as Record<string, unknown>)
            : {};
        return {
          enabled: source.enabled === true,
          maxSteps: Math.round(clampNumber(source.maxSteps, 1, 8, 3)),
        };
      })(),
      worldBridge: (() => {
        const source =
          raw.worldBridge !== null && typeof raw.worldBridge === 'object'
            ? (raw.worldBridge as Record<string, unknown>)
            : {};
        return {
          enabled: source.enabled === true,
          worldId:
            typeof source.worldId === 'string' && source.worldId.trim() !== ''
              ? source.worldId.trim().slice(0, 80)
              : 'default',
          privateWorldId:
            typeof source.privateWorldId === 'string' ? source.privateWorldId.trim().slice(0, 80) : '',
          worldDir: typeof source.worldDir === 'string' ? source.worldDir.trim().slice(0, 500) : '',
          privateBackend:
            source.privateBackend === 'world' || source.privateBackend === 'plugin'
              ? source.privateBackend
              : 'chat',
          wakeOnStart: source.wakeOnStart === true,
          settleMs: clampNumber(source.settleMs, 0, 10_000, DEFAULT_SETTINGS.worldBridge.settleMs),
        };
      })(),
      mode: raw.mode === 'proactive' ? 'proactive' : 'passive',
      model:
        raw.model && typeof raw.model.provider === 'string' && typeof raw.model.model === 'string'
          ? { provider: raw.model.provider, model: raw.model.model }
          : { provider: '', model: '' },
      reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort : '',
      contextWindows: Object.fromEntries(
        Object.entries((raw.contextWindows ?? {}) as Record<string, unknown>)
          .filter(([key, value]) => key.includes('/') && typeof value === 'number' && Number.isFinite(value) && value >= 1000)
          .map(([key, value]) => [key, Math.min(2_000_000, Math.max(1000, Math.round(value as number)))]),
      ),
      fallbackModel:
        raw.fallbackModel &&
        typeof raw.fallbackModel.provider === 'string' &&
        typeof raw.fallbackModel.model === 'string'
          ? { provider: raw.fallbackModel.provider, model: raw.fallbackModel.model }
          : { provider: '', model: '' },
      stickerSave: raw.stickerSave === true,
      stickerFilter: raw.stickerFilter === 'all' ? 'all' : 'smart',
      stickerSaveRepo: typeof raw.stickerSaveRepo === 'string' ? raw.stickerSaveRepo : 'inbox',
      stickerAnalyzeOnSave: raw.stickerAnalyzeOnSave === true,
      stickerMax: number(raw.stickerMax, DEFAULT_SETTINGS.stickerMax, 20, 2000),
      stickerMaxMB: number(raw.stickerMaxMB, DEFAULT_SETTINGS.stickerMaxMB, 20, 5000),
      autoStart: raw.autoStart === true,
      autoLaunchNapcat: raw.autoLaunchNapcat !== false,
      napcatLauncher:
        typeof raw.napcatLauncher === 'string' && raw.napcatLauncher.trim() !== ''
          ? raw.napcatLauncher
          : DEFAULT_SETTINGS.napcatLauncher,
      whitelist: qqList(raw.whitelist),
      whitelistFloor: number(raw.whitelistFloor, DEFAULT_SETTINGS.whitelistFloor, 0, 100),
      blacklist: qqList(raw.blacklist),
      blacklistCeil: number(raw.blacklistCeil, DEFAULT_SETTINGS.blacklistCeil, 0, 100),
      nightDnd: night,
      nightPenalty: number(raw.nightPenalty, DEFAULT_SETTINGS.nightPenalty, 0, 100),
      scoreWeights: scoreWeights(raw.scoreWeights),
      profileRules: profileRules(raw.profileRules),
      ownerFamiliarity: clampNumber(raw.ownerFamiliarity, 0, 100, 60),
      ownerAffinity: clampNumber(raw.ownerAffinity, -100, 100, 80),
      hostilityJudge: raw.hostilityJudge !== false,
      cookieWatch: raw.cookieWatch !== false,
      customVoices: (() => {
        const list = Array.isArray(raw.customVoices)
          ? raw.customVoices
              .filter(
                (v): v is { id: string; label: string } =>
                  v !== null &&
                  typeof v === 'object' &&
                  typeof (v as { id?: unknown }).id === 'string' &&
                  (v as { id: string }).id.trim() !== '',
              )
              .map((v) => ({
                id: v.id.trim(),
                label: typeof v.label === 'string' && v.label.trim() !== '' ? v.label.trim() : v.id.trim(),
              }))
              .slice(0, 200)
          : [];
        return list.length > 0 ? list : DEFAULT_SETTINGS.customVoices;
      })(),
      usageRates:
        raw.usageRates !== null && typeof raw.usageRates === 'object' && !Array.isArray(raw.usageRates)
          ? Object.fromEntries(
              Object.entries(raw.usageRates as Record<string, unknown>)
                .filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
                .map(([k, v]) => [k, Number(v)]),
            )
          : {},
      balance:
        raw.balance !== null &&
        typeof raw.balance === 'object' &&
        typeof (raw.balance as { credits?: unknown }).credits === 'number' &&
        typeof (raw.balance as { setAt?: unknown }).setAt === 'number'
          ? {
              credits: Math.max(0, Number((raw.balance as { credits: number }).credits)),
              setAt: Number((raw.balance as { setAt: number }).setAt),
            }
          : null,
      // 安全防护：整段按字段归一化，缺的用默认值补。
      // 档位会先铺一遍预设，再用存下来的具体数值覆盖 —— 这样「换档」和「手调」
      // 不会互相打架：手调过的字段在换档后仍然生效，没调过的跟着档位走。
      safety: (() => {
        const src =
          raw.safety !== null && typeof raw.safety === 'object'
            ? (raw.safety as Record<string, unknown>)
            : null;
        if (src === null) return { ...DEFAULT_SAFETY };
        const profileId = String(src.profile ?? '') as SafetyProfile;
        const profile: SafetyProfile =
          profileId === 'unlimited' || profileId === 'loose' || profileId === 'standard' || profileId === 'strict'
            ? profileId
            : DEFAULT_SAFETY.profile;
        const base = { ...DEFAULT_SAFETY, ...SAFETY_PRESETS[profile], profile };
        const economyId = String(src.economy ?? '');
        const economy =
          economyId === 'off' || economyId === 'balanced' || economyId === 'frugal'
            ? (economyId as SafetySettings['economy'])
            : DEFAULT_SAFETY.economy;
        const num = (key: keyof SafetySettings, min: number, max: number): number => {
          const fallback = Number(base[key] ?? 0);
          const v = src[key];
          return typeof v === 'number' && Number.isFinite(v)
            ? Math.min(max, Math.max(min, Math.round(v)))
            : fallback;
        };
        const bool = (key: keyof SafetySettings): boolean =>
          typeof src[key] === 'boolean' ? (src[key] as boolean) : Boolean(base[key]);
        return {
          enabled: bool('enabled'),
          profile,
          economy,
          privateExempt: bool('privateExempt'),
          globalPerMinute: num('globalPerMinute', 0, 600),
          globalPerHour: num('globalPerHour', 0, 5000),
          burstAfter: num('burstAfter', 0, 200),
          burstSilenceMinutes: num('burstSilenceMinutes', 0, 1440),
          nightThrottle: bool('nightThrottle'),
          nightStart: num('nightStart', 0, 23),
          nightEnd: num('nightEnd', 0, 23),
          failureThreshold: num('failureThreshold', 0, 100),
          silenceMinutes: num('silenceMinutes', 0, 1440),
          stopOnRiskSignal: bool('stopOnRiskSignal'),
          jitterMinMs: num('jitterMinMs', 0, 60_000),
          jitterMaxMs: num('jitterMaxMs', 0, 60_000),
          typingPerCharMs: num('typingPerCharMs', 0, 1000),
          blockLinks: bool('blockLinks'),
          blockRepeat: bool('blockRepeat'),
          repeatWindowMinutes: num('repeatWindowMinutes', 1, 1440),
          healthProbeMinutes: num('healthProbeMinutes', 0, 1440),
          dailySummary: bool('dailySummary'),
          offPeakStart: num('offPeakStart', 0, 23),
          offPeakEnd: num('offPeakEnd', 0, 23),
        } satisfies SafetySettings;
      })(),
      // 这项以前漏在 readSettings 外面：保存时被整块丢掉，界面上就表现为「勾了又弹回去」。
      groupDigest: (() => {
        const src =
          raw.groupDigest !== null && typeof raw.groupDigest === 'object'
            ? (raw.groupDigest as Record<string, unknown>)
            : {};
        return {
          memoryLines: clampNumber(src.memoryLines, 0, 200, DEFAULT_SETTINGS.groupDigest.memoryLines),
          fileLines: clampNumber(src.fileLines, 1, 500, DEFAULT_SETTINGS.groupDigest.fileLines),
        };
      })(),
      sharedTranscript: (() => {
        const src =
          raw.sharedTranscript !== null && typeof raw.sharedTranscript === 'object'
            ? (raw.sharedTranscript as Record<string, unknown>)
            : {};
        return {
          enabled: src.enabled === true,
          // 0 = 全部；上限放到 5000，别再让 40 卡住
          turns: clampNumber(src.turns, 0, 5000, DEFAULT_SETTINGS.sharedTranscript.turns),
          revealToGroup: src.revealToGroup === true,
        };
      })(),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, nightDnd: { ...DEFAULT_SETTINGS.nightDnd } };
  }
}

function writeSettings(root: string, settings: Settings): void {
  mkdirSync(root, { recursive: true });
  const path = settingsPath(root);
  if (existsSync(path)) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      copyFileSync(path, `${path}.bak-${stamp}`);
      const backups = readdirSync(root)
        .filter((name) => name.startsWith('settings.json.bak-'))
        .sort()
        .reverse();
      for (const old of backups.slice(10)) {
        try {
          unlinkSync(`${root}/${old}`);
        } catch {
          /* 备份清理失败不影响保存 */
        }
      }
    } catch {
      /* 备份失败不阻塞保存 */
    }
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

/** QQ空间本地记录：tid、正文、时间、可见范围。 */
type QzoneEntry = {
  tid: string;
  content: string;
  ts: number;
  ugcRight: number;
  images?: string[];
};

const qzonePath = (root: string): string => join(root, 'qzone.json');
const QZONE_CAP = 1000;

function readQzone(root: string): QzoneEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(qzonePath(root), 'utf8')) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .filter(
        (e): e is QzoneEntry =>
          e !== null &&
          typeof e === 'object' &&
          typeof (e as QzoneEntry).ts === 'number' &&
          typeof (e as QzoneEntry).content === 'string',
      )
      .map((e) => ({
        tid: typeof e.tid === 'string' ? e.tid : '',
        content: e.content,
        ts: e.ts,
        ugcRight: typeof e.ugcRight === 'number' ? e.ugcRight : 64,
        ...(Array.isArray(e.images)
          ? { images: e.images.filter((x): x is string => typeof x === 'string').slice(0, 9) }
          : {}),
      }));
  } catch {
    return [];
  }
}

function writeQzone(root: string, entries: QzoneEntry[]): void {
  const kept = entries.length > QZONE_CAP ? entries.slice(-QZONE_CAP) : entries;
  writeFileSync(qzonePath(root), `${JSON.stringify({ entries: kept }, null, 2)}\n`, 'utf8');
}

function appendQzone(root: string, entry: QzoneEntry): void {
  writeQzone(root, [...readQzone(root), entry]);
}

/** 永久记忆：独立文件，不参与摘要/淡忘。 */
const permanentPath = (root: string): string => join(root, 'permanent-memory.json');

function permanentList(
  root: string,
  groupId: string,
  scope: PermanentScope = 'session',
): ReturnType<typeof listPermanent> {
  return listPermanent(readPermanentStore(permanentPath(root)), groupId, scope);
}

function permanentAdd(
  root: string,
  groupId: string,
  input: {
    text: string;
    people?: string[];
    source?: 'auto' | 'manual' | 'merge';
    scope?: PermanentScope;
    sensitivity?: 'normal' | 'private';
    mergeWithinMs?: number;
  },
  capacity: number,
): ReturnType<typeof addPermanent> {
  const path = permanentPath(root);
  const store = readPermanentStore(path);
  const result = addPermanent(store, groupId, input, capacity);
  if (result.ok || result.reason === 'full') writePermanentStore(path, store);
  return result;
}

function permanentDelete(
  root: string,
  groupId: string,
  id: string,
  scope: PermanentScope = 'session',
): boolean {
  const path = permanentPath(root);
  const store = readPermanentStore(path);
  const ok = deletePermanent(store, groupId, id, scope);
  if (ok) writePermanentStore(path, store);
  return ok;
}

function permanentMerge(
  root: string,
  groupId: string,
  ids: string[],
  text: string,
  scope: PermanentScope = 'session',
): ReturnType<typeof replacePermanent> {
  const path = permanentPath(root);
  const store = readPermanentStore(path);
  const item = replacePermanent(store, groupId, ids, text, scope);
  if (item !== undefined) writePermanentStore(path, store);
  return item;
}

function permanentPromote(
  root: string,
  groupId: string,
  id: string,
  capacity: number,
  sensitivity: 'normal' | 'private',
): ReturnType<typeof promotePermanent> {
  const path = permanentPath(root);
  const store = readPermanentStore(path);
  const item = promotePermanent(store, groupId, id, capacity, sensitivity);
  if (item !== undefined) writePermanentStore(path, store);
  return item;
}

/** 找 NapCat 登录二维码：优先环境变量，其次启动脚本里的 cd 目录，最后常见安装位置。 */
function resolveNapcatQr(root: string): string | undefined {
  const candidates: string[] = [];
  const env = process.env.DSH_NAPCAT_QR;
  if (env !== undefined && env.trim() !== '') candidates.push(env.trim());
  try {
    const launcher = readSettings(root).napcatLauncher;
    if (launcher !== '') {
      const text = readFileSync(launcher, 'utf8');
      const match = /cd\s+\/d\s+"([^"]+)"/i.exec(text);
      if (match?.[1] !== undefined) candidates.push(join(match[1], 'cache', 'qrcode.png'));
    }
  } catch {
    /* 启动脚本不存在时继续试默认路径 */
  }
  candidates.push(join('C:\\NapCatTest\\shell\\cache', 'qrcode.png'));
  candidates.push(join(homedir(), 'NapCat', 'shell', 'cache', 'qrcode.png'));
  let best: { path: string; mtime: number } | undefined;
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const mtime = statSync(path).mtimeMs;
      if (best === undefined || mtime > best.mtime) best = { path, mtime };
    } catch {
      /* 单个候选读不到不影响其它 */
    }
  }
  return best?.path;
}

/** 发布前清洗：去掉链接、QQ号/群号这类长数字，避免隐私外泄。 */
function sanitizeQzone(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/(?:QQ|qq|群号|群)\s*[:：]?\s*\d{5,}/g, '')
    .replace(/\b\d{7,}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 2000);
}

type QzoneSettings = Settings['qzone'];

/** 从已启用的表情包仓库里挑图；只读本地文件，不上传。 */
function pickQzoneImages(root: string, qzone: QzoneSettings, count: number): string[] {
  if (count <= 0) return [];
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'stickers.json'), 'utf8')) as {
      repos?: Array<{ id?: unknown }>;
      items?: Record<string, unknown>;
    };
    const repos = new Set(
      (parsed.repos ?? [])
        .map((r) => (typeof r.id === 'string' ? r.id : ''))
        .filter((id) => id !== ''),
    );
    const wanted = qzone.imageRepos.length > 0 ? new Set(qzone.imageRepos) : repos;
    const itemValues = Object.values(parsed.items ?? {});
    const candidates: string[] = [];
    for (const raw of itemValues) {
      if (raw === null || typeof raw !== 'object') continue;
      const item = raw as { file?: unknown; repoId?: unknown; status?: unknown };
      if (typeof item.file !== 'string' || item.file.trim() === '') continue;
      if (item.status !== undefined && item.status !== 'approved') continue;
      const repoId = typeof item.repoId === 'string' ? item.repoId : '';
      if (repoId === '' || !wanted.has(repoId)) continue;
      if (!/\.(?:png|jpe?g|gif|webp)$/i.test(item.file)) continue;
      const path = join(root, 'stickers', 'repos', repoId, item.file);
      if (existsSync(path)) candidates.push(path);
    }
    for (let i = candidates.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
    }
    return candidates.slice(0, Math.min(9, Math.max(0, count)));
  } catch {
    return [];
  }
}

/** 按设置决定 @ 谁：list = 随机名单；model = 交给提示词，不在这里强制。 */
function chooseQzoneMention(qzone: QzoneSettings): { qq: string; name: string } | undefined {
  if (qzone.mentionMode !== 'list' || qzone.mentionList.length === 0) return undefined;
  if (Math.random() >= qzone.mentionChance) return undefined;
  return qzone.mentionList[Math.floor(Math.random() * qzone.mentionList.length)];
}

/** 主动/被动：直接改群策略里的插话与冷场主动开口（其余概率沿用 qq.json）。 */
function applyMode(config: QqConfig, mode: Settings['mode']): QqConfig {
  const adjust = (policy: GroupPolicy): GroupPolicy =>
    mode === 'passive'
      ? { ...policy, activeChat: false, proactive: { ...policy.proactive, enabled: false } }
      : { ...policy, activeChat: true, proactive: { ...policy.proactive, enabled: true } };
  return {
    ...config,
    groups: Object.fromEntries(Object.entries(config.groups).map(([id, policy]) => [id, adjust(policy)])),
    defaultGroup: adjust(config.defaultGroup),
    // 私聊的策略表也要跟着切换，否则「被动模式」只关住了群、私聊照旧
    privates: Object.fromEntries(Object.entries(config.privates).map(([id, policy]) => [id, adjust(policy)])),
    defaultPrivate: adjust(config.defaultPrivate),
  };
}

function timeContext(): string {
  const now = new Date();
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `当前时间：${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}（星期${weekdays[now.getDay()]}）`;
}

function readDiary(root: string): DiaryEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(diaryPath(root), 'utf8')) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter(
      (e): e is DiaryEntry =>
        e !== null && typeof e === 'object' && typeof (e as DiaryEntry).ts === 'number' && typeof (e as DiaryEntry).thought === 'string',
    );
  } catch {
    return [];
  }
}

function writeDiary(root: string, entries: DiaryEntry[]): void {
  mkdirSync(root, { recursive: true });
  const kept = entries.length > DIARY_CAP ? entries.slice(-DIARY_CAP) : entries;
  writeFileSync(diaryPath(root), `${JSON.stringify({ entries: kept }, null, 2)}\n`, 'utf8');
}

function appendDiary(root: string, entry: DiaryEntry): void {
  const entries = readDiary(root);
  entries.push(entry);
  writeDiary(root, entries);
}

type RouteResult = { kind: 'json'; status: number; obj: unknown } | { kind: 'text'; status: number; body: string };

export function apply(ctx: any): void {
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-qq-group');
  mkdirSync(root, { recursive: true });

  // Cookie 清理不放在插件进程里：Chromium 运行期间独占锁住 Cookie 库，
  // 而且插件本身随 host 一起退出，清理必须由独立的系统级看门狗完成。
  // 由外部脚本定时清理过期登录态，避免触发风控。

  let previewSpeaker: Speaker | undefined;
  const getPreviewSpeaker = (): Speaker => {
    previewSpeaker ??= new Speaker({
      userRoot: root,
      cache: { dir: join(root, 'cache', 'tts') },
    });
    return previewSpeaker;
  };

  const profilesPath = join(root, 'profiles.json');
  const usagePath = join(root, 'usage.json');
  let profiles: ProfileFile = readProfiles(profilesPath);
  let profileSaveTimer: ReturnType<typeof setTimeout> | undefined;
  const saveProfilesSoon = (): void => {
    if (profileSaveTimer !== undefined) return;
    profileSaveTimer = setTimeout(() => {
      profileSaveTimer = undefined;
      try {
        writeProfiles(profilesPath, profiles);
      } catch (e) {
        console.warn(`[dsh-qq-group] 写画像失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }, 1500);
    profileSaveTimer.unref?.();
  };
  const profileRulesNow = (): ProfileRules => readSettings(root).profileRules;
  const profileStore: ProfileStore = {
    touch: (groupId, qq, name, options) => {
      if (qq === '') return;
      if (qq === readQqConfig(qqConfigPath(root)).config.ownerQq) return;
      touchUser(profiles, groupId, qq, name, { ...(options ?? {}), rules: profileRulesNow() });
      saveProfilesSoon();
    },
    get: (groupId, qq) => {
      if (qq === '') return undefined;
      const base = getProfile(profiles, groupId, qq, profileRulesNow());
      if (qq !== readQqConfig(qqConfigPath(root)).config.ownerQq) return base;
      const settings = readSettings(root);
      if (base !== undefined) {
        return { ...base, familiarity: settings.ownerFamiliarity, affinity: settings.ownerAffinity };
      }
      return {
        qq,
        name: '主人',
        familiarity: settings.ownerFamiliarity,
        affinity: settings.ownerAffinity,
        messages: 0,
        mentions: 0,
        replies: 0,
        days: [],
        lastSeen: 0,
        seeded: true,
      };
    },
    noteReply: (groupId, qq) => {
      if (qq === '' || qq === readQqConfig(qqConfigPath(root)).config.ownerQq) return;
      noteProfileReply(profiles, groupId, qq, profileRulesNow());
      saveProfilesSoon();
    },
    noteContinuation: (groupId, qq) => {
      if (qq === '' || qq === readQqConfig(qqConfigPath(root)).config.ownerQq) return;
      noteContinuation(profiles, groupId, qq, profileRulesNow());
      saveProfilesSoon();
    },
    noteQuote: (groupId, qq) => {
      if (qq === '' || qq === readQqConfig(qqConfigPath(root)).config.ownerQq) return;
      noteQuote(profiles, groupId, qq, profileRulesNow());
      saveProfilesSoon();
    },
    noteHostility: (groupId, qq, severity) => {
      if (qq === '' || qq === readQqConfig(qqConfigPath(root)).config.ownerQq) return;
      noteHostility(profiles, groupId, qq, severity, profileRulesNow());
      saveProfilesSoon();
    },
  };

  /** 旧画像补齐初始好感：主人 +60、白名单 +20（只补一次） */
  const seedExistingProfiles = (): void => {
    const cfg = readQqConfig(qqConfigPath(root)).config;
    const settings = readSettings(root);
    let changed = false;
    for (const group of Object.values(profiles.groups)) {
      for (const profile of Object.values(group.users)) {
        if (profile.seeded === true) continue;
        const initial =
          profile.qq === cfg.ownerQq
            ? settings.profileRules.initialOwnerAffinity
            : settings.whitelist.includes(profile.qq)
              ? settings.profileRules.initialWhitelistAffinity
              : 0;
        profile.affinity = Math.max(profile.affinity, initial);
        profile.seeded = true;
        changed = true;
      }
    }
    if (changed) writeProfiles(profilesPath, profiles);
  };
  seedExistingProfiles();

  /** 当前是否夜间（跨午夜也成立） */
  const isNightNow = (): boolean => {
    const settings = readSettings(root);
    if (!settings.nightDnd.enabled) return false;
    const hour = new Date().getHours();
    const { startHour, endHour } = settings.nightDnd;
    return startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
  };

  const rulesFor = (qq: string): ScoreRules => {
    const settings = readSettings(root);
    const ownerQq = readQqConfig(qqConfigPath(root)).config.ownerQq;
    return {
      owner: qq !== '' && qq === ownerQq,
      whitelist: qq !== '' && settings.whitelist.includes(qq),
      blacklist: qq !== '' && settings.blacklist.includes(qq),
      whitelistFloor: settings.whitelistFloor,
      blacklistCeil: settings.blacklistCeil,
      night: isNightNow(),
      nightPenalty: settings.nightPenalty,
      weights: settings.scoreWeights,
      initialOwnerAffinity: settings.profileRules.initialOwnerAffinity,
      initialWhitelistAffinity: settings.profileRules.initialWhitelistAffinity,
    };
  };

  /** 当前生效的模型（设置优先，否则跟随当前会话模型） */
  const effectiveModel = (): { sel: ModelRef; source: 'settings' | 'session' } => {
    const settings = readSettings(root);
    if (settings.model.provider !== '' && settings.model.model !== '') {
      return { sel: settings.model, source: 'settings' };
    }
    const fallback = ctx.agentDefaultModel?.currentSelection?.() as ModelRef | undefined;
    return { sel: fallback ?? { provider: '', model: '' }, source: 'session' };
  };

  /** 当前模型上下文窗口：设置覆盖优先，否则读 DSH 模型能力 */
  const modelWindowCache = new Map<string, number | undefined>();
  const getContextWindow = async (): Promise<number | undefined> => {
    const { sel } = effectiveModel();
    if (sel.provider === '' || sel.model === '') return undefined;
    const key = `${sel.provider}/${sel.model}`;
    const override = readSettings(root).contextWindows[key];
    if (override !== undefined && override > 0) return override;
    if (modelWindowCache.has(key)) return modelWindowCache.get(key);
    const llm = ctx.llm as
      | { resolveModelInfo?: (provider: string, model: string) => Promise<unknown> }
      | undefined;
    if (typeof llm?.resolveModelInfo !== 'function') return undefined;
    try {
      const info = (await llm.resolveModelInfo(sel.provider, sel.model)) as
        | { context?: { contextWindow?: unknown }; contextWindow?: unknown }
        | undefined;
      const raw = info?.context?.contextWindow ?? info?.contextWindow;
      const window = typeof raw === 'number' && Number.isFinite(raw) && raw >= 1000 ? Math.round(raw) : undefined;
      modelWindowCache.set(key, window);
      return window;
    } catch {
      modelWindowCache.set(key, undefined);
      return undefined;
    }
  };


  const lastJsonObject = (text: string): string | undefined => {
    for (let i = text.length - 1, tries = 0; i >= 0 && tries < 40; i -= 1) {
      if (text[i] !== '{') continue;
      tries += 1;
      const candidate = text.slice(i).trim();
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (parsed !== null && typeof parsed === 'object') return candidate;
      } catch {
        /* 继续往前找 */
      }
    }
    return undefined;
  };

  /** 走 DSH ctx.llm 生成一段回复（QQ 桥与「测试模型」共用） */
  const generate = async (
    system: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    user: string,
    options: {
      maxTokens?: number;
      timeoutMs?: number;
      purpose?: string;
      groupId?: string;
      retry?: boolean;
      reasoningEffort?: string;
      modelOverride?: ModelRef;
      images?: Array<{ data: Uint8Array; mediaType: string; name?: string }>;
      /** 诊断用：空文本时不再自动切备用/低推理重试 */
      noFallback?: boolean;
    } = {},
  ) => {
    const llm = ctx.llm as { stream(o: unknown): AsyncIterable<unknown> } | undefined;
    if (!llm || typeof llm.stream !== 'function') {
      return { ok: false as const, reason: 'generate-error', message: 'LLM 服务不可用' };
    }
    const { sel } = effectiveModel();
    const active = options.modelOverride ?? sel;
    if (active.provider === '' || active.model === '') {
      return { ok: false as const, reason: 'generate-error', message: '还没选群聊模型（设置 → QQ 群聊）' };
    }
    const imageBlocks: unknown[] = [];
    if (options.images !== undefined && options.images.length > 0) {
      const attachments =
        (ctx as { get?: (name: string) => unknown }).get?.('attachments') ??
        (ctx as { attachments?: unknown }).attachments;
      const service = attachments as { saveImages?: (inputs: unknown[]) => Promise<unknown[]> } | undefined;
      if (service !== undefined && typeof service.saveImages === 'function') {
        try {
          const refs = await service.saveImages(
            options.images.map((image) => ({
              data: image.data,
              mediaType: image.mediaType,
              ...(image.name === undefined ? {} : { name: image.name }),
            })),
          );
          imageBlocks.push(...refs.map((ref) => ({ type: 'image', attachment: ref })));
        } catch (e) {
          console.warn(`[dsh-qq-group] 图片存入 attachments 失败，本次按纯文字处理：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    const messages = [
      ...history.map((m) =>
        m.role === 'user'
          ? createUserMessage({ content: [{ type: 'text', text: m.content }], source: { kind: 'user' } })
          : createAssistantMessage({
              content: [{ type: 'text', text: m.content }],
              source: { provider: active.provider, model: active.model },
            }),
      ),
      createUserMessage({
        content: [{ type: 'text', text: user }, ...imageBlocks] as never,
        source: { kind: 'user' },
      }),
    ];
    const assembler = new BlockAssembler();
    const reasoningEffort = options.reasoningEffort ?? readSettings(root).reasoningEffort;
    let captured:
      | {
          inputTokens: number;
          outputTokens: number;
          totalTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          reasoningTokens?: number;
        }
      | undefined;
    try {
      for await (const chunk of llm.stream({
        provider: active.provider,
        model: active.model,
        sessionId: 'dsh-qq-group',
        messages,
        system,
        temperature: 0.9,
        ...(reasoningEffort === '' ? {} : { reasoningEffort: reasoningEffort as never }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
      })) {
        if (chunk !== null && typeof chunk === 'object' && (chunk as { type?: unknown }).type === 'usage') {
          const u = (chunk as { usage?: Record<string, unknown> }).usage;
          if (u !== undefined) {
            const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
            captured = {
              inputTokens: n(u.inputTokens),
              outputTokens: n(u.outputTokens),
              ...(typeof u.totalTokens === 'number' ? { totalTokens: n(u.totalTokens) } : {}),
              ...(typeof u.cacheReadTokens === 'number' ? { cacheReadTokens: n(u.cacheReadTokens) } : {}),
              ...(typeof u.cacheWriteTokens === 'number' ? { cacheWriteTokens: n(u.cacheWriteTokens) } : {}),
              ...(typeof u.reasoningTokens === 'number' ? { reasoningTokens: n(u.reasoningTokens) } : {}),
            };
          }
        }
        assembler.push(chunk as never);
      }
    } catch (e) {
      return { ok: false as const, reason: 'generate-error', message: e instanceof Error ? e.message : String(e) };
    }
    if (captured !== undefined) {
      try {
        appendUsage(usagePath, {
          ts: Date.now(),
          provider: active.provider,
          model: active.model,
          purpose: options.purpose ?? 'reply',
          ...(options.groupId === undefined || options.groupId === '' ? {} : { groupId: options.groupId }),
          ...(options.images === undefined || options.images.length === 0 ? {} : { images: options.images.length }),
          ...captured,
        });
      } catch {
        /* 用量落盘失败不影响回复 */
      }
    }
    const blocks = assembler.blocks();
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => ('text' in b ? String((b as { text: unknown }).text) : ''))
      .join('')
      .trim();
    if (captured === undefined) {
      // 模型没有返回 usage 时，用字符数做保守估算，避免统计成 0。
      const inputChars = system.length + user.length + history.reduce((sum, item) => sum + item.content.length, 0);
      const inputTokens = Math.ceil(inputChars / 4) + (options.images?.length ?? 0) * 800;
      try {
        appendUsage(usagePath, {
          ts: Date.now(),
          provider: active.provider,
          model: active.model,
          purpose: options.purpose ?? 'reply',
          ...(options.groupId === undefined || options.groupId === '' ? {} : { groupId: options.groupId }),
          ...(options.images === undefined || options.images.length === 0 ? {} : { images: options.images.length }),
          inputTokens,
          outputTokens: Math.ceil(text.length / 4),
          totalTokens: inputTokens + Math.ceil(text.length / 4),
          estimated: true,
        });
      } catch {
        /* 用量落盘失败不影响回复 */
      }
    }
    if (text === '') {
      const reasoningText = blocks
        .filter((b) => b.type === 'reasoning')
        .map((b) => ('text' in b ? String((b as { text: unknown }).text) : ''))
        .join('\n')
        .trim();
      const recovered = lastJsonObject(reasoningText);
      if (recovered !== undefined) {
        console.warn('[dsh-qq-group] 模型只返回了 reasoning，已从 reasoning 里提取 JSON 兜底');
        return { ok: true as const, text: recovered };
      }
      const kinds = blocks.map((b) => String((b as { type?: unknown }).type ?? '?')).join(',');
      console.warn(`[dsh-qq-group] 模型没有文本块（blocks=[${kinds}]）${options.retry === true ? '（重试仍失败）' : ''}`);
      if (options.noFallback === true) {
        return { ok: false as const, reason: 'generate-error', message: '模型未返回文本（诊断模式，未回退）' };
      }
      if (options.retry !== true) {
        const settings = readSettings(root);
        const fallback = settings.fallbackModel;
        const hasFallback =
          fallback.provider !== '' &&
          fallback.model !== '' &&
          !(fallback.provider === active.provider && fallback.model === active.model);
        if (hasFallback) {
          console.warn(`[dsh-qq-group] 尝试备用模型 ${fallback.provider}/${fallback.model} 重试一次…`);
          return generate(
            `${system}\n\n【重要】直接输出最终答案/JSON，不要输出任何思考过程，也不要只给 reasoning。`,
            history,
            user,
            { ...options, retry: true, modelOverride: fallback, reasoningEffort: 'low' },
          );
        }
        if (reasoningText === '') {
          // 连 reasoning 都没有：多半是上游 429/空响应，重试同一模型只会再撞一次
          console.warn('[dsh-qq-group] 上游返回空响应（无 reasoning），本次不重试');
        } else {
          // 有 reasoning 没正文：用低推理档 + 明确“直接输出”的指令重试一次
          console.warn('[dsh-qq-group] 尝试低推理重试一次…');
          return generate(
            `${system}\n\n【重要】直接输出最终答案/JSON，不要输出任何思考过程，也不要只给 reasoning。`,
            history,
            user,
            { ...options, retry: true, reasoningEffort: 'low' },
          );
        }
      }
    }
    return text !== ''
      ? { ok: true as const, text }
      : { ok: false as const, reason: 'generate-error', message: '模型未返回文本' };
  };

  /** TCP 端口是否可连（判断 NapCat 的 OneBot 服务是否起来了） */
  const portOpen = (host: string, port: number, timeoutMs = 800): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = connect({ host, port });
      const done = (value: boolean): void => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });

  const wsTarget = (url: string): { host: string; port: number } | undefined => {
    try {
      const parsed = new URL(url);
      const port = Number(parsed.port || (parsed.protocol === 'wss:' ? 443 : 80));
      return parsed.hostname === '' ? undefined : { host: parsed.hostname, port };
    } catch {
      return undefined;
    }
  };

  /**
   * 「点启动」时顺便把 NapCat 拉起来：
   * 端口通 → 直接用；不通 → 跑设置里的启动脚本并等端口就绪（最多 30 秒）。
   */
  const ensureNapcat = async (): Promise<{ ok: boolean; launched: boolean; message: string }> => {
    const cfg = readQqConfig(qqConfigPath(root)).config;
    const target = wsTarget(cfg.url);
    if (target === undefined) return { ok: false, launched: false, message: 'OneBot 地址不合法：' + cfg.url };
    if (await portOpen(target.host, target.port)) return { ok: true, launched: false, message: 'NapCat 已在运行' };
    const settings = readSettings(root);
    if (!settings.autoLaunchNapcat) {
      return { ok: false, launched: false, message: 'NapCat 未运行（自动拉起已关闭）' };
    }
    const launcher = settings.napcatLauncher;
    if (!existsSync(launcher)) {
      return { ok: false, launched: false, message: 'NapCat 启动脚本不存在：' + launcher };
    }
    try {
      const child = spawn(launcher, [], { detached: true, stdio: 'ignore', shell: true, windowsHide: false });
      child.unref();
    } catch (e) {
      return {
        ok: false,
        launched: false,
        message: '启动 NapCat 失败：' + (e instanceof Error ? e.message : String(e)),
      };
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (await portOpen(target.host, target.port)) return { ok: true, launched: true, message: '已拉起 NapCat' };
    }
    return {
      ok: false,
      launched: true,
      message: '已尝试启动 NapCat，但 30 秒内端口未就绪（可能需要扫码登录）',
    };
  };

  /** 启动插件时确保本地 TTS 网关在线；失败不阻塞聊天，只返回提示。 */
  const ensureTtsGateway = async (): Promise<{ ok: boolean; launched: boolean; message: string }> => {
    const tts = readQqConfig(qqConfigPath(root)).config.tts;
    if (tts.provider === 'edge') return { ok: true, launched: false, message: 'Edge 不需要本地服务' };
    const endpoint = tts.endpoint.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(endpoint)) {
      return { ok: true, launched: false, message: '非本地网关，跳过自动启动' };
    }
    const probe = async (): Promise<boolean> => {
      try {
        const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2_000) });
        return response.ok;
      } catch {
        return false;
      }
    };
    if (await probe()) return { ok: true, launched: false, message: '本地 TTS 网关已在线' };
    if (tts.serviceScript.trim() === '') {
      return { ok: false, launched: false, message: '本地 TTS 网关离线，且未配置启动脚本' };
    }
    try {
      spawn('cmd.exe', ['/c', tts.serviceScript], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } catch (e) {
      return { ok: false, launched: false, message: `启动脚本失败：${e instanceof Error ? e.message : String(e)}` };
    }
    for (let i = 0; i < 15; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (await probe()) return { ok: true, launched: true, message: '已自动拉起本地 TTS 网关' };
    }
    return { ok: false, launched: true, message: '已执行启动脚本，但 30 秒内网关仍未就绪' };
  };

  /**
   * QQ 空间：她自己决定发不发、发几条、写什么、配几张图。
   *
   * 以前是 autoChance 掷骰 + dailyLimit + minIntervalMinutes 三道闸，等于让随机数替她过日子。
   * 现在发不发由她自己判断——把最近的记忆给她，问「现在想发吗」，不想就回「不发」。
   *
   * ── 2026-10-28 修「连续刷屏」────────────────────────────────────────────
   * 事故：这个函数原本挂在「每写一条日记」上，而日记是每条群消息都写一条。
   * 于是她一说话就给一次发说说的机会，一天下来发了 61 条，还是成片连着发的。
   *
   * 教训：把「要不要发」交给她没错，但**频次不能也交给她**。
   * 她看到的是「现在想不想发」，看不到「我刚才十五分钟里已经发了十二条」。
   * 频次是我们该管的事，所以这里把 dailyLimit / minIntervalMinutes 重新接回来，
   * 并且多加一道「同一次对话里只问一次」的内存节流，避免每条消息都去调一次模型。
   */
  /** 上一次真的去问她的时间（毫秒）。进程内节流用，不落盘。 */
  let lastQzoneAskAt = 0;

  const maybeAutoQzone = async (entry: DiaryEntry): Promise<void> => {
    const qz = readSettings(root).qzone;
    if (!qz.enabled || qz.mode !== 'auto') return;

    const now = Date.now();
    // ① 进程内节流：同一段时间里连续聊天，只问一次，别每条消息都烧一次模型。
    if (now - lastQzoneAskAt < 10 * 60_000) return;

    // ② 硬限制：每天条数 + 最小间隔。这两个是她自己看不到、只有我们能数的。
    const history = readQzone(root);
    const dayStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()).getTime();
    const todayCount = history.filter((item) => item.ts >= dayStart).length;
    if (qz.dailyLimit > 0 && todayCount >= qz.dailyLimit) return;
    const last = history[history.length - 1];
    if (last !== undefined && qz.minIntervalMinutes > 0 && now - last.ts < qz.minIntervalMinutes * 60_000) return;

    lastQzoneAskAt = now;
    const recentPosts = history
      .slice(-12)
      .map((item) => `- ${new Date(item.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}：${item.content.slice(0, 60)}`)
      .join('\n');
    const systemLines = [
      '你是鲸鱼娘，在决定要不要发一条 QQ 空间说说。',
      '要不要发、发什么、写多长、配几张图，全由你自己定。短到一句、长到一段都行。',
      '不想发就只输出一个词：不发',
      '想发就只输出要说的话本身，像自己随手记的：有画面、有情绪、口语。不要复述群聊原文，不要提 AI、模型、插件。',
      '绝对不能出现：QQ 号、群号、人名、文件路径、链接、任何隐私。',
      recentPosts === '' ? '你最近还没发过。' : `你最近发过的（不必和这些重复，也不必回避）：
${recentPosts}`,
    ];
    const user = `刚才的一点片段：群友说「${(entry.incoming ?? '').slice(0, 160)}」；你说「${entry.reply.slice(0, 200)}」；心里「${(entry.thought ?? '').slice(0, 200)}」\n\n现在想发条说说吗？`;
    const result = await generate(systemLines.join('\n'), [], user, { purpose: 'qzone', maxTokens: 600, timeoutMs: 40_000 });
    if (!result.ok) return;
    const raw = result.text.trim();
    if (raw === '' || raw === '不发' || /^不发[。.!！]?$/u.test(raw)) return;
    const mention = qz.mentionMode === 'model' ? chooseQzoneMention(qz) : undefined;
    let content = sanitizeQzone(raw);
    if (content === '') return;
    if (mention !== undefined && !content.startsWith('@')) content = `@${mention.name} ${content}`.slice(0, 2000);
    // 配图也交给她：让她自己说配几张。
    let imageCount = 0;
    if (qz.imageMode !== 'off') {
      const decided = await generate('这条说说要配几张图？只输出一个 0 到 9 的整数，不要解释。', [], content, {
        purpose: 'qzone-image',
        maxTokens: 20,
        timeoutMs: 15_000,
      });
      const match = decided.ok ? /\d+/u.exec(decided.text) : null;
      imageCount = match === null ? 0 : Number(match[0]);
    }
    imageCount = Math.max(0, Math.min(9, Math.round(imageCount)));
    const images = pickQzoneImages(root, qz, imageCount);
    const published = (await qqHost.qzone('publish', { content, ugcRight: qz.ugcRight, images })) as {
      ok?: boolean;
      tid?: string;
    };
    if (published.ok === true) {
      appendQzone(root, {
        tid: published.tid ?? '',
        content,
        ts: Date.now(),
        ugcRight: qz.ugcRight,
        ...(images.length > 0 ? { images } : {}),
      });
    }
  };

  let worldRelay: WorldRelay | undefined;
  /**
   * 群聊见闻：群里的话一进来就记下来。
   * 同时写两份：
   *  - room/群近况.md   她读的（最近 40 条，滚动；和 QQ 插件读的是同一份）
   *  - group-digest.json    主人看的（结构化，可筛选/删除/看时间）
   */
  type DigestEntry = { id: string; at: number; groupId: string; name: string; text: string; self: boolean };
  const digestPath = (): string => join(root, 'group-digest.json');
  const readDigest = (): DigestEntry[] => {
    try {
      const parsed = JSON.parse(readFileSync(digestPath(), 'utf8')) as { entries?: unknown };
      if (!Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter(
        (item): item is DigestEntry =>
          item !== null &&
          typeof item === 'object' &&
          typeof (item as DigestEntry).text === 'string' &&
          typeof (item as DigestEntry).at === 'number',
      );
    } catch {
      return [];
    }
  };
  const writeDigest = (entries: DigestEntry[]): void => {
    const kept = entries.length > 600 ? entries.slice(-600) : entries;
    writeFileSync(digestPath(), `${JSON.stringify({ entries: kept }, null, 2)}\n`, 'utf8');
  };
  const renderDigestFile = (entries: DigestEntry[]): void => {
    try {
      const settings = readSettings(root);
      const bridge = readWorldBridge(root, settings.worldBridge);
      if (!bridge.worldDir || !bridge.enabled) return;
      const target = join(bridge.worldDir, 'room', '群近况.md');
      // 改名迁移：老文件叫「群里的近况.md」，新名字是「群近况.md」。
      // 先把旧内容搬过去再写，历史不丢；旧文件留着当备份不删。
      const legacy = join(bridge.worldDir, 'room', '群里的近况.md');
      if (existsSync(legacy) && !existsSync(target)) {
        try {
          copyFileSync(legacy, target);
        } catch {
          /* 迁不动就直接覆盖写，下面照样会写新内容 */
        }
      }
      const keep = readSettings(root).groupDigest.fileLines;
      const recent = entries.slice(-keep);
      mkdirSync(dirname(target), { recursive: true });
      const note = [
        '# 群近况',
        '',
        '这是我在 QQ 群里刚听到的话。不是工作记录，是家里外面的动静。',
        '',
        `更新时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
        '',
        ...recent.map((entry) => {
          const time = new Date(entry.at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
          return `- ${time} 群${entry.groupId}｜${entry.name}：${entry.text}`;
        }),
      ].join('\n');
      writeFileSync(target, `${note}\n`, 'utf8');
    } catch (e) {
      console.warn(`[dsh-qq-group] 群聊见闻文件写入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const pushGroupDigest = (entry: { groupId: string; name: string; text: string; self?: boolean }): void => {
    try {
      const settings = readSettings(root);
      if (!readWorldBridge(root, settings.worldBridge).enabled) return;
      const text = entry.text.replace(/\s+/gu, ' ').trim().slice(0, 200);
      if (text === '') return;
      const entries = readDigest();
      entries.push({
        id: `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        at: Date.now(),
        groupId: entry.groupId,
        name: entry.name.slice(0, 40),
        text,
        self: entry.self === true,
      });
      writeDigest(entries);
      renderDigestFile(entries);
    } catch (e) {
      console.warn(`[dsh-qq-group] 群聊见闻写入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * 记忆中心钩子：日记/相册/流水一律写进家目录的分片，成品留给世界折。
   * 家没配（worldBridge 关着或目录不可用）就返回失败原因，聊天不受影响。
   */
  const hubDir = (): string => {
    const settings = readSettings(root);
    if (!settings.worldBridge.enabled) return '';
    return readWorldBridge(root, settings.worldBridge).worldDir;
  };
  const memoryHub = {
    writeDiary: (text: string): { ok: boolean; message?: string } => {
      const dir = hubDir();
      if (dir === '') return { ok: false, message: '世界桥没开或没配目录' };
      const result = appendQqDiarySection(dir, text);
      if (!result.ok) return { ok: false, message: result.message };
      syncTraceBlock();
      return { ok: true };
    },
    keepAlbum: (note: string, images: Array<{ data: Uint8Array; mediaType: string }>): { ok: boolean; message?: string } => {
      const dir = hubDir();
      if (dir === '') return { ok: false, message: '世界桥没开或没配目录' };
      if (images.length === 0) return { ok: false, message: '这一条没有可留的图' };
      let last = '';
      for (const image of images.slice(0, 4)) {
        const ext = image.mediaType.split('/')[1] ?? 'jpg';
        const kept = keepAlbumImage(dir, { data: image.data, ext }, note);
        if (!kept.ok) return { ok: false, message: kept.message };
        last = kept.file;
      }
      return { ok: last !== '', ...(last === '' ? { message: '没有写成' } : {}) };
    },
    recordTurn: (entry: { role: 'user' | 'assistant'; content: string; session: string; name?: string }): void => {
      const dir = hubDir();
      if (dir === '') return;
      appendQqTurn(dir, entry);
    },
    recentTurns: (limit?: number): string => {
      const dir = hubDir();
      if (dir === '') return '';
      const policy = readMemoryPolicy(dir);
      if (!policy.ok) return '';
      // 以前硬顶 20 条，和「群聊同步私聊 12 条」一起把私聊记忆截得很短。
      // 现在按设置走，最多 500 条；上限只防手滑填个天文数字。
      const turns = readRecentTurns(dir, { limit: Math.max(4, Math.min(500, limit ?? policy.policy.contextTurns)), days: 7 });
      return turns
        .map((turn) => `${turn.role === 'assistant' ? '她' : '对方'}：${turn.content.replace(/\s+/gu, ' ').trim().slice(0, 200)}`)
        .join('\n');
    },
  };

  const qqHost = createQqHost({
    userRoot: root,
    persona: (groupId?: string) => activePersona(readSettings(root), groupId),
    ownerPriority: () => readSettings(root).ownerPriorityPrompt,
    // 群聊也读同一份记忆痕迹：和主人的记忆 + 群聊记忆
    sharedTranscript: () => readSettings(root).sharedTranscript.enabled === true,
    sharedTranscriptTurns: () => readSettings(root).sharedTranscript.turns,
    revealPrivateInGroup: () => readSettings(root).sharedTranscript.revealToGroup === true,
    // 每条消息都会戳一次：15 秒内只认真一次，攒够了就立刻提炼。
    tracePoke: () => {
      const now = Date.now();
      if (now - lastTracePoke < 15_000) return;
      lastTracePoke = now;
      try {
        const memoryPath = join(root, 'qq-memory.json');
        if (!existsSync(memoryPath)) return;
        const memory = JSON.parse(readFileSync(memoryPath, 'utf8')) as {
          groups?: Record<string, { turns?: Array<{ ts?: number }> }>;
        };
        const cursorPath = join(root, 'group-trace-cursor.json');
        const cursor: Record<string, number> = existsSync(cursorPath)
          ? ((JSON.parse(readFileSync(cursorPath, 'utf8')) as Record<string, number>) ?? {})
          : {};
        let backlog = 0;
        for (const [gid, group] of Object.entries(memory.groups ?? {})) {
          if (gid.startsWith('p:')) continue;
          const since = cursor[gid] ?? 0;
          for (const turn of group.turns ?? []) {
            if (typeof turn.ts === 'number' && turn.ts > since) backlog += 1;
          }
        }
        // 积压超过一个窗口就立刻追；不到就交给定时器。
        if (backlog >= 30) void extractGroupTraces();
      } catch {
        /* 读不出来就交给定时器 */
      }
    },
    traceRecall: (query: string) =>
      recallForChat(traceStoreDir(), query, 6).map(
        (trace) =>
          `${trace.domain === 'group' ? '群聊' : '和主人'}${trace.happenedAt ? `｜${new Date(trace.happenedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : ''}${trace.people !== undefined && trace.people.length > 0 ? `｜${trace.people.slice(0, 3).join('、')}` : ''}｜重要 ${trace.importance.toFixed(1)}｜想起 ${trace.recallCount} 次：${trace.text.replace(/\n/gu, ' / ').slice(0, 300)}`,
      ),
    timeContext,
    generate: (system, history, user, options) => generate(system, history, user, options),
    log: (level, message) => {
      const line = `[dsh-qq-group] ${message}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
      try {
        appendFileSync(join(root, 'qq-debug.log'), `${new Date().toISOString()} [${level}] ${message}\n`, 'utf8');
      } catch {
        /* 日志失败不影响运行 */
      }
    },
    stickers: createStickerHub(root, {
      saveEnabled: () => readSettings(root).stickerSave,
      filter: () => readSettings(root).stickerFilter,
      saveRepo: () => readSettings(root).stickerSaveRepo,
      analyzeOnSave: () => readSettings(root).stickerAnalyzeOnSave,
      maxItems: () => readSettings(root).stickerMax,
      maxMB: () => readSettings(root).stickerMaxMB,
      analyze: async (context) => {
        const system = [
          '你在帮 QQ 群里的鲸鱼娘整理表情包。',
          '你看不到图片本身，只能根据“发图时大家在聊什么”猜测它的含义。',
          '只输出 JSON：{"tags":["3~6个短标签"],"description":"一句含义/使用场景"}。',
          '标签用中文，例如：无语、翻白眼、猫猫、嘲讽、开心、安慰、装傻。',
          '如果上下文完全看不出含义，就输出 {"tags":["未分类"],"description":"未分类"}。',
        ].join('\n');
        const user = [`发图的人：${context.sender}`, '最近聊天：', ...context.recent].join('\n');
        const result = await generate(system, [], user, {
          purpose: 'sticker',
          timeoutMs: 20_000,
          ...(typeof (context as { groupId?: unknown }).groupId === 'string'
            ? { groupId: (context as { groupId: string }).groupId }
            : {}),
        });
        if (!result.ok) return undefined;
        try {
          const match = /\{[\s\S]*\}/.exec(result.text);
          if (match === null) return undefined;
          const parsed = JSON.parse(match[0]) as { tags?: unknown; description?: unknown };
          const tags = Array.isArray(parsed.tags)
            ? parsed.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').slice(0, 8)
            : [];
          const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
          if (description === '') return undefined;
          return { tags: tags.length > 0 ? tags : ['未分类'], description };
        } catch {
          return undefined;
        }
      },
      log: (message) => console.warn(`[dsh-qq-group] ${message}`),
    }),
    stickerSaveEnabled: () => readSettings(root).stickerSave,
    selfies: createSelfieHub(root),
    qzoneRecent: (limit: number) =>
      readQzone(root)
        .slice(-Math.max(1, Math.min(20, limit)))
        .map((entry) => ({ content: entry.content, ts: entry.ts })),
    permanent: {
      enabled: () => readSettings(root).permanent.enabled,
      autoCapture: () => readSettings(root).permanent.autoCapture,
      people: () => readSettings(root).permanent.people,
      recallLimit: () => readSettings(root).permanent.recallLimit,
      recallChars: () => readSettings(root).permanent.recallChars,
      add: (groupId, input) => {
        const permanent = readSettings(root).permanent;
        const capacity = input.scope === 'global' ? permanent.globalCapacity : permanent.capacity;
        return permanentAdd(root, groupId, input, capacity);
      },
      list: (groupId, scope) => permanentList(root, groupId, scope),
    },
    computer: {
      enabled: () => readSettings(root).computerUse.enabled,
      maxSteps: () => readSettings(root).computerUse.maxSteps,
      run: (tool, args) =>
        runComputerTool(join(PLUGIN_DIR, '..', 'resources', 'windows-driver.ps1'), tool, args, computerHost),
    },
    worldSay: (text, options) => {
      const bridge = readSettings(root).worldBridge;
      if (!bridge.enabled || bridge.privateBackend !== 'world') return false;
      syncWorldPermanent(root, bridge);
      syncPersonaToWorld();
      if (autoRecallTraces(traceStoreDir(), text).length > 0) syncTraceBlock();
      return worldRelay?.enqueue(text, options) ?? false;
    },
    memoryHub,
    transcribeVoice: async (audio) => {
      const service = (ctx as { get?: (name: string) => unknown; speechToText?: unknown }).get?.('speechToText')
        ?? (ctx as { speechToText?: unknown }).speechToText;
      const speech = service as {
        resolve?: (request: { audio: Uint8Array; language?: string }) => unknown;
        transcribe?: (spec: unknown, signal: AbortSignal) => Promise<{ text?: unknown }>;
      } | undefined;
      if (speech === undefined || typeof speech.resolve !== 'function' || typeof speech.transcribe !== 'function') {
        return undefined;
      }
      try {
        const spec = speech.resolve({ audio, language: 'zh' });
        const result = await speech.transcribe(spec, AbortSignal.timeout(120_000));
        return typeof result.text === 'string' ? result.text : undefined;
      } catch (e) {
        console.warn(`[dsh-qq-group] 语音转写失败：${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    },
    onDiary: (entry) => {
      try {
        appendDiary(root, entry);
      } catch (e) {
        console.warn(`[dsh-qq-group] 写日记失败：${e instanceof Error ? e.message : String(e)}`);
      }
      // 群里一说话就写进她的家，实时，不攒批。
      try {
        if (entry.incoming.trim() !== '') {
          pushGroupDigest({ groupId: entry.groupId, name: entry.user || '有人', text: entry.incoming });
        }
        if (entry.reply.trim() !== '') {
          pushGroupDigest({ groupId: entry.groupId, name: '我', text: entry.reply, self: true });
        }
      } catch {
        /* 见闻写入失败不影响群聊 */
      }
      // QQ 空间：每有一条她真正说过的话，就给她一次「想不想发说说」的机会。
      // 发不发、发什么、多长、配几张图，都是她自己定（见 maybeAutoQzone）。
      void maybeAutoQzone(entry).catch((e: unknown) => {
        console.warn(`[dsh-qq-group] QQ 空间处理失败：${e instanceof Error ? e.message : String(e)}`);
      });
    },
    profiles: profileStore,
    rules: rulesFor,
    hostilityJudge: () => readSettings(root).hostilityJudge,
    safety: () => readSettings(root).safety,
    contextWindow: getContextWindow,
  });

  worldRelay = new WorldRelay({
    // 私聊那一路可能走另一个世界（worldBridge.privateWorldId）。
    // 留空就和群聊同一个世界，行为和以前完全一样。
    getInfo: () => {
      const bridge = readSettings(root).worldBridge;
      const privateId = bridge.privateWorldId.trim();
      if (privateId === '' || privateId === bridge.worldId.trim()) {
        return readWorldBridge(root, bridge);
      }
      // 指定了私聊世界：按世界 ID 重新解析目录（worldDir 是给主世界留的手动覆盖）
      return readWorldBridge(root, { enabled: bridge.enabled, worldId: privateId, worldDir: '' });
    },
    deliver: async (text, kind, options) => {
      const owner = readQqConfig(qqConfigPath(root)).config.ownerQq.trim();
      if (owner === '') {
        console.warn('[dsh-qq-group] dsh-world 回复无法送达：ownerQq 为空');
        return;
      }
      const result = await qqHost.sendPrivateText(owner, text, options);
      if (result.ok !== true) {
        console.warn(`[dsh-qq-group] dsh-world 回复发送失败：${String(result.message ?? '')}`);
      } else {
        console.log(`[dsh-qq-group] dsh-world 已回 QQ 私聊（${kind}）`);
      }
    },
    notify: async (text) => {
      const owner = readQqConfig(qqConfigPath(root)).config.ownerQq.trim();
      if (owner !== '') await qqHost.sendPrivateText(owner, text);
    },
    timeoutMs: 240_000,
    settleMs: () => readSettings(root).worldBridge.settleMs,
    log: (message) => console.warn(`[dsh-qq-group] ${message}`),
    record: (entry) => {
      try {
        appendFileSync(join(root, 'world-delivery.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
      } catch {
        /* 留痕失败不影响投递 */
      }
    },
  });

  /** 常驻的桌面操作宿主：C# 只编译一次，之后每次操作几十毫秒。 */
  const computerHost = new ComputerHost(join(PLUGIN_DIR, '..', 'resources'));
  /** 群消息触发提炼的节流时间戳 */
  let lastTracePoke = 0;
  const traceStoreDir = (): string => readWorldBridge(root, readSettings(root).worldBridge).worldDir;
  /**
   * 世界人设跟随 QQ 插件：只认 QQ 那边选的角色卡。
   * 「p:<主人QQ>」这个私聊绑了哪张卡，她的世界就用哪张；没单独绑就用全局激活那张。
   * 每次私聊送进世界、以及设置里一改绑定，都同步一次。
   */
  const syncPersonaToWorld = (): void => {
    try {
      const settings = readSettings(root);
      const bridge = settings.worldBridge;
      if (!bridge.enabled) return;
      const ownerQq = readQqConfig(qqConfigPath(root)).config.ownerQq.trim();
      if (ownerQq === '') return;
      syncWorldPersona(root, bridge, ownerQq, settings);
    } catch {
      /* 人设同步失败不挡聊天 */
    }
  };
  // 启动时先同步一次，别等她说完第一句才想起来。
  syncPersonaToWorld();
  const rankedTraces = (): Array<Record<string, unknown>> => {
    const now = Date.now();
    return rankTraces(loadTraces(traceStoreDir()), now).map((trace) => ({
      ...trace,
      activation: traceActivation(trace, now),
      effectiveHalfLifeDays: effectiveHalfLife(trace),
      ageDays: Math.max(0, (now - trace.createdAt) / 86_400_000),
      score: trace.score,
    }));
  };
  const migratePermanentToTraces = (): void => {
    try {
      const path = join(root, 'permanent-memory.json');
      const store = readPermanentStore(path);
      if (store.global.items.length === 0) return;
      const migrated = store.global.items.length;
      const dir = traceStoreDir();
      for (const item of store.global.items) {
        upsertTrace(
          dir,
          makeTrace({
            text: item.text,
            domain: 'owner',
            importance: item.sensitivity === 'private' ? 0.85 : 0.65,
            emotion: 0.4,
            createdAt: item.createdAt,
            source: 'manual',
          }),
        );
      }
      store.global = { items: [], updatedAt: Date.now() };
      writePermanentStore(path, store);
      console.log(`[dsh-qq-group] 已迁移 ${migrated} 条全局永久记忆到痕迹层`);
    } catch (e) {
      console.warn(`[dsh-qq-group] 永久记忆迁移失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  migratePermanentToTraces();
  const syncTraceBlock = (): void => {
    try {
      const worldDir = traceStoreDir();
      if (worldDir === '') return;
      const legacy = join(root, 'memory-traces.json');
      const target = join(worldDir, 'memory-traces.json');
      if (existsSync(legacy) && !existsSync(target)) {
        writeFileSync(target, readFileSync(legacy));
      }
      // 记忆块 + 今天的日记分片提示：只在有分片的那天出现一句，没分片不占上下文。
      // 群近况也拼进同一块：家读记忆时自然读到群里刚发生的事，
      // 来源和 QQ 插件、控制台「群对话」页完全同一份（group-digest.json → 群近况.md）。
      const block = renderTraceBlock(worldDir);
      const digestTail = (() => {
        try {
          const lines = readSettings(root).groupDigest.memoryLines;
          if (lines <= 0) return '';
          const entries = readDigest().slice(-lines);
          if (entries.length === 0) return '';
          return [
            '',
            '【群里最近的动静（和 QQ 插件读的是同一份）】',
            ...entries.map((entry) => {
              const time = new Date(entry.at).toLocaleTimeString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour12: false,
              });
              return `- ${time} 群${entry.groupId}｜${entry.name}：${entry.text}`;
            }),
            '完整那份在 room/群近况.md；这里只是最近几条，别逐条复述。',
          ].join('\n');
        } catch {
          return '';
        }
      })();
      const hint = fragmentHint(worldDir);
      /**
       * 共用记忆：永久记忆 + 记忆 v3。
       *
       * 以前这两份只有群聊读得到，世界私聊完全看不见——同一个她，两个脑子。
       * 现在把它们也拼进世界提示词，做到「一份存储、两路读取」。
       * 条数有上限，避免把世界提示词撑爆。
       */
      const sharedMemory = ((): string => {
        const out: string[] = [];
        try {
          const ownerKey = `p:${readQqConfig(qqConfigPath(root)).config.ownerQq}`;
          const perm = [
            ...permanentList(root, ownerKey, 'global'),
            ...permanentList(root, ownerKey, 'session'),
          ];
          if (perm.length > 0) {
            out.push(
              [
                '【永久记忆（和 QQ 群聊读的同一份，主人指定要记住的）】',
                ...perm.slice(-20).map((entry) => `- ${entry.text}`),
              ].join('\n'),
            );
          }
          const store = readMemoryStoreV3(join(root, 'memory-v3.json'));
          const items = listMemoriesV3(store, ownerKey)
            .slice()
            .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
            .slice(0, 10);
          if (items.length > 0) {
            out.push(
              [
                '【长期记忆（按重要度取前 10 条，和群聊同一份）】',
                ...items.map((item) => `- ${item.text}`),
              ].join('\n'),
            );
          }
        } catch {
          /* 读不到就不注入，不影响主流程 */
        }
        return out.join('\n\n');
      })();
      /**
       * 当天日记素材：插件那边记的「每条回复 + 评分理由 + 内心吐槽」。
       *
       * 这是给写日记用的原料，不是记忆本身。晚上她自己写日记时读一下，
       * 把群里的原话、当时的吐槽提炼进当天的世界日记——日记只有世界这一本。
       */
      const diaryMaterial = ((): string => {
        try {
          const file = join(root, 'diary.json');
          if (!existsSync(file)) return '';
          const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries?: Array<Record<string, unknown>> };
          const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
          const startOfDay = new Date();
          startOfDay.setHours(0, 0, 0, 0);
          const today = entries.filter((e) => typeof e.at === 'number' && e.at >= startOfDay.getTime());
          if (today.length === 0) return '';
          const lines = today.slice(-40).map((e) => {
            const time = new Date(Number(e.at)).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
            const where = String(e.groupId ?? '').startsWith('p:') ? '私聊' : '群';
            const reply = String(e.reply ?? e.text ?? '').replace(/\s+/gu, ' ').slice(0, 90);
            const thought = String(e.thought ?? '').replace(/\s+/gu, ' ').slice(0, 60);
            return `- ${time} ${where}｜我：${reply}${thought === '' ? '' : `｜当时想：${thought}`}`;
          });
          return [
            '【今天值得写进日记的素材（QQ 那边记的，不是记忆）】',
            ...lines,
            '晚上写日记时可以翻一翻，提炼成自己的话；不要照抄。',
          ].join('\n');
        } catch {
          return '';
        }
      })();
      const merged = [block, digestTail, sharedMemory, diaryMaterial, hint].filter((part) => part !== '').join('\n\n');
      syncTracePrompt(join(worldDir, 'world-prompt.md'), merged);
    } catch {
      /* 记忆渲染失败不影响 QQ */
    }
  };
  // 「群里的近况.md」→「群近况.md」：启动时先迁一次，别等群里下一句话。
  {
    try {
      const worldDir = readWorldBridge(root, readSettings(root).worldBridge).worldDir;
      if (worldDir !== '') {
        const legacy = join(worldDir, 'room', '群里的近况.md');
        const target = join(worldDir, 'room', '群近况.md');
        if (existsSync(legacy) && !existsSync(target)) {
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(legacy, target);
          // 迁完立刻按新格式重写一遍：光复制标题还是旧的。
          renderDigestFile(readDigest());
          console.log('[dsh-qq-group] 群里的近况.md 已迁到 群近况.md，并按新格式重写（旧文件保留作备份）');
        }
      }
    } catch (e) {
      console.warn(`[dsh-qq-group] 群近况改名失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 容量口径：读不到就报给主人，不各自兜底（兜底两次就会长出第三个真相源）。
  {
    const worldDir = readWorldBridge(root, readSettings(root).worldBridge).worldDir;
    if (worldDir !== '') {
      const policy = readMemoryPolicy(worldDir);
      if (!policy.ok) console.warn(`[dsh-qq-group] 记忆容量口径不可用：${policy.message}`);
      else if (policy.seeded) console.log('[dsh-qq-group] 已写入记忆容量口径种子 memory-policy.json');
    }
  }
  syncTraceBlock();

  ctx.effect(() => {
    let cancelled = false;
    const stateFile = join(root, 'wake-state.json');
    let timer: ReturnType<typeof setInterval> | undefined;
    const dayKey = (date: Date): string =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const tryWake = (): void => {
      if (cancelled) return;
      const settings = readSettings(root);
      if (
        !settings.worldBridge.enabled ||
        !settings.worldBridge.wakeOnStart ||
        settings.worldBridge.privateBackend !== 'world'
      ) {
        return;
      }
      const now = new Date();
      if (now.getHours() < 6) return;
      const today = dayKey(now);
      try {
        const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as { lastWakeDay?: unknown };
        if (saved.lastWakeDay === today) return;
      } catch {
        /* 首次没有状态文件 */
      }
      if (worldRelay?.enqueue('[开机] 主人来了，醒醒。', {}) !== true) return;
      try {
        writeFileSync(stateFile, JSON.stringify({ lastWakeDay: today, at: now.toISOString() }, null, 2), 'utf8');
      } catch {
        /* 状态写失败最多导致下一次重启再发一次 */
      }
      if (timer !== undefined) clearInterval(timer);
    };
    const initial = setTimeout(tryWake, 5000);
    timer = setInterval(tryWake, 5 * 60_000);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      if (timer !== undefined) clearInterval(timer);
    };
  }, 'dsh-qq-group: wake world on start');

  ctx.effect(() => {
    let cancelled = false;
    const stateFile = join(root, 'review-catchup.json');
    const dayKey = (date: Date): string =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const check = (): void => {
      if (cancelled) return;
      const settings = readSettings(root);
      if (!settings.worldBridge.enabled || settings.worldBridge.privateBackend !== 'world') return;
      const now = new Date();
      if (now.getHours() < 6) return;
      const worldDir = readWorldBridge(root, settings.worldBridge).worldDir;
      let handled: string[] = [];
      try {
        const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as {
          handledDays?: unknown;
          lastRequestedDay?: unknown;
        };
        if (Array.isArray(saved.handledDays)) {
          handled = saved.handledDays.filter((day): day is string => typeof day === 'string');
        } else if (typeof saved.lastRequestedDay === 'string') {
          handled = [saved.lastRequestedDay];
        }
      } catch {
        /* 首次没有状态 */
      }
      const missing: string[] = [];
      for (let offset = 1; offset <= 7; offset += 1) {
        const date = new Date(now);
        date.setDate(date.getDate() - offset);
        const day = dayKey(date);
        if (handled.includes(day)) continue;
        if (!existsSync(join(worldDir, 'conversations', `${day}.jsonl`))) continue;
        if (existsSync(join(worldDir, 'diary', `${day}.md`))) continue;
        missing.push(day);
      }
      if (missing.length === 0) return;
      const prompt = `[补回顾] 这些天有对话但没有回顾：${missing.join('、')}。请按日期分别补写每一天的日记和感受，不要当成今天；补完再继续今天。另：diary/ 下带 qq- 前缀的文件是普通聊天写的那半，补写时把它折进当天成品 diary/<日期>.md，分片原样保留、不要删。`;
      if (worldRelay?.enqueue(prompt, {}) !== true) return;
      try {
        const next = [...handled, ...missing].slice(-40);
        writeFileSync(stateFile, JSON.stringify({ handledDays: next, at: now.toISOString() }, null, 2), 'utf8');
      } catch {
        /* 状态写失败最多重复请求一次 */
      }
    };
    const initial = setTimeout(check, 8000);
    const timer = setInterval(check, 30 * 60_000);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, 'dsh-qq-group: review catch-up');

  /**
   * 夜间折叠：普通聊天写的分片折进当天成品。
   * 确定性文本合并交给世界做（它才写成品），这里只在合适的时候提醒一次。
   */
  ctx.effect(() => {
    let cancelled = false;
    const stateFile = join(root, 'fold-state.json');
    const check = (): void => {
      if (cancelled) return;
      try {
        const settings = readSettings(root);
        if (!settings.worldBridge.enabled) return;
        const dir = readWorldBridge(root, settings.worldBridge).worldDir;
        if (dir === '') return;
        const now = new Date();
        if (now.getHours() < 22) return;
        const day = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        const merged = readMergedDiary(dir, day);
        if (merged.qq === '' || !merged.pending) return;
        try {
          const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as { doneDays?: unknown };
          if (Array.isArray(saved.doneDays) && saved.doneDays.includes(day)) return;
        } catch {
          /* 首次没有状态 */
        }
        const prompt = `[折叠] diary/qq-${day}.md 里有今天普通聊天写的分节还没进成品。请把它们折进 diary/${day}.md：按时间顺序接到当天正文后面，别打乱已有内容、别重复已经折过的，折完保留分片文件。`;
        if (worldRelay?.enqueue(prompt, {}) !== true) return;
        const done = (() => {
          try {
            const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as { doneDays?: unknown };
            return Array.isArray(saved.doneDays) ? saved.doneDays.filter((d): d is string => typeof d === 'string') : [];
          } catch {
            return [];
          }
        })();
        writeFileSync(stateFile, JSON.stringify({ doneDays: [...done, day].slice(-40) }, null, 2), 'utf8');
      } catch {
        /* 折叠提醒失败不影响聊天 */
      }
    };
    const initial = setTimeout(check, 20_000);
    const timer = setInterval(check, 15 * 60_000);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, 'dsh-qq-group: fold diary fragments');

  ctx.effect(() => {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        try {
          const settings = readSettings(root);
          if (!settings.qzone.enabled) return;
          const worldDir = readWorldBridge(root, settings.worldBridge).worldDir;
          const room = join(worldDir, 'room');
          const draftFile = join(room, 'qzone-post.json');
          if (!existsSync(draftFile)) return;
          let draft: { content?: unknown; images?: unknown; publish?: unknown };
          try {
            draft = JSON.parse(readFileSync(draftFile, 'utf8')) as typeof draft;
          } catch {
            renameSync(draftFile, join(room, `qzone-post.invalid-${Date.now()}.json`));
            return;
          }
          if (draft.publish !== true) return;
          const content = sanitizeQzone(typeof draft.content === 'string' ? draft.content : '');
          if (content === '') {
            writeFileSync(join(room, 'qzone-post.result.json'), JSON.stringify({ ok: false, message: 'content 为空' }, null, 2));
            renameSync(draftFile, join(room, `qzone-post.invalid-${Date.now()}.json`));
            return;
          }
          const images = Array.isArray(draft.images)
            ? draft.images
                .filter((file): file is string => typeof file === 'string')
                .map((file) => (isAbsolute(file) ? file : join(room, file)))
                .filter((file) => file.startsWith(room) && existsSync(file))
                .slice(0, 9)
            : [];
          const published = (await qqHost.qzone('publish', {
            content,
            ugcRight: settings.qzone.ugcRight,
            images,
          })) as { ok?: boolean; tid?: string; message?: string };
          if (published.ok === true) {
            appendQzone(root, {
              tid: published.tid ?? '',
              content,
              ts: Date.now(),
              ugcRight: settings.qzone.ugcRight,
              ...(images.length > 0 ? { images } : {}),
            });
            writeFileSync(
              join(room, 'qzone-post.result.json'),
              JSON.stringify({ ok: true, tid: published.tid ?? '', at: new Date().toISOString() }, null, 2),
            );
            renameSync(draftFile, join(room, `qzone-post.published-${Date.now()}.json`));
          } else {
            writeFileSync(
              join(room, 'qzone-post.result.json'),
              JSON.stringify({ ok: false, message: published.message ?? '发布失败' }, null, 2),
            );
          }
        } catch (e) {
          console.warn(`[dsh-qq-group] QQ空间草稿处理失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
          busy = false;
        }
      })();
    }, 10_000);
    return () => clearInterval(timer);
  }, 'dsh-qq-group: qzone agent drafts');

  let extracting = false;
  const extractTraces = async (): Promise<void> => {
    if (extracting) return;
    extracting = true;
    try {
      const settings = readSettings(root);
      const snapshot = readWorldMemory(root, settings.worldBridge, 80);
      const lines = snapshot.conversations.slice(-60).map((line) => `${line.role === 'user' ? '主人' : '大肥鱼'}：${line.content}`);
      if (lines.length === 0) return;
      const system = [
        '你在帮大肥鱼整理长期记忆痕迹。只输出 JSON 数组，不要解释。',
        '每条：{"text":"发生了什么（一句事实）","feeling":"当时她心里怎么想、什么感觉（一句话，简练）","domain":"owner|group|work","importance":0~1,"emotion":0~1}',
        'feeling 用第一人称，像她自己在心里嘀咕一句；不要客套话、不要总结、不要复述 text。',
        'text 和 feeling 合起来才是一条完整的记忆：发生了什么 + 她当时怎么想。',
        'domain：owner = 和主人的关系、情绪、承诺、生活事件；group = 群友之间发生的事、群里的梗和关系；work = 代码、调试、技术细节、项目过程。',
        'important：会影响她是谁/关系/情绪的高；普通技术细节低。最多 8 条。',
        '不要记录工具输出、路径、命令、重复的汇报；不要编造。',
      ].join('\n');
      const result = await generate(system, [], `最近对话：\n${lines.join('\n')}\n\n请提取。`, {
        json: true,
        maxTokens: 1200,
        timeoutMs: 90_000,
        purpose: 'memory-traces',
      });
      if (!result.ok) return;
      const match = /\[[\s\S]*\]/u.exec(result.text);
      if (match === null) return;
      const items = JSON.parse(match[0]) as Array<Record<string, unknown>>;
      for (const item of items.slice(0, 8)) {
        if (typeof item.text !== 'string' || item.text.trim() === '') continue;
        const written = writeTrace(
          traceStoreDir(),
          makeTrace({
            text: item.text,
            ...(typeof item.feeling === 'string' ? { feeling: item.feeling } : {}),
            domain: item.domain === 'work' ? 'work' : item.domain === 'group' ? 'group' : 'owner',
            importance: typeof item.importance === 'number' ? item.importance : undefined,
            emotion: typeof item.emotion === 'number' ? item.emotion : undefined,
            source: 'extract',
          }),
        );
        if (written.merged) {
          console.log(`[dsh-qq-group] 记忆去重：并进已有那条（惊讶度 ${written.surprise.toFixed(2)}）`);
        }
      }
      autoRecallTraces(traceStoreDir(), lines.join(' '));
      syncTraceBlock();
    } catch (e) {
      console.warn(`[dsh-qq-group] 记忆痕迹提取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      extracting = false;
    }
  };

  /**
   * 群聊也进记忆痕迹，domain = group。
   * 每个群各自记一个游标，只提炼新说的话；和主人在群里的记忆是同一份。
   */
  let extractingGroup = false;
  const extractGroupTraces = async (): Promise<void> => {
    if (extractingGroup) return;
    extractingGroup = true;
    try {
      const memoryPath = join(root, 'qq-memory.json');
      if (!existsSync(memoryPath)) return;
      const memory = JSON.parse(readFileSync(memoryPath, 'utf8')) as {
        groups?: Record<string, { turns?: Array<{ role?: string; text?: string; ts?: number }> }>;
      };
      const cursorPath = join(root, 'group-trace-cursor.json');
      const cursor: Record<string, number> = (() => {
        try {
          return existsSync(cursorPath)
            ? (JSON.parse(readFileSync(cursorPath, 'utf8')) as Record<string, number>)
            : {};
        } catch {
          return {};
        }
      })();
      const nextCursor: Record<string, number> = { ...cursor };
      const dir = traceStoreDir();

      for (const [groupId, group] of Object.entries(memory.groups ?? {})) {
        // 私聊（p:开头）归「和主人的记忆」，不进群聊提取，否则会把主人的话错标成群的。
        if (groupId.startsWith('p:')) continue;
        const turns = (group.turns ?? []).filter(
          (turn): turn is { role: string; text: string; ts: number; name?: string } =>
            typeof turn.ts === 'number' &&
            typeof turn.text === 'string' &&
            turn.text.trim() !== '' &&
            !turn.text.startsWith('['),
        );
        const since = cursor[groupId] ?? 0;
        const pending = turns.filter((turn) => turn.ts > since);
        if (pending.length < 6) continue;

        const system = [
          '你在帮大肥鱼整理「群聊记忆」。只输出 JSON 数组，不要解释。',
          '每条：{"text":"发生了什么（一句事实，必须写清是谁说的/做的）","people":["相关的人名，用对话里出现的原名"],"feeling":"当时她心里怎么想、什么感觉（一句话，简练）","importance":0~1,"emotion":0~1}',
          'feeling 用第一人称，像她自己在心里嘀咕一句；不要客套话、不要复述 text。',
          'text 里不要用「群友」「有人」「对方」这种泛指——写具体昵称；确实不知道是谁才用泛指。',
          '只记群友之间真实发生的事：谁在意什么、群里的梗、关系变化、她自己说过的话。',
          '不要记录刷屏、复读、纯表情、机器人操作；不要编造。没有值得记的就输出 []。最多 5 条。',
        ].join('\n');

        // 群里刷得快时，一次只取最新 30 条会让前面的话永久漏掉。
        // 改成一批一批往前追：每批 30 条，一次最多追 6 批，剩下的下一轮继续。
        // 提炼失败就停在原地，游标不动，下一轮重试，不丢话。
        let offset = 0;
        for (let batch = 0; batch < 6 && offset < pending.length; batch += 1) {
          const slice = pending.slice(offset, offset + 30);
          if (slice.length === 0) break;
          // 以前这里把发言人抹成「群友」，模型当然只能写出「群友说…」。
          // 改成带真实昵称；名字缺失才退回「群友」。
          const lines = slice.map((turn) => `${turn.role === 'user' ? (turn.name?.trim() || '群友') : '大肥鱼'}：${turn.text.slice(0, 200)}`);
          const result = await generate(system, [], `这个群最近的对话：\n${lines.join('\n')}\n\n请提取。`, {
            json: true,
            maxTokens: 900,
            timeoutMs: 90_000,
            purpose: 'group-traces',
          });
          if (!result.ok) break;
          const match = /\[[\s\S]*\]/u.exec(result.text);
          let items: Array<Record<string, unknown>> = [];
          if (match !== null) {
            try {
              items = JSON.parse(match[0]) as Array<Record<string, unknown>>;
            } catch {
              items = [];
            }
          }
          for (const item of items.slice(0, 5)) {
            if (typeof item.text !== 'string' || item.text.trim() === '') continue;
            writeTrace(
              dir,
              makeTrace({
                text: item.text,
                ...(typeof item.feeling === 'string' ? { feeling: item.feeling } : {}),
                ...(Array.isArray(item.people)
                  ? { people: item.people.filter((p): p is string => typeof p === 'string') }
                  : {}),
                // 时间取这批消息里最后一条的真实发送时刻，不是落盘时刻
                happenedAt: slice[slice.length - 1]?.ts,
                domain: 'group',
                importance: typeof item.importance === 'number' ? Math.min(0.75, item.importance) : undefined,
                emotion: typeof item.emotion === 'number' ? item.emotion : undefined,
                source: 'extract',
              }),
            );
          }
          // 这一批处理完了才前移游标；没提炼出东西也算处理过。
          offset += slice.length;
          nextCursor[groupId] = slice[slice.length - 1]?.ts ?? nextCursor[groupId] ?? since;
        }
      }
      writeFileSync(cursorPath, `${JSON.stringify(nextCursor, null, 2)}\n`, 'utf8');
      syncTraceBlock();
    } catch (e) {
      console.warn(`[dsh-qq-group] 群聊记忆提取失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      extractingGroup = false;
    }
  };

  ctx.effect(() => {
    const timer = setInterval(() => { void extractTraces(); }, 10 * 60_000);
    const start = setTimeout(() => { void extractTraces(); }, 5000);
    // 群聊刷得快时，10 分钟足够把 30 条窗口冲掉；缩到 2 分钟，缝隙更小。
    const groupTimer = setInterval(() => { void extractGroupTraces(); }, 2 * 60_000);
    const groupStart = setTimeout(() => { void extractGroupTraces(); }, 30_000);
    return () => {
      clearInterval(timer);
      clearTimeout(start);
      clearInterval(groupTimer);
      clearTimeout(groupStart);
    };
  }, 'dsh-qq-group: memory traces');

  const modelsList = async (): Promise<unknown> => {
    const llm = ctx.llm as
      | {
          listProviders?: () => Array<{ id?: unknown; name?: unknown }>;
          listConfigurableProviders?: () => Array<{ provider?: unknown; displayName?: unknown }>;
          listModels?: (p: string) => Promise<Array<{ id?: unknown; name?: unknown }>>;
        }
      | undefined;
    if (!llm?.listModels) return { ok: true, providers: [] };
    const providers =
      typeof llm.listProviders === 'function'
        ? llm.listProviders().map((p) => ({ id: String(p.id ?? ''), name: String(p.name ?? p.id ?? '') }))
        : (llm.listConfigurableProviders?.() ?? []).map((p) => ({
            id: String(p.provider ?? ''),
            name: String(p.displayName ?? p.provider ?? ''),
          }));
    const out = [];
    for (const provider of providers) {
      if (provider.id === '') continue;
      try {
        const models = await llm.listModels(provider.id);
        out.push({
          provider: provider.id,
          name: provider.name,
          models: models.map((m) => ({ id: String(m.id ?? ''), name: String(m.name ?? m.id ?? '') })).filter((m) => m.id !== ''),
        });
      } catch {
        out.push({ ...provider, models: [] });
      }
    }
    return { ok: true, providers: out };
  };

  const route = async (req: any, res: any): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rest = url.pathname.replace(/^\/dsh-qq-group\/?/, '');
    const method = req.method ?? 'GET';
    const send = (status: number, obj: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    let body = '';
    if (method === 'POST' || method === 'PUT') {
      for await (const chunk of req) body += chunk;
    }
    try {
      if (rest === 'version' && method === 'GET') {
        return send(200, {
          ok: true,
          version: PLUGIN_VERSION,
          diskVersion: diskPluginVersion(),
          stale: diskPluginVersion() !== '' && diskPluginVersion() !== PLUGIN_VERSION,
          startedAt: PLUGIN_STARTED_AT,
          pid: process.pid,
        });
      }

      if (rest === 'qr' && method === 'GET') {
        const path = resolveNapcatQr(root);
        if (path === undefined) {
          return send(404, { ok: false, message: '还没有生成登录二维码；先启动 NapCat，等它写出二维码后再刷新' });
        }
        try {
          const image = readFileSync(path);
          if (image.length < 100 || image[0] !== 0x89 || image[1] !== 0x50) {
            return send(404, { ok: false, message: '二维码文件还不是有效 PNG，请稍后刷新' });
          }
          res.writeHead(200, {
            'content-type': 'image/png',
            'cache-control': 'no-store, no-cache, must-revalidate',
            'content-length': String(image.length),
            'x-qr-mtime': String(statSync(path).mtimeMs),
          });
          res.end(image);
          return;
        } catch (e) {
          return send(404, { ok: false, message: e instanceof Error ? e.message : String(e) });
        }
      }

      if (rest === 'qr/status' && method === 'GET') {
        const path = resolveNapcatQr(root);
        if (path === undefined) return send(200, { ok: true, available: false });
        try {
          const stat = statSync(path);
          return send(200, { ok: true, available: true, mtime: stat.mtimeMs, bytes: stat.size });
        } catch {
          return send(200, { ok: true, available: false });
        }
      }

      if (rest === 'world/thought' && method === 'POST') {
        const parsed = JSON.parse(body ?? '{}') as { text?: unknown };
        const note = typeof parsed.text === 'string' ? parsed.text.trim().slice(0, 2000) : '';
        if (note === '') return send(400, { ok: false, message: 'text 为空' });
        const settings = readSettings(root);
        const worldDir = readWorldBridge(root, settings.worldBridge).worldDir;
        const target = join(worldDir, 'room', '没说出口的话.md');
        mkdirSync(dirname(target), { recursive: true });
        const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        try {
          appendFileSync(target, `- ${stamp}｜${note}\n`, 'utf8');
        } catch (e) {
          return send(500, { ok: false, message: e instanceof Error ? e.message : String(e) });
        }
        return send(200, { ok: true });
      }

      if (rest === 'world/deliveries' && method === 'GET') {
        const file = join(root, 'world-delivery.jsonl');
        const lines: unknown[] = [];
        try {
          const raw = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
          for (const line of raw.slice(-30)) {
            try {
              lines.push(JSON.parse(line) as unknown);
            } catch {
              /* 跳过坏行 */
            }
          }
        } catch {
          /* 还没有投递记录 */
        }
        return send(200, { ok: true, entries: lines });
      }

      // 主动联系的真实统计：面板原来打的是世界那张 QQ 桥（没接就 404），
      // 现在改成直接问这个插件自己的账本——usage.json 的调用、diary.json 的主动开口。
      if (rest === 'world/proactive' && method === 'GET') {
        const settings = readSettings(root);
        const usageEntries = readUsage(usagePath).entries;
        const diaryEntries = readDiary(root);
        const now = Date.now();
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        const today = localDay(now);

        const daily = (day: string) => {
          const replies = usageEntries.filter((entry) => entry.purpose === 'reply' && localDay(entry.ts) === day);
          const proactive = diaryEntries.filter(
            (entry) => entry.incoming === '（主动开口）' && localDay(entry.ts) === day,
          );
          const sampled = replies.filter((entry) => entry.inputTokens > 0 || entry.outputTokens > 0);
          const sum = (list: typeof replies, key: 'inputTokens' | 'outputTokens'): number =>
            list.reduce((total, entry) => total + entry[key], 0);
          return {
            dayKey: day,
            calls: replies.length,
            messages: proactive.length,
            sent: proactive.length,
            suppressed: null,
            pending: 0,
            sampled: sampled.length,
            avgInputTokens: sampled.length === 0 ? 0 : Math.round(sum(sampled, 'inputTokens') / sampled.length),
            avgOutputTokens: sampled.length === 0 ? 0 : Math.round(sum(sampled, 'outputTokens') / sampled.length),
            reports: proactive.slice(-8).map((entry) => ({
              decision: '主动开口',
              text: entry.reply.slice(0, 80),
            })),
          };
        };

        const todayStats = daily(today);
        const series = Array.from({ length: 7 }, (_, index) => {
          const date = new Date(midnight);
          date.setDate(date.getDate() - (6 - index));
          const day = localDay(date.getTime());
          const stats = daily(day);
          return {
            dayKey: day,
            calls: stats.calls,
            sampled: stats.sampled,
            avgInputTokens: stats.avgInputTokens,
            avgOutputTokens: stats.avgOutputTokens,
            messages: stats.messages,
          };
        });
        const snapshot = (await qqHost.handle('qq', 'GET')) as { running?: boolean } | undefined;
        return send(200, {
          ok: true,
          enabled: settings.mode === 'proactive',
          dryRun: false,
          running: snapshot?.running === true,
          source: 'dsh-qq-group',
          policy: { maxCallsPerDay: null },
          today: {
            dayKey: todayStats.dayKey,
            calls: todayStats.calls,
            messages: todayStats.messages,
            sent: todayStats.sent,
            suppressed: todayStats.suppressed,
            pending: todayStats.pending,
          },
          usage: {
            calls: todayStats.calls,
            sampled: todayStats.sampled,
            avgInputTokens: todayStats.avgInputTokens,
            avgOutputTokens: todayStats.avgOutputTokens,
          },
          usageSeries: series,
          reports: todayStats.reports,
        });
      }

      if (rest === 'world/proactive' && method === 'POST') {
        const payload = JSON.parse(body ?? '{}') as { enabled?: unknown; dryRun?: unknown };
        if (typeof payload.enabled === 'boolean') {
          const settings = readSettings(root);
          writeSettings(root, { ...settings, mode: payload.enabled ? 'proactive' : 'passive' });
          return send(200, { ok: true, enabled: payload.enabled, dryRun: false });
        }
        if (payload.dryRun !== undefined) {
          return send(200, { ok: true, dryRun: false, message: '这个插件没有演练模式：关掉就不会开口' });
        }
        return send(400, { ok: false, message: '需要 enabled' });
      }

      if (rest === 'world/digest' && method === 'GET') {
        const entries = readDigest();
        const groups = [...new Set(entries.map((entry) => entry.groupId))];
        return send(200, {
          ok: true,
          entries: entries.slice(-400),
          groups,
          total: entries.length,
          selfCount: entries.filter((entry) => entry.self).length,
        });
      }

      if (rest === 'world/digest' && method === 'POST') {
        const payload = JSON.parse(body ?? '{}') as { action?: unknown; ids?: unknown; groupId?: unknown };
        const action = typeof payload.action === 'string' ? payload.action : '';
        const entries = readDigest();
        if (action === 'delete' && Array.isArray(payload.ids)) {
          const ids = new Set(payload.ids.filter((id): id is string => typeof id === 'string'));
          const kept = entries.filter((entry) => !ids.has(entry.id));
          writeDigest(kept);
          renderDigestFile(kept);
          return send(200, { ok: true, total: kept.length });
        }
        if (action === 'clear-group' && typeof payload.groupId === 'string') {
          const kept = entries.filter((entry) => entry.groupId !== payload.groupId);
          writeDigest(kept);
          renderDigestFile(kept);
          return send(200, { ok: true, total: kept.length });
        }
        if (action === 'clear') {
          writeDigest([]);
          renderDigestFile([]);
          return send(200, { ok: true, total: 0 });
        }
        return send(400, { ok: false, message: '未知操作' });
      }

      if (rest === 'world/qzone' && method === 'GET') {
        const settings = readSettings(root);
        const worldDir = readWorldBridge(root, settings.worldBridge).worldDir;
        const room = join(worldDir, 'room');
        const readJson = (file: string): unknown => {
          try {
            return JSON.parse(readFileSync(file, 'utf8')) as unknown;
          } catch {
            return null;
          }
        };
        const draft = readJson(join(room, 'qzone-post.json'));
        const result = readJson(join(room, 'qzone-post.result.json'));
        const pending =
          draft !== null &&
          typeof draft === 'object' &&
          typeof (draft as { content?: unknown }).content === 'string' &&
          (draft as { content: string }).content.trim() !== '';
        return send(200, { ok: true, pending, draft, result });
      }

      // 有哪些世界可以选（给「私聊世界」下拉用）。
      // 只列 DSH_HOME/worlds/ 下真实存在的目录，顺带说明它的桥在不在线。
      if (rest === 'world/list' && method === 'GET') {
        const base = join(dirname(root), 'worlds');
        const items: Array<{ id: string; online: boolean; note: string }> = [];
        try {
          for (const entry of readdirSync(base, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            let online = false;
            let note = '';
            try {
              const bridgeFile = join(base, entry.name, 'bridge.json');
              if (existsSync(bridgeFile)) {
                const parsed = JSON.parse(readFileSync(bridgeFile, 'utf8')) as { origin?: unknown; pid?: unknown };
                online = typeof parsed.origin === 'string' && parsed.origin !== '';
              } else {
                note = '这个世界的桥还没启动';
              }
            } catch {
              note = '桥信息读不到';
            }
            items.push({ id: entry.name, online, note });
          }
        } catch {
          /* 没有 worlds 目录就返回空表 */
        }
        items.sort((a, b) => a.id.localeCompare(b.id));
        return send(200, { ok: true, worlds: items });
      }

      if (rest === 'world/model' && method === 'GET') {
        const settings = readSettings(root);
        const worldDir = readWorldBridge(root, settings.worldBridge).worldDir;
        let homeSessionId = '';
        try {
          const life = JSON.parse(readFileSync(join(worldDir, 'life.json'), 'utf8')) as { homeSessionId?: unknown };
          if (typeof life.homeSessionId === 'string') homeSessionId = life.homeSessionId;
        } catch {
          /* 没有家会话 */
        }
        let current: { provider?: string; model?: string } | null = null;
        let lastUsed: { provider: string; model: string } | null = null;
        if (homeSessionId !== '') {
          try {
            const projection = JSON.parse(
              readFileSync(
                join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', `${homeSessionId}.json`),
                'utf8',
              ),
            ) as { record?: { rows?: { modelSelection?: { val?: { pending?: unknown; lastUsed?: unknown } } } } };
            // 2026-10-28 修：这里原来只读 lastUsed（上一轮实际用过的），
            // 于是在界面里刚选完模型，它显示的还是旧的那个，看着像「自动跳回去了」。
            // DSH 的语义是：pending = 已选、下一轮生效；lastUsed = 上一轮真用的。
            // 界面上「当前模型」该显示 pending。
            const val = projection.record?.rows?.modelSelection?.val;
            const pick = (ref: unknown): { provider: string; model: string } | null => {
              if (ref === null || typeof ref !== 'object') return null;
              const r = ref as { provider?: unknown; model?: unknown };
              return typeof r.provider === 'string' && typeof r.model === 'string'
                ? { provider: r.provider, model: r.model }
                : null;
            };
            const pendingRef = pick(val?.pending);
            const lastRef = pick(val?.lastUsed);
            lastUsed = lastRef;
            if (pendingRef !== null) current = pendingRef;
            else if (lastRef !== null) current = lastRef;
          } catch {
            /* 读取不到就返回 null */
          }
        }
        return send(200, { ok: true, homeSessionId, current, lastUsed, providers: await modelsList() });
      }

      if (rest === 'world/model' && method === 'POST') {
        const parsed = JSON.parse(body ?? '{}') as {
          provider?: unknown;
          model?: unknown;
          reasoningEffort?: unknown;
        };
        if (typeof parsed.provider !== 'string' || typeof parsed.model !== 'string') {
          return send(400, { ok: false, message: 'provider/model 必填' });
        }
        const settings = readSettings(root);
        const worldDir = readWorldBridge(root, settings.worldBridge).worldDir;
        let homeSessionId = '';
        try {
          const life = JSON.parse(readFileSync(join(worldDir, 'life.json'), 'utf8')) as { homeSessionId?: unknown };
          if (typeof life.homeSessionId === 'string') homeSessionId = life.homeSessionId;
        } catch {
          /* 没有家会话 */
        }
        if (homeSessionId === '') return send(200, { ok: false, message: '还没有家会话' });
        const service = (ctx as { get?: (name: string) => unknown; sessionController?: unknown }).get?.('sessionController')
          ?? (ctx as { sessionController?: unknown }).sessionController;
        const controller = service as {
          selectModel?: (request: Record<string, unknown>) => Promise<unknown>;
        } | undefined;
        if (controller === undefined || typeof controller.selectModel !== 'function') {
          return send(200, { ok: false, message: 'DSH 会话控制器不可用' });
        }
        try {
          const result = await controller.selectModel({
            sessionId: homeSessionId,
            provider: parsed.provider,
            model: parsed.model,
            ...(typeof parsed.reasoningEffort === 'string'
              ? { reasoningEffort: parsed.reasoningEffort }
              : {}),
          });
          return send(200, { ok: true, result });
        } catch (e) {
          return send(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
        }
      }

      if (rest === 'world/outlet' && method === 'POST') {
        if (worldRelay === undefined) return send(503, { ok: false, message: '世界桥尚未初始化' });
        let payload: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(body ?? '{}') as unknown;
          if (parsed !== null && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
        } catch {
          return send(400, { ok: false, message: '请求体不是 JSON' });
        }
        const accepted = worldRelay.outlet(payload);
        return send(200, { ok: true, accepted });
      }

      if (rest === 'world/status' && method === 'GET') {
        const settings = readSettings(root);
        const info = readWorldBridge(root, settings.worldBridge);
        const { token: _token, ...safe } = info;
        return send(200, safe);
      }

      if (rest === 'world/traces' && method === 'GET') {
        return send(200, { ok: true, traces: rankedTraces() });
      }

      /**
       * 批量回填 happenedAt（一次性修数据用）。
       *
       * 老痕迹只有 createdAt（写入时刻），注入提示词时没带时间，
       * 她回忆起来就是一堆「无时间的孤立事实」。这里把 createdAt 复制过去。
       */
      if (rest === 'world/traces-catchup' && method === 'POST') {
        const dir = traceStoreDir();
        if (dir === '') return send(200, { ok: false, message: '世界桥没开或没配目录' });
        const all = loadTraces(dir);
        let filled = 0;
        const next = all.map((trace) => {
          if (typeof trace.happenedAt === 'number' && trace.happenedAt > 0) return trace;
          if (typeof trace.createdAt !== 'number' || trace.createdAt <= 0) return trace;
          filled += 1;
          return { ...trace, happenedAt: trace.createdAt };
        });
        saveTraces(dir, next);
        syncTraceBlock();
        return send(200, { ok: true, total: next.length, filled });
      }

      if (rest === 'world/traces' && method === 'POST') {
        const payload = JSON.parse(body ?? '{}') as Record<string, unknown>;
        const action = typeof payload.action === 'string' ? payload.action : '';
        if (action === 'add' && typeof payload.text === 'string') {
          const trace = makeTrace({
            text: payload.text,
            domain: payload.domain === 'work' ? 'work' : payload.domain === 'group' ? 'group' : 'owner',
            ...(typeof payload.importance === 'number' ? { importance: payload.importance } : {}),
            ...(typeof payload.emotion === 'number' ? { emotion: payload.emotion } : {}),
            source: 'manual',
          });
          upsertTrace(traceStoreDir(), trace);
        } else if (action === 'update' && typeof payload.id === 'string') {
          const patch: Partial<MemoryTrace> = {};
          if (typeof payload.text === 'string') patch.text = payload.text.slice(0, 2000);
          if (payload.domain === 'owner' || payload.domain === 'group' || payload.domain === 'work') patch.domain = payload.domain;
          if (typeof payload.importance === 'number') patch.importance = Math.max(0, Math.min(1, payload.importance));
          if (typeof payload.emotion === 'number') patch.emotion = Math.max(0, Math.min(1, payload.emotion));
          if (typeof payload.pinned === 'boolean') patch.pinned = payload.pinned;
          updateTrace(traceStoreDir(), payload.id, patch);
        } else if (action === 'delete' && Array.isArray(payload.ids)) {
          deleteTraces(traceStoreDir(), payload.ids.filter((id): id is string => typeof id === 'string'));
        } else if (action === 'recall' && Array.isArray(payload.ids)) {
          recallTraces(traceStoreDir(), payload.ids.filter((id): id is string => typeof id === 'string'));
        } else if (action === 'clear-domain' && (payload.domain === 'work' || payload.domain === 'owner' || payload.domain === 'group')) {
          const domain = payload.domain;
          const ids = loadTraces(traceStoreDir())
            .filter((trace) => trace.domain === domain)
            .map((trace) => trace.id);
          deleteTraces(traceStoreDir(), ids);
        } else {
          return send(400, { ok: false, message: '未知的记忆操作' });
        }
        syncTraceBlock();
        return send(200, { ok: true, traces: rankedTraces() });
      }

      if (rest === 'world/memory' && method === 'GET') {
        const settings = readSettings(root);
        syncWorldPermanent(root, settings.worldBridge);
        return send(200, readWorldMemory(root, settings.worldBridge));
      }

      if (rest === 'world/memory' && method === 'POST') {
        const settings = readSettings(root);
        const parsed = JSON.parse(body ?? '{}') as {
          self?: unknown;
          persona?: unknown;
          worldPrompt?: unknown;
          diary?: { date?: unknown; text?: unknown };
        };
        if (typeof parsed.self === 'string') {
          writeWorldSelf(root, settings.worldBridge, parsed.self.slice(0, 100_000));
        }
        if (typeof parsed.persona === 'string') {
          writeWorldPersona(root, settings.worldBridge, parsed.persona.slice(0, 100_000));
        }
        if (typeof parsed.worldPrompt === 'string') {
          writeWorldPrompt(root, settings.worldBridge, parsed.worldPrompt.slice(0, 100_000));
        }
        if (
          parsed.diary !== undefined &&
          typeof parsed.diary.date === 'string' &&
          typeof parsed.diary.text === 'string'
        ) {
          writeWorldDiary(
            root,
            settings.worldBridge,
            parsed.diary.date,
            parsed.diary.text.slice(0, 100_000),
          );
        }
        return send(200, { ok: true });
      }

      if (rest === 'world/diary/append' && method === 'POST') {
        const parsed = JSON.parse(body ?? '{}') as { text?: unknown };
        const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
        if (text === '') return send(400, { ok: false, error: 'text 不能为空' });
        const dir = readWorldBridge(root, readSettings(root).worldBridge).worldDir;
        if (dir === '') return send(400, { ok: false, error: '没配世界目录' });
        const written = appendQqDiarySection(dir, text.slice(0, 20_000));
        if (!written.ok) return send(500, { ok: false, error: written.message });
        syncTraceBlock();
        return send(200, { ok: true, path: written.path });
      }

      if (rest === 'world/memory/merged' && method === 'GET') {
        const dir = readWorldBridge(root, readSettings(root).worldBridge).worldDir;
        if (dir === '') return send(400, { ok: false, error: '没配世界目录' });
        const date = url.searchParams.get('date') ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        const merged = readMergedDiary(dir, date);
        return send(200, { ok: true, ...merged });
      }

      if (rest === 'session-names' && method === 'GET') {
        return send(200, await qqHost.sessionNames());
      }

      if (rest === 'tts-health' && method === 'GET') {
        const cfg = readQqConfig(qqConfigPath(root)).config;
        const endpoint = cfg.tts.endpoint.trim().replace(/\/+$/, '');
        if (endpoint === '') return send(200, { ok: false, message: '未配置本地 TTS 网关' });
        try {
          const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(2_500) });
          const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          return send(200, { ok: response.ok, endpoint, ...body });
        } catch (e) {
          return send(200, { ok: false, endpoint, message: e instanceof Error ? e.message : String(e) });
        }
      }

      if (rest === '' || rest === 'status') {
        const snapshot = (await qqHost.handle('qq', 'GET')) as Record<string, unknown>;
        const { sel, source } = effectiveModel();
        const cfg = readQqConfig(qqConfigPath(root)).config;
        const target = wsTarget(cfg.url);
        const settings = readSettings(root);
        return send(200, {
          ...snapshot,
          model: { provider: sel.provider, model: sel.model, source },
          diaryCount: readDiary(root).length,
          stickerCount: listStickerInfo(root).length,
          napcat: {
            url: cfg.url,
            reachable: target === undefined ? false : await portOpen(target.host, target.port),
            launcher: settings.napcatLauncher,
            autoLaunch: settings.autoLaunchNapcat,
          },
        });
      }
      if (rest === 'models') return send(200, await modelsList());

      if (rest === 'model-check') {
        if (method !== 'POST') return send(405, { error: 'method not allowed' });
        const { sel, source } = effectiveModel();
        const probe = async (ref: ModelRef): Promise<Record<string, unknown>> => {
          const started = Date.now();
          // 不设 maxTokens；noFallback 确保测试的是这个模型本身，不把备用成功算到它头上。
          const result = await generate('你是一个模型连通性自检助手。只回复一个词：ok', [], 'ping', {
            purpose: 'model-check',
            modelOverride: ref,
            noFallback: true,
            timeoutMs: 30_000,
          });
          return {
            provider: ref.provider,
            model: ref.model,
            ok: result.ok === true,
            latencyMs: Date.now() - started,
            ...(result.ok === true ? { reply: result.text } : { error: result.message }),
          };
        };
        const primary = await probe(sel);
        const fallbackRef = readSettings(root).fallbackModel;
        const configuredFallback = fallbackRef.provider !== '' && fallbackRef.model !== '';
        const sameAsPrimary =
          configuredFallback &&
          fallbackRef.provider === sel.provider &&
          fallbackRef.model === sel.model;
        const fallback = sameAsPrimary
          ? {
              provider: fallbackRef.provider,
              model: fallbackRef.model,
              skipped: true,
              reason: 'same-as-primary',
            }
          : configuredFallback
            ? await probe(fallbackRef)
            : null;
        const primaryOk = primary.ok === true;
        const fallbackOk = fallback !== null && fallback.ok === true;
        return send(200, {
          ok: primaryOk || fallbackOk,
          active: primaryOk ? 'primary' : fallbackOk ? 'fallback' : 'none',
          model: { provider: sel.provider, model: sel.model, source },
          latencyMs: primary.latencyMs,
          ...(primaryOk ? { reply: primary.reply } : { error: primary.error }),
          primary,
          ...(fallback === null ? {} : { fallback }),
        });
      }

      if (rest === 'reasoning') {
        const { sel } = effectiveModel();
        const llm = ctx.llm as {
          resolveModelInfo?: (provider: string, model: string) => Promise<{ reasoning?: unknown }>;
        };
        if (typeof llm.resolveModelInfo !== 'function') {
          return send(200, { ok: false, message: '当前 DSH 不提供模型推理档位信息' });
        }
        try {
          const info = await llm.resolveModelInfo(sel.provider, sel.model);
          return send(200, { ok: true, model: sel, reasoning: info.reasoning ?? null });
        } catch (e) {
          return send(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
        }
      }

      if (rest === 'persona/effective' && method === 'GET') {
        const groupId = url.searchParams.get('groupId') ?? '';
        const settings = readSettings(root);
        const boundId = groupId === '' ? '' : settings.groupPersonaIds[groupId] ?? '';
        const bound = settings.personas.find((item) => item.id === boundId);
        const active = settings.personas.find((item) => item.id === settings.activePersonaId);
        const card = bound ?? active;
        return send(200, {
          ok: true,
          groupId,
          boundId,
          activeId: settings.activePersonaId,
          cardId: card?.id ?? '',
          name: card?.name ?? '',
          length: card?.text.length ?? 0,
          source: bound !== undefined ? 'group' : 'global',
        });
      }

      if (rest === 'usage' && method === 'GET') {
        const settings = readSettings(root);
        const entries = readUsage(usagePath).entries;
        const { sel } = effectiveModel();
        const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'current';
        const month = url.searchParams.get('month') ?? currentMonth();
        const filtered =
          scope === 'all'
            ? entries
            : entries.filter((entry) => entry.provider === sel.provider && entry.model === sel.model);
        const now = Date.now();
        const today = localDay(now);
        const midnight = new Date();
        midnight.setHours(0, 0, 0, 0);
        const weekStart = midnight.getTime() - 6 * 86_400_000;
        const monthEntries = filtered.filter((entry) => localDay(entry.ts).startsWith(month));
        const totals = {
          today: summarize(filtered.filter((entry) => localDay(entry.ts) === today), settings.usageRates),
          week: summarize(filtered.filter((entry) => entry.ts >= weekStart), settings.usageRates),
          month: summarize(monthEntries, settings.usageRates),
          all: summarize(filtered, settings.usageRates),
        };
        const dayMap = new Map<string, UsageEntry[]>();
        for (const entry of monthEntries) {
          const day = localDay(entry.ts);
          const list = dayMap.get(day) ?? [];
          list.push(entry);
          dayMap.set(day, list);
        }
        const days = [...dayMap.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([day, list]) => ({
            day,
            ...summarize(list, settings.usageRates),
            purposes: Object.fromEntries(
              [...new Set(list.map((entry) => entry.purpose))].map((purpose) => [
                purpose,
                summarize(list.filter((entry) => entry.purpose === purpose), settings.usageRates),
              ]),
            ),
          }));
        const modelMap = new Map<string, UsageEntry[]>();
        for (const entry of entries) {
          const key = usageKey(entry.provider, entry.model);
          const list = modelMap.get(key) ?? [];
          list.push(entry);
          modelMap.set(key, list);
        }
        const byModel = [...modelMap.entries()].map(([key, list]) => ({
          key,
          provider: list[0]?.provider ?? '',
          model: list[0]?.model ?? '',
          ...summarize(list, settings.usageRates),
        }));
        const groupMap = new Map<string, UsageEntry[]>();
        for (const entry of monthEntries) {
          const group = entry.groupId === undefined || entry.groupId === '' ? '(无群)' : entry.groupId;
          const list = groupMap.get(group) ?? [];
          list.push(entry);
          groupMap.set(group, list);
        }
        const byGroup = [...groupMap.entries()]
          .map(([groupId, list]) => ({ groupId, ...summarize(list, settings.usageRates) }))
          .sort((a, b) => b.credits - a.credits);
        const purposeMap = new Map<string, UsageEntry[]>();
        for (const entry of monthEntries) {
          const list = purposeMap.get(entry.purpose) ?? [];
          list.push(entry);
          purposeMap.set(entry.purpose, list);
        }
        const byPurpose = [...purposeMap.entries()]
          .map(([purpose, list]) => ({ purpose, ...summarize(list, settings.usageRates) }))
          .sort((a, b) => b.credits - a.credits);
        const key = usageKey(sel.provider, sel.model);
        let balance: Record<string, unknown> | null = null;
        if (settings.balance !== null) {
          const since = entries.filter((entry) => entry.ts >= settings.balance!.setAt);
          const consumed = summarize(since, settings.usageRates).credits;
          balance = {
            ...settings.balance,
            consumedSince: consumed,
            remaining: Math.max(0, settings.balance.credits - consumed),
          };
        }
        return send(200, {
          ok: true,
          scope,
          month,
          model: { ...sel, key, rate: settings.usageRates[key] ?? 0 },
          totals,
          days,
          byModel,
          byGroup,
          byPurpose,
          balance,
          rates: settings.usageRates,
        });
      }

      if (rest === 'usage/balance' && method === 'POST') {
        const parsed = JSON.parse(body || 'null') as { credits?: unknown } | null;
        const credits = typeof parsed?.credits === 'number' ? Math.max(0, parsed.credits) : NaN;
        if (!Number.isFinite(credits)) return send(200, { ok: false, message: 'credits 必须是非负数字' });
        const settings = readSettings(root);
        settings.balance = { credits, setAt: Date.now() };
        writeSettings(root, settings);
        return send(200, { ok: true, balance: settings.balance });
      }

      if (rest === 'usage/rate' && method === 'POST') {
        const parsed = JSON.parse(body || 'null') as { key?: unknown; rate?: unknown } | null;
        if (typeof parsed?.key !== 'string' || parsed.key.trim() === '') {
          return send(200, { ok: false, message: '缺少 key（provider/model）' });
        }
        const rate = typeof parsed.rate === 'number' ? parsed.rate : NaN;
        if (!Number.isFinite(rate) || rate < 0) return send(200, { ok: false, message: 'rate 必须是非负数字' });
        const settings = readSettings(root);
        settings.usageRates = { ...settings.usageRates, [parsed.key.trim()]: rate };
        writeSettings(root, settings);
        return send(200, { ok: true, rates: settings.usageRates });
      }

      if (rest === 'voice-preview') {
        if (method !== 'POST') return send(405, { error: 'method not allowed' });
        const payload = (JSON.parse(body || 'null') as
          | { text?: unknown; voice?: unknown; rate?: unknown; pitch?: unknown; volume?: unknown; style?: unknown; rvc?: unknown; tts?: unknown }
          | null) ?? {};
        const cfg = readQqConfig(qqConfigPath(root)).config;
        const ttsOverride =
          payload.tts !== null && typeof payload.tts === 'object'
            ? (payload.tts as Partial<typeof cfg.tts>)
            : {};
        const tts = { ...cfg.tts, ...ttsOverride };
        const rvcOverride =
          payload.rvc !== null && typeof payload.rvc === 'object'
            ? (payload.rvc as Partial<QqRvcConfig>)
            : {};
        const rvc = { ...cfg.rvc, ...rvcOverride };
        const text =
          typeof payload.text === 'string' && payload.text.trim() !== ''
            ? payload.text.trim().slice(0, 120)
            : '主人，我是鲸鱼娘，今天也要开心呀。';
        const result = await getPreviewSpeaker().speak(text, {
          voice: typeof payload.voice === 'string' && payload.voice !== '' ? payload.voice : tts.voice,
          rate: typeof payload.rate === 'string' && payload.rate !== '' ? payload.rate : tts.rate,
          pitch: typeof payload.pitch === 'string' && payload.pitch !== '' ? payload.pitch : tts.pitch,
          volume: typeof payload.volume === 'string' && payload.volume !== '' ? payload.volume : tts.volume,
          provider: tts.provider,
          endpoint: tts.endpoint,
          style: typeof payload.style === 'string' && payload.style !== '' ? payload.style : tts.style,
        });
        if (!result.ok) return send(200, { ok: false, message: describeFailure(result) });
        let wav = encodeWave(result.pcm);
        let rvcWarning: string | undefined;
        if (rvc.enabled) {
          const modelPath = rvc.modelPath || cfg.sing.rvcModel;
          const useOnnx =
            rvc.device !== 'cpu' && modelPath.toLowerCase().endsWith('.onnx');
          const baseDir = rvc.modelsDir || dirname(modelPath);
          const converter = createCommandRvcConverter({
            pythonPath: useOnnx
              ? rvc.onnxPythonPath || join(baseDir, 'venv-onnx', 'Scripts', 'python.exe')
              : rvc.pythonPath,
            scriptPath: useOnnx
              ? rvc.onnxScriptPath || join(baseDir, 'rvc_onnx_worker.py')
              : rvc.scriptPath,
            modelPath,
            indexPath: rvc.indexPath,
            device: useOnnx ? 'dml' : 'cpu',
            pitch: rvc.pitch,
            indexRate: rvc.indexRate,
            protect: rvc.protect,
            filterRadius: rvc.filterRadius,
            rmsMixRate: rvc.rmsMixRate,
            f0Method: rvc.f0Method,
            timeoutMs: rvc.timeoutMs,
            maxSeconds: rvc.maxSeconds,
            tempDir: join(rvc.modelsDir || dirname(modelPath), 'temp'),
          });
          const converted = await converter.convert(wav);
          if (converted.ok) wav = converted.wav;
          else rvcWarning = converted.message;
        }
        return send(200, {
          ok: true,
          mime: 'audio/wav',
          base64: Buffer.from(wav).toString('base64'),
          ...(rvcWarning === undefined ? { rvc: rvc.enabled } : { rvc: false, rvcWarning }),
        });
      }

      if (rest === 'model-info' && method === 'GET') {
        const { sel } = effectiveModel();
        const provider = url.searchParams.get('provider') ?? sel.provider;
        const model = url.searchParams.get('model') ?? sel.model;
        const llm = ctx.llm as {
          resolveModelInfo?: (p: string, m: string) => Promise<unknown>;
        };
        if (typeof llm.resolveModelInfo !== 'function') {
          return send(200, { ok: false, message: '当前 DSH 不提供模型能力信息' });
        }
        try {
          const info = await llm.resolveModelInfo(provider, model);
          return send(200, { ok: true, provider, model, info });
        } catch (e) {
          return send(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
        }
      }

      if (rest === 'gen-test') {
        if (method !== 'POST') return send(405, { error: 'method not allowed' });
        const { sel } = effectiveModel();
        const started = Date.now();
        const result = await generate(
          '你是群里的鲸鱼娘。只输出 JSON：{"messages":["在"],"action":"reply","thought":"测试"}',
          [],
          '在吗',
          { purpose: 'gen-test' },
        );
        return send(200, {
          ok: result.ok === true,
          model: { provider: sel.provider, model: sel.model },
          latencyMs: Date.now() - started,
          ...(result.ok === true ? { text: result.text } : { error: result.message }),
        });
      }

      if (rest === 'diary' || rest === 'diary/members' || rest === 'diary/export' || rest === 'diary/delete') {
        const groupFilter = url.searchParams.get('groupId') ?? '';
        const userFilter = url.searchParams.get('userId') ?? '';

        if (rest === 'diary/members' && method === 'GET') {
          const members = listProfiles(profiles, groupFilter, readSettings(root).profileRules).map((p) => ({
            qq: p.qq,
            name: p.name,
            familiarity: Math.round(p.familiarity),
            affinity: Math.round(p.affinity),
            messages: p.messages,
            mentions: p.mentions,
            replies: p.replies,
            diaryCount: readDiary(root).filter((e) => e.groupId === groupFilter && e.userId === p.qq).length,
          }));
          return send(200, { ok: true, members });
        }

        if (rest === 'diary/export' && method === 'GET') {
          const all = readDiary(root);
          const entries = all.filter(
            (e) => (groupFilter === '' || e.groupId === groupFilter) && (userFilter === '' || e.userId === userFilter),
          );
          return send(200, {
            ok: true,
            format: 'dsh-qq-group-diary',
            version: 1,
            exportedAt: new Date().toISOString(),
            groupId: groupFilter,
            userId: userFilter,
            entries,
          });
        }

        if (rest === 'diary/delete' && method === 'POST') {
          const parsed = (JSON.parse(body || 'null') as { ts?: unknown; groupId?: unknown; userId?: unknown; clear?: unknown } | null) ?? {};
          let entries = readDiary(root);
          if (parsed.clear === true) {
            entries = [];
          } else if (typeof parsed.ts === 'number') {
            entries = entries.filter((e) => e.ts !== parsed.ts);
          } else if (typeof parsed.groupId === 'string' || typeof parsed.userId === 'string') {
            const g = typeof parsed.groupId === 'string' ? parsed.groupId : '';
            const u = typeof parsed.userId === 'string' ? parsed.userId : '';
            entries = entries.filter((e) => !((g === '' || e.groupId === g) && (u === '' || e.userId === u)));
          } else {
            return send(200, { ok: false, message: '要删除单条请给 ts；按人/按群请给 userId/groupId；清空请给 clear:true' });
          }
          writeDiary(root, entries);
          return send(200, { ok: true, remaining: entries.length });
        }

        if (rest === 'diary' && method === 'GET') {
          const limitRaw = Number(url.searchParams.get('limit') ?? '50');
          const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.round(limitRaw))) : 50;
          const beforeRaw = Number(url.searchParams.get('before') ?? '');
          const fromRaw = Number(url.searchParams.get('from') ?? '');
          const toRaw = Number(url.searchParams.get('to') ?? '');
          const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
          const all = readDiary(root);
          let filtered = all.filter(
            (e) => (groupFilter === '' || e.groupId === groupFilter) && (userFilter === '' || e.userId === userFilter),
          );
          if (Number.isFinite(fromRaw) && fromRaw > 0) filtered = filtered.filter((e) => e.ts >= fromRaw);
          if (Number.isFinite(toRaw) && toRaw > 0) filtered = filtered.filter((e) => e.ts <= toRaw);
          if (Number.isFinite(beforeRaw) && beforeRaw > 0) filtered = filtered.filter((e) => e.ts < beforeRaw);
          const page = order === 'asc' ? filtered.slice(0, limit) : filtered.slice(-limit).reverse();
          return send(200, { ok: true, entries: page, total: filtered.length, hasMore: filtered.length > page.length });
        }

        return send(405, { error: 'method not allowed' });
      }

      if (rest === 'selfies' || rest === 'selfies/file' || rest === 'selfies/upload' || rest === 'selfies/delete' || rest === 'selfies/open') {
        if (rest === 'selfies/file' && method === 'GET') {
          const name = url.searchParams.get('name') ?? '';
          const path = selfieFile(root, name);
          if (path === undefined) return send(404, { ok: false, message: 'not found' });
          const ext = extname(path).toLowerCase();
          const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
          res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
          res.end(readFileSync(path));
          return;
        }
        if (rest === 'selfies/open' && method === 'POST') {
          if (process.platform !== 'win32') return send(200, { ok: false, message: '只有 Windows 支持直接打开文件夹' });
          const dir = selfieDir(root);
          mkdirSync(dir, { recursive: true });
          spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
          return send(200, { ok: true, path: dir });
        }
        if (rest === 'selfies/upload' && method === 'POST') {
          try {
            const parsed = JSON.parse(body || 'null') as { name?: unknown; data?: unknown } | null;
            const name = typeof parsed?.name === 'string' ? parsed.name : '';
            const data = typeof parsed?.data === 'string' ? parsed.data.replace(/^data:[^;]+;base64,/, '') : '';
            if (name === '' || data === '') return send(200, { ok: false, message: '缺少文件名或图片数据' });
            const item = saveSelfie(root, name, Buffer.from(data, 'base64'));
            return send(200, item === undefined ? { ok: false, message: '图片过大、格式不支持或重复' } : { ok: true, item });
          } catch (e) {
            return send(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
          }
        }
        if (rest === 'selfies/delete' && method === 'POST') {
          try {
            const parsed = JSON.parse(body || 'null') as { name?: unknown } | null;
            const name = typeof parsed?.name === 'string' ? parsed.name : '';
            if (name === '') return send(200, { ok: false, message: '缺少文件名' });
            return send(200, { ok: deleteSelfie(root, name) });
          } catch (e) {
            return send(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
          }
        }
        if (rest === 'selfies' && method === 'GET') {
          const items = listSelfies(root);
          return send(200, { ok: true, count: items.length, items, dir: selfieDir(root) });
        }
        return send(405, { error: 'method not allowed' });
      }

      if (rest === 'stickers/file' && method === 'GET') {
        const name = url.searchParams.get('name') ?? '';
        const path = stickerFile(root, name);
        if (path === undefined) {
          send(404, { ok: false, message: 'not found' });
          return;
        }
        const ext = extname(path).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
        res.end(readFileSync(path));
        return;
      }

      if (rest === 'stickers' || rest === 'stickers/open' || rest === 'stickers/repos' || rest === 'stickers/move' || rest === 'stickers/delete' || rest === 'stickers/update') {
        const dir = stickerFolder(root);
        if (rest === 'stickers/open' && method === 'POST') {
          if (process.platform !== 'win32') return send(200, { ok: false, message: '只有 Windows 支持直接打开文件夹' });
          try {
            mkdirSync(dir, { recursive: true });
            spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
            return send(200, { ok: true, path: dir });
          } catch (e) {
            return send(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
          }
        }
        if (rest === 'stickers/repos') {
          if (method === 'GET') {
            return send(200, { ok: true, repos: listStickerRepos(root), saveRepo: readSettings(root).stickerSaveRepo });
          }
          if (method !== 'POST') return send(405, { error: 'method not allowed' });
          const payload = JSON.parse(body || 'null') as { repos?: unknown } | null;
          try {
            const repos = updateStickerRepos(root, payload?.repos);
            return send(200, { ok: true, repos });
          } catch (e) {
            return send(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
          }
        }
        if (rest === 'stickers/move') {
          if (method !== 'POST') return send(405, { error: 'method not allowed' });
          const payload = JSON.parse(body || 'null') as { files?: unknown; repoId?: unknown } | null;
          const files = Array.isArray(payload?.files) ? payload.files.filter((f): f is string => typeof f === 'string') : [];
          const repoId = typeof payload?.repoId === 'string' ? payload.repoId : '';
          if (files.length === 0 || repoId === '') return send(200, { ok: false, message: '缺少 files/repoId' });
          try {
            return send(200, { ok: true, moved: moveStickers(root, files, repoId) });
          } catch (e) {
            return send(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
          }
        }
        if (rest === 'stickers/delete') {
          if (method !== 'POST') return send(405, { error: 'method not allowed' });
          const payload = JSON.parse(body || 'null') as { files?: unknown } | null;
          const files = Array.isArray(payload?.files) ? payload.files.filter((f): f is string => typeof f === 'string') : [];
          try {
            return send(200, { ok: true, deleted: deleteStickers(root, files) });
          } catch (e) {
            return send(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
          }
        }
        if (rest === 'stickers/update') {
          if (method !== 'POST') return send(405, { error: 'method not allowed' });
          const payload = JSON.parse(body || 'null') as
            | { file?: unknown; description?: unknown; tags?: unknown }
            | null;
          if (typeof payload?.file !== 'string') return send(200, { ok: false, message: '缺少 file' });
          const updated = updateStickerMeta(root, payload.file, {
            ...(typeof payload.description === 'string' ? { description: payload.description } : {}),
            ...(Array.isArray(payload.tags)
              ? { tags: payload.tags.filter((tag): tag is string => typeof tag === 'string') }
              : {}),
          });
          return send(200, updated === undefined ? { ok: false, message: '表情包不存在' } : { ok: true, item: updated });
        }
        const names = listStickerInfo(root).map((item) => item.file);
        const items = listStickerInfo(root).map((item) => ({
          file: item.file,
          tags: item.tags ?? [],
          description: item.description ?? '未分类',
          addedAt: item.addedAt ?? 0,
          repoId: item.repoId ?? '',
          repoName: item.repoName ?? '',
          repoWeight: item.repoWeight ?? 0,
          status: item.status ?? 'inbox',
          width: item.width,
          height: item.height,
          bytes: item.bytes,
          used: item.used ?? 0,
        }));
        return send(200, {
          ok: true,
          stickers: names,
          items,
          repos: listStickerRepos(root),
          count: names.length,
          saveEnabled: readSettings(root).stickerSave,
          saveRepo: readSettings(root).stickerSaveRepo,
          filter: readSettings(root).stickerFilter,
          max: readSettings(root).stickerMax,
          maxMB: readSettings(root).stickerMaxMB,
          dir,
        });
      }

      if (rest === 'rvc/models' || rest === 'rvc/open') {
        const cfg = readQqConfig(qqConfigPath(root)).config;
        const dir = cfg.rvc?.modelsDir ?? '';
        if (method === 'POST' && rest === 'rvc/open') {
          if (process.platform !== 'win32') return send(200, { ok: false, message: '只有 Windows 支持直接打开文件夹' });
          if (dir === '') return send(200, { ok: false, message: '还没有设置模型目录' });
          try {
            mkdirSync(dir, { recursive: true });
            spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
            return send(200, { ok: true, path: dir });
          } catch (e) {
            return send(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
          }
        }
        if (rest === 'rvc/models' && method === 'GET') {
          if (dir === '') return send(200, { ok: false, message: '还没有设置 RVC 模型目录', models: [] });
          return send(200, { ok: true, dir, models: scanRvcModels(dir) });
        }
        return send(405, { error: 'method not allowed' });
      }

      if (rest === 'safety') {
        if (method === 'GET') {
          const settings = readSettings(root);
          return send(200, {
            ok: true,
            settings: settings.safety,
            stats: qqHost.safetyStats(),
            presets: SAFETY_PRESETS,
          });
        }
        if (method !== 'POST') return send(405, { error: 'method not allowed' });
        const payload = JSON.parse(body || 'null') as { action?: unknown } | null;
        if (payload?.action === 'reset') {
          qqHost.safetyReset();
          return send(200, { ok: true, stats: qqHost.safetyStats() });
        }
        return send(200, { ok: false, message: '未知 action' });
      }

      if (rest === 'mood') {
        const urlGroup = url.searchParams.get('groupId') ?? '';
        if (method === 'GET') return send(200, await qqHost.mood(urlGroup, 'get'));
        if (method !== 'POST') return send(405, { error: 'method not allowed' });
        const payload = JSON.parse(body || 'null') as { action?: unknown; groupId?: unknown } | null;
        const groupId = typeof payload?.groupId === 'string' ? payload.groupId : urlGroup;
        return send(200, await qqHost.mood(groupId, payload?.action === 'reset' ? 'reset' : 'get'));
      }

      if (rest === 'memory') {
        const urlGroup = url.searchParams.get('groupId') ?? '';
        if (method === 'GET') {
          return send(200, await qqHost.memory('get', urlGroup));
        }
        if (method !== 'POST') return send(405, { error: 'method not allowed' });
        const payload = JSON.parse(body || 'null') as
          | {
              action?: unknown;
              groupId?: unknown;
              keyMemories?: unknown;
              text?: unknown;
              category?: unknown;
              importance?: unknown;
              factKey?: unknown;
              id?: unknown;
            }
          | null;
        const groupId = typeof payload?.groupId === 'string' ? payload.groupId : urlGroup;
        if (payload?.action === 'summary') {
          const text = typeof payload.text === 'string' ? payload.text.slice(0, 20_000) : '';
          try {
            const memoryPath = join(root, 'qq-memory.json');
            const memory = JSON.parse(readFileSync(memoryPath, 'utf8')) as {
              groups?: Record<string, { summary?: string }>;
            };
            memory.groups = memory.groups ?? {};
            memory.groups[groupId] = { ...(memory.groups[groupId] ?? {}), summary: text };
            writeFileSync(memoryPath, `${JSON.stringify(memory, null, 2)}\n`, 'utf8');
            return send(200, { ok: true });
          } catch (e) {
            return send(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
          }
        }
        if (payload?.action === 'set') {
          return send(200, await qqHost.memory('set', groupId, payload.keyMemories));
        }
        if (payload?.action === 'v3add') {
          return send(200, await qqHost.memory('v3add', groupId, payload));
        }
        if (payload?.action === 'v3update') {
          return send(200, await qqHost.memory('v3update', groupId, payload));
        }
        if (payload?.action === 'v3delete') {
          return send(200, await qqHost.memory('v3delete', groupId, payload));
        }
        if (payload?.action === 'compress') {
          return send(200, await qqHost.memory('compress', groupId));
        }
        return send(200, { ok: false, message: '未知的 action' });
      }

      if (rest === 'config') {
        if (method === 'GET') {
          const qq = await qqHost.handle('qq/config', 'GET');
          return send(200, { ok: true, qq, settings: readSettings(root) });
        }
        if (method !== 'POST') return send(405, { error: 'method not allowed' });
        const patch = (JSON.parse(body || 'null') as { qq?: unknown; settings?: Partial<Settings> } | null) ?? {};
        if (patch.qq !== undefined) {
          const saved = await qqHost.handle('qq/config', 'POST', JSON.stringify(patch.qq));
          if ((saved as { ok?: boolean }).ok === false) return send(200, saved);
        }
        if (patch.settings !== undefined) {
          const current = readSettings(root);
          const incomingPersonas = Array.isArray(patch.settings.personas)
            ? patch.settings.personas
                .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
                .map((item) => ({
                  id: typeof item.id === 'string' && item.id !== '' ? item.id : `persona-${Math.random().toString(36).slice(2, 10)}`,
                  name: typeof item.name === 'string' ? item.name.slice(0, 60) : '未命名',
                  text: typeof item.text === 'string' ? item.text.slice(0, 20_000) : '',
                }))
                .slice(0, 30)
            : undefined;
          // 旧客户端/旧页面保存时可能不带 personas；不要因此清空已有卡片。
          const personaCards =
            incomingPersonas === undefined
              ? current.personas
              : incomingPersonas.length === 0 && current.personas.length > 0
                ? current.personas
                : incomingPersonas;
          const requestedActive = typeof patch.settings.activePersonaId === 'string'
            ? patch.settings.activePersonaId
            : current.activePersonaId;
          const activePersonaId = personaCards.some((card) => card.id === requestedActive)
            ? requestedActive
            : (personaCards[0]?.id ?? '');
          const sharedIncoming =
            patch.settings.sharedTranscript !== null && typeof patch.settings.sharedTranscript === 'object'
              ? (patch.settings.sharedTranscript as Record<string, unknown>)
              : {};
          const digestIncoming =
            patch.settings.groupDigest !== null && typeof patch.settings.groupDigest === 'object'
              ? (patch.settings.groupDigest as Record<string, unknown>)
              : {};
          const next: Settings = {
            groupDigest: {
              memoryLines:
                typeof digestIncoming.memoryLines === 'number'
                  ? Math.round(clampNumber(digestIncoming.memoryLines, 0, 200, current.groupDigest.memoryLines))
                  : current.groupDigest.memoryLines,
              fileLines:
                typeof digestIncoming.fileLines === 'number'
                  ? Math.round(clampNumber(digestIncoming.fileLines, 1, 500, current.groupDigest.fileLines))
                  : current.groupDigest.fileLines,
            },
            sharedTranscript: {
              enabled:
                typeof sharedIncoming.enabled === 'boolean'
                  ? sharedIncoming.enabled
                  : current.sharedTranscript.enabled,
              turns:
                typeof sharedIncoming.turns === 'number'
                  ? Math.round(clampNumber(sharedIncoming.turns, 0, 5000, current.sharedTranscript.turns))
                  : current.sharedTranscript.turns,
              revealToGroup:
                typeof sharedIncoming.revealToGroup === 'boolean'
                  ? sharedIncoming.revealToGroup
                  : current.sharedTranscript.revealToGroup,
            },
            persona: typeof patch.settings.persona === 'string' ? patch.settings.persona : current.persona,
            personas: personaCards,
            groupPersonaIds:
              patch.settings.groupPersonaIds !== null && typeof patch.settings.groupPersonaIds === 'object'
                ? (Object.fromEntries(
                    Object.entries(patch.settings.groupPersonaIds as Record<string, unknown>)
                      .filter(([groupId, id]) => groupId !== '' && typeof id === 'string' && id !== '')
                      .slice(0, 200),
                  ) as Record<string, string>)
                : current.groupPersonaIds,
            ownerPriorityPrompt:
              typeof patch.settings.ownerPriorityPrompt === 'string'
                ? patch.settings.ownerPriorityPrompt
                : current.ownerPriorityPrompt,
            ownerFamiliarity:
              typeof patch.settings.ownerFamiliarity === 'number'
                ? clampNumber(patch.settings.ownerFamiliarity, 0, 100, current.ownerFamiliarity)
                : current.ownerFamiliarity,
            ownerAffinity:
              typeof patch.settings.ownerAffinity === 'number'
                ? clampNumber(patch.settings.ownerAffinity, -100, 100, current.ownerAffinity)
                : current.ownerAffinity,
            activePersonaId,
            mode:
              patch.settings.mode === 'proactive'
                ? 'proactive'
                : patch.settings.mode === 'passive'
                  ? 'passive'
                  : current.mode,
            qzone: (() => {
              const incoming =
                patch.settings.qzone !== null && typeof patch.settings.qzone === 'object'
                  ? (patch.settings.qzone as Record<string, unknown>)
                  : {};
              return {
                enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : current.qzone.enabled,
                mode:
                  incoming.mode === 'auto' || incoming.mode === 'manual' || incoming.mode === 'draft'
                    ? incoming.mode
                    : current.qzone.mode,
                ugcRight: [1, 4, 16, 64, 128].includes(Number(incoming.ugcRight))
                  ? Number(incoming.ugcRight)
                  : current.qzone.ugcRight,
                dailyLimit:
                  typeof incoming.dailyLimit === 'number'
                    ? Math.round(clampNumber(incoming.dailyLimit, 0, 20, current.qzone.dailyLimit))
                    : current.qzone.dailyLimit,
                minIntervalMinutes:
                  typeof incoming.minIntervalMinutes === 'number'
                    ? Math.round(
                        clampNumber(incoming.minIntervalMinutes, 0, 1440, current.qzone.minIntervalMinutes),
                      )
                    : current.qzone.minIntervalMinutes,
                imageMode:
                  incoming.imageMode === 'fixed' ||
                  incoming.imageMode === 'range' ||
                  incoming.imageMode === 'model' ||
                  incoming.imageMode === 'off'
                    ? incoming.imageMode
                    : current.qzone.imageMode,
                imageFixed:
                  typeof incoming.imageFixed === 'number'
                    ? Math.round(clampNumber(incoming.imageFixed, 0, 9, current.qzone.imageFixed))
                    : current.qzone.imageFixed,
                imageMin:
                  typeof incoming.imageMin === 'number'
                    ? Math.round(clampNumber(incoming.imageMin, 0, 9, current.qzone.imageMin))
                    : current.qzone.imageMin,
                imageMax:
                  typeof incoming.imageMax === 'number'
                    ? Math.round(clampNumber(incoming.imageMax, 0, 9, current.qzone.imageMax))
                    : current.qzone.imageMax,
                imageRepos: Array.isArray(incoming.imageRepos)
                  ? incoming.imageRepos
                      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
                      .slice(0, 50)
                  : current.qzone.imageRepos,
                mentionMode:
                  incoming.mentionMode === 'list' ||
                  incoming.mentionMode === 'model' ||
                  incoming.mentionMode === 'off'
                    ? incoming.mentionMode
                    : current.qzone.mentionMode,
                mentionList: Array.isArray(incoming.mentionList)
                  ? incoming.mentionList
                      .filter(
                        (x): x is { qq: string; name: string } =>
                          x !== null &&
                          typeof x === 'object' &&
                          /^\d{5,12}$/.test(String((x as { qq?: unknown }).qq ?? '')),
                      )
                      .map((x) => ({
                        qq: String(x.qq),
                        name:
                          typeof x.name === 'string' && x.name.trim() !== ''
                            ? x.name.trim().slice(0, 30)
                            : String(x.qq),
                      }))
                      .slice(0, 50)
                  : current.qzone.mentionList,
                mentionChance:
                  typeof incoming.mentionChance === 'number'
                    ? clampNumber(incoming.mentionChance, 0, 1, current.qzone.mentionChance)
                    : current.qzone.mentionChance,
                remoteEnabled:
                  typeof incoming.remoteEnabled === 'boolean'
                    ? incoming.remoteEnabled
                    : current.qzone.remoteEnabled,
                remoteRiskAccepted:
                  typeof incoming.remoteRiskAccepted === 'boolean'
                    ? incoming.remoteRiskAccepted
                    : current.qzone.remoteRiskAccepted,
                remoteLimit:
                  typeof incoming.remoteLimit === 'number'
                    ? Math.round(clampNumber(incoming.remoteLimit, 1, 50, current.qzone.remoteLimit))
                    : current.qzone.remoteLimit,
                commentEnabled:
                  typeof incoming.commentEnabled === 'boolean'
                    ? incoming.commentEnabled
                    : current.qzone.commentEnabled,
                commentRiskAccepted:
                  typeof incoming.commentRiskAccepted === 'boolean'
                    ? incoming.commentRiskAccepted
                    : current.qzone.commentRiskAccepted,
                autoChance:
                  typeof incoming.autoChance === 'number'
                    ? clampNumber(incoming.autoChance, 0, 1, current.qzone.autoChance)
                    : current.qzone.autoChance,
              };
            })(),
            permanent: (() => {
              const incoming =
                patch.settings.permanent !== null && typeof patch.settings.permanent === 'object'
                  ? (patch.settings.permanent as Record<string, unknown>)
                  : {};
              return {
                enabled:
                  typeof incoming.enabled === 'boolean' ? incoming.enabled : current.permanent.enabled,
                autoCapture:
                  typeof incoming.autoCapture === 'boolean'
                    ? incoming.autoCapture
                    : current.permanent.autoCapture,
                people: Array.isArray(incoming.people)
                  ? Array.from(
                      new Set(
                        incoming.people
                          .map((x) => String(x).trim())
                          .filter((x) => /^\d{5,12}$/.test(x)),
                      ),
                    ).slice(0, 50)
                  : current.permanent.people,
                capacity:
                  typeof incoming.capacity === 'number'
                    ? Math.round(clampNumber(incoming.capacity, 10, 5000, current.permanent.capacity))
                    : current.permanent.capacity,
                globalCapacity:
                  typeof incoming.globalCapacity === 'number'
                    ? Math.round(
                        clampNumber(incoming.globalCapacity, 10, 2000, current.permanent.globalCapacity),
                      )
                    : current.permanent.globalCapacity,
                recallLimit:
                  typeof incoming.recallLimit === 'number'
                    ? Math.round(clampNumber(incoming.recallLimit, 1, 50, current.permanent.recallLimit))
                    : current.permanent.recallLimit,
                recallChars:
                  typeof incoming.recallChars === 'number'
                    ? Math.round(
                        clampNumber(incoming.recallChars, 200, 8000, current.permanent.recallChars),
                      )
                    : current.permanent.recallChars,
              };
            })(),
            computerUse: (() => {
              const incoming =
                patch.settings.computerUse !== null && typeof patch.settings.computerUse === 'object'
                  ? (patch.settings.computerUse as Record<string, unknown>)
                  : {};
              return {
                enabled:
                  typeof incoming.enabled === 'boolean' ? incoming.enabled : current.computerUse.enabled,
                maxSteps:
                  typeof incoming.maxSteps === 'number'
                    ? Math.round(clampNumber(incoming.maxSteps, 1, 8, current.computerUse.maxSteps))
                    : current.computerUse.maxSteps,
              };
            })(),
            worldBridge: (() => {
              const incoming =
                patch.settings.worldBridge !== null && typeof patch.settings.worldBridge === 'object'
                  ? (patch.settings.worldBridge as Record<string, unknown>)
                  : {};
              return {
                enabled:
                  typeof incoming.enabled === 'boolean' ? incoming.enabled : current.worldBridge.enabled,
                worldId:
                  typeof incoming.worldId === 'string' && incoming.worldId.trim() !== ''
                    ? incoming.worldId.trim().slice(0, 80)
                    : current.worldBridge.worldId,
                privateWorldId:
                  typeof incoming.privateWorldId === 'string'
                    ? incoming.privateWorldId.trim().slice(0, 80)
                    : current.worldBridge.privateWorldId,
                worldDir:
                  typeof incoming.worldDir === 'string'
                    ? incoming.worldDir.trim().slice(0, 500)
                    : current.worldBridge.worldDir,
                privateBackend:
                  incoming.privateBackend === 'world' ||
                  incoming.privateBackend === 'plugin' ||
                  incoming.privateBackend === 'chat'
                    ? incoming.privateBackend
                    : current.worldBridge.privateBackend,
                wakeOnStart:
                  typeof incoming.wakeOnStart === 'boolean'
                    ? incoming.wakeOnStart
                    : current.worldBridge.wakeOnStart,
                settleMs:
                  typeof incoming.settleMs === 'number'
                    ? Math.round(clampNumber(incoming.settleMs, 0, 10_000, current.worldBridge.settleMs))
                    : current.worldBridge.settleMs,
              };
            })(),
            model:
              patch.settings.model &&
              typeof patch.settings.model.provider === 'string' &&
              typeof patch.settings.model.model === 'string'
                ? { provider: patch.settings.model.provider, model: patch.settings.model.model }
                : current.model,
            reasoningEffort:
              typeof patch.settings.reasoningEffort === 'string' ? patch.settings.reasoningEffort : current.reasoningEffort,
            contextWindows:
              patch.settings.contextWindows !== null && typeof patch.settings.contextWindows === 'object'
                ? Object.fromEntries(
                    Object.entries(patch.settings.contextWindows as Record<string, unknown>)
                      .filter(
                        ([key, value]) =>
                          key.includes('/') &&
                          typeof value === 'number' &&
                          Number.isFinite(value) &&
                          value >= 1000,
                      )
                      .map(([key, value]) => [key, Math.min(2_000_000, Math.max(1000, Math.round(value as number)))]),
                  )
                : current.contextWindows,
            fallbackModel:
              patch.settings.fallbackModel &&
              typeof patch.settings.fallbackModel.provider === 'string' &&
              typeof patch.settings.fallbackModel.model === 'string'
                ? { provider: patch.settings.fallbackModel.provider, model: patch.settings.fallbackModel.model }
                : current.fallbackModel,
            stickerSave: typeof patch.settings.stickerSave === 'boolean' ? patch.settings.stickerSave : current.stickerSave,
            stickerFilter: patch.settings.stickerFilter === 'all' ? 'all' : 'smart',
            stickerSaveRepo:
              typeof patch.settings.stickerSaveRepo === 'string' && patch.settings.stickerSaveRepo.trim() !== ''
                ? patch.settings.stickerSaveRepo.trim()
                : current.stickerSaveRepo,
            stickerAnalyzeOnSave:
              typeof patch.settings.stickerAnalyzeOnSave === 'boolean'
                ? patch.settings.stickerAnalyzeOnSave
                : current.stickerAnalyzeOnSave,
            stickerMax:
              typeof patch.settings.stickerMax === 'number'
                ? Math.min(2000, Math.max(20, Math.round(patch.settings.stickerMax)))
                : current.stickerMax,
            stickerMaxMB:
              typeof patch.settings.stickerMaxMB === 'number'
                ? Math.min(5000, Math.max(20, Math.round(patch.settings.stickerMaxMB)))
                : current.stickerMaxMB,
            autoStart: typeof patch.settings.autoStart === 'boolean' ? patch.settings.autoStart : current.autoStart,
            autoLaunchNapcat:
              typeof patch.settings.autoLaunchNapcat === 'boolean'
                ? patch.settings.autoLaunchNapcat
                : current.autoLaunchNapcat,
            napcatLauncher:
              typeof patch.settings.napcatLauncher === 'string' && patch.settings.napcatLauncher.trim() !== ''
                ? patch.settings.napcatLauncher.trim()
                : current.napcatLauncher,
            whitelist: Array.isArray(patch.settings.whitelist)
              ? patch.settings.whitelist.filter((qq): qq is string => typeof qq === 'string' && /^\d{5,12}$/.test(qq.trim())).map((qq) => qq.trim())
              : current.whitelist,
            whitelistFloor:
              typeof patch.settings.whitelistFloor === 'number'
                ? Math.min(100, Math.max(0, Math.round(patch.settings.whitelistFloor)))
                : current.whitelistFloor,
            blacklist: Array.isArray(patch.settings.blacklist)
              ? patch.settings.blacklist.filter((qq): qq is string => typeof qq === 'string' && /^\d{5,12}$/.test(qq.trim())).map((qq) => qq.trim())
              : current.blacklist,
            blacklistCeil:
              typeof patch.settings.blacklistCeil === 'number'
                ? Math.min(100, Math.max(0, Math.round(patch.settings.blacklistCeil)))
                : current.blacklistCeil,
            nightDnd:
              patch.settings.nightDnd !== null && typeof patch.settings.nightDnd === 'object'
                ? {
                    enabled: patch.settings.nightDnd.enabled !== false,
                    startHour:
                      typeof patch.settings.nightDnd.startHour === 'number'
                        ? Math.min(23, Math.max(0, Math.round(patch.settings.nightDnd.startHour)))
                        : current.nightDnd.startHour,
                    endHour:
                      typeof patch.settings.nightDnd.endHour === 'number'
                        ? Math.min(23, Math.max(0, Math.round(patch.settings.nightDnd.endHour)))
                        : current.nightDnd.endHour,
                  }
                : current.nightDnd,
            nightPenalty:
              typeof patch.settings.nightPenalty === 'number'
                ? Math.min(100, Math.max(0, Math.round(patch.settings.nightPenalty)))
                : current.nightPenalty,
            scoreWeights: (() => {
              const input =
                patch.settings.scoreWeights !== null && typeof patch.settings.scoreWeights === 'object'
                  ? (patch.settings.scoreWeights as Record<string, unknown>)
                  : undefined;
              if (input === undefined) return current.scoreWeights;
              const out: ScoreWeights = { ...current.scoreWeights };
              for (const key of Object.keys(DEFAULT_SCORE_WEIGHTS) as Array<keyof ScoreWeights>) {
                const value = input[key];
                if (typeof value === 'number' && Number.isFinite(value)) {
                  out[key] = Math.min(key === 'shortMessageChars' ? 100 : key === 'base' ? 100 : 1000, Math.max(0, Math.round(value)));
                }
              }
              return out;
            })(),
            profileRules: (() => {
              const input =
                patch.settings.profileRules !== null && typeof patch.settings.profileRules === 'object'
                  ? (patch.settings.profileRules as Record<string, unknown>)
                  : undefined;
              if (input === undefined) return current.profileRules;
              const out: ProfileRules = { ...current.profileRules };
              for (const key of Object.keys(DEFAULT_PROFILE_RULES) as Array<keyof ProfileRules>) {
                const value = input[key];
                if (typeof value === 'number' && Number.isFinite(value)) {
                  out[key] = Math.min(1000, Math.max(0, value));
                }
              }
              return out;
            })(),
            hostilityJudge:
              typeof patch.settings.hostilityJudge === 'boolean'
                ? patch.settings.hostilityJudge
                : current.hostilityJudge,
            cookieWatch:
              typeof patch.settings.cookieWatch === 'boolean' ? patch.settings.cookieWatch : current.cookieWatch,
            customVoices: Array.isArray(patch.settings.customVoices)
              ? patch.settings.customVoices
                  .filter(
                    (v): v is { id: string; label: string } =>
                      v !== null &&
                      typeof v === 'object' &&
                      typeof (v as { id?: unknown }).id === 'string' &&
                      (v as { id: string }).id.trim() !== '',
                  )
                  .map((v) => ({
                    id: v.id.trim(),
                    label: typeof v.label === 'string' && v.label.trim() !== '' ? v.label.trim() : v.id.trim(),
                  }))
                  .slice(0, 200)
              : current.customVoices,
            usageRates:
              patch.settings.usageRates !== null &&
              typeof patch.settings.usageRates === 'object' &&
              !Array.isArray(patch.settings.usageRates)
                ? Object.fromEntries(
                    Object.entries(patch.settings.usageRates as Record<string, unknown>)
                      .filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
                      .map(([k, v]) => [k, Number(v)]),
                  )
                : current.usageRates,
            balance:
              patch.settings.balance === null
                ? null
                : patch.settings.balance !== null &&
                    typeof patch.settings.balance === 'object' &&
                    typeof (patch.settings.balance as { credits?: unknown }).credits === 'number'
                  ? { credits: Math.max(0, Number((patch.settings.balance as { credits: number }).credits)), setAt: Date.now() }
                  : current.balance,
            // 安全防护：整段覆盖（前端发的是完整对象），缺字段沿用当前值。
            safety: (() => {
              const incoming = patch.settings.safety;
              if (incoming === null || typeof incoming !== 'object') return current.safety;
              const src = incoming as Record<string, unknown>;
              const profileId = String(src.profile ?? '') as SafetyProfile;
              const profile: SafetyProfile =
                profileId === 'unlimited' || profileId === 'loose' || profileId === 'standard' || profileId === 'strict'
                  ? profileId
                  : current.safety.profile;
              const preset = SAFETY_PRESETS[profile] as Record<string, unknown>;
              const profileChanged = profile !== current.safety.profile;
              // 规则只有两条，不需要「谁手改过」这种记账：
              //   换档位 → 整档铺预设，前端带上来的旧数字一律忽略；
              //   没换档位 → 用前端传的数值（那就是主人刚在输入框里调的）。
              //
              // 2026-10-28 修：之前这里不管换没换档都在比对，而前端保存时会把
              // 整套旧数字一起发上来，于是每个字段都被判成「改过」，预设一个都
              // 没生效。主人选了「无限制」，实际还在按标准档拦他，群里不接话。
              const merged = profileChanged
                ? ({ ...current.safety, ...preset, profile } as SafetySettings)
                : ({ ...current.safety, profile } as SafetySettings);
              if (!profileChanged) {
                for (const [k, v] of Object.entries(src)) {
                  if (v === undefined) continue;
                  if (k === 'profile' || k === 'tuned') continue;
                  (merged as unknown as Record<string, unknown>)[k] = v;
                }
              }
              // 不属于阈值预设的开关项照常接受
              if (typeof src.enabled === 'boolean') merged.enabled = src.enabled;
              if (typeof src.economy === 'string') merged.economy = src.economy as SafetySettings['economy'];
              for (const k of [
                'privateExempt', 'offPeakStart', 'offPeakEnd', 'nightStart', 'nightEnd',
                'repeatWindowMinutes', 'healthProbeMinutes', 'dailySummary',
              ]) {
                if (src[k] !== undefined) (merged as unknown as Record<string, unknown>)[k] = src[k];
              }
              return merged;
            })(),
          };
          writeSettings(root, next);
          // 群实况条数是设置项：改完当场重渲染，别等群里下一句话才生效。
          try {
            renderDigestFile(readDigest());
            syncTraceBlock();
          } catch {
            /* 重渲染失败不影响保存 */
          }
          // 角色卡/绑定一改，世界那边立刻跟上，不用等下一句私聊。
          syncPersonaToWorld();
        }
        seedExistingProfiles();
        const qq = await qqHost.handle('qq/config', 'GET');
        return send(200, { ok: true, qq, settings: readSettings(root) });
      }

      if (rest === 'launch-napcat') {
        if (method !== 'POST') return send(405, { error: 'method not allowed' });
        return send(200, await ensureNapcat());
      }

      if (rest === 'start') {
        // 「启动」= 需要的话先拉起 NapCat，再连 OneBot；这样不用自己去找 bat。
        const napcat = await ensureNapcat();
        if (!napcat.ok) return send(200, { ok: false, message: napcat.message, napcat });
        const tts = await ensureTtsGateway();
        const started = (await qqHost.handle('qq/start', 'POST')) as Record<string, unknown>;
        return send(200, { ...started, napcat, tts });
      }
      if (rest === 'stop') return send(200, await qqHost.handle('qq/stop', 'POST'));
      if (rest === 'say') return send(200, await qqHost.handle('qq/say', 'POST', body));
      if (rest === 'test') return send(200, await qqHost.handle('qq/test', 'POST'));
      if (rest === 'sing') return send(200, await qqHost.handle('qq/sing', 'POST', body));
      if (rest === 'scores') return send(200, await qqHost.handle('qq/scores', 'GET'));

      if (rest === 'memory/permanent') {
        const settings = readSettings(root);
        const urlGroup = url.searchParams.get('groupId') ?? '';
        if (method === 'GET') {
          const groupId = urlGroup;
          if (groupId === '') return send(200, { ok: false, message: '缺少 groupId' });
          const store = readPermanentStore(permanentPath(root));
          const globalBucket = store.global;
          const sessionBucket = store.groups[groupId];
          const globalItems = permanentList(root, groupId, 'global');
          const sessionItems = permanentList(root, groupId, 'session');
          return send(200, {
            ok: true,
            groupId,
            global: {
              items: globalItems,
              count: globalItems.length,
              capacity: settings.permanent.globalCapacity,
              sealed: globalBucket?.sealedAt !== undefined,
            },
            session: {
              items: sessionItems,
              count: sessionItems.length,
              capacity: settings.permanent.capacity,
              sealed: sessionBucket?.sealedAt !== undefined,
            },
          });
        }
        if (method !== 'POST') return send(405, { error: 'method not allowed' });
        const payload = (JSON.parse(body || 'null') as {
          action?: unknown;
          groupId?: unknown;
          text?: unknown;
          id?: unknown;
          ids?: unknown;
          scope?: unknown;
          sensitivity?: unknown;
        } | null) ?? {};
        const groupId = typeof payload.groupId === 'string' ? payload.groupId : urlGroup;
        if (groupId === '') return send(200, { ok: false, message: '缺少 groupId' });
        const action = typeof payload.action === 'string' ? payload.action : '';
        const scope: PermanentScope = payload.scope === 'global' ? 'global' : 'session';
        const sensitivity = payload.sensitivity === 'private' ? 'private' : 'normal';
        if (action === 'add') {
          const text = typeof payload.text === 'string' ? payload.text.trim() : '';
          const capacity =
            scope === 'global' ? settings.permanent.globalCapacity : settings.permanent.capacity;
          const added = permanentAdd(
            root,
            groupId,
            { text, people: [], source: 'manual', scope, sensitivity },
            capacity,
          );
          if (!added.ok) {
            return send(200, {
              ok: false,
              reason: added.reason,
              message:
                added.reason === 'full'
                  ? `永久记忆已满（${added.capacity} 条）；请先删除或合并，旧记忆不会被自动删除`
                  : '记忆内容为空',
            });
          }
          return send(200, { ok: true, item: added.item });
        }
        if (action === 'delete') {
          const id = typeof payload.id === 'string' ? payload.id : '';
          const ok = id !== '' && permanentDelete(root, groupId, id, scope);
          return send(200, ok ? { ok: true } : { ok: false, message: '没有找到这条记忆' });
        }
        if (action === 'promote') {
          const id = typeof payload.id === 'string' ? payload.id : '';
          if (id === '') return send(200, { ok: false, message: '缺少 id' });
          const path = permanentPath(root);
          const store = readPermanentStore(path);
          const bucket = store.groups[groupId];
          if (bucket === undefined) return send(200, { ok: false, message: '提升失败：会话不存在' });
          const item = bucket.items.find((entry) => entry.id === id);
          if (item === undefined) return send(200, { ok: false, message: '提升失败：条目不存在' });
          const trace = makeTrace({
            text: item.text,
            domain: 'owner',
            importance: 0.9,
            emotion: 0.5,
            createdAt: item.createdAt,
            source: 'manual',
          });
          upsertTrace(traceStoreDir(), trace);
          store.groups[groupId] = {
            ...bucket,
            items: bucket.items.filter((entry) => entry.id !== id),
            updatedAt: Date.now(),
          };
          writePermanentStore(path, store);
          syncTraceBlock();
          return send(200, { ok: true, trace });
        }
        if (action === 'merge') {
          const ids = Array.isArray(payload.ids)
            ? payload.ids.filter((x): x is string => typeof x === 'string').slice(0, 50)
            : [];
          const selected = permanentList(root, groupId, scope).filter((item) => ids.includes(item.id));
          if (selected.length < 2) return send(200, { ok: false, message: '至少选择两条永久记忆' });
          const material = selected.map((item) => `- ${item.text}`).join('\n');
          const result = await generate(
            [
              '把下面多条永久记忆合并成一条。',
              '要求：保留事实、约定、称呼、偏好和关键细节；去掉重复和口水话；不要添加原文没有的内容。',
              '只输出合并后的正文，不要列表、不要解释，最多 2000 字。',
            ].join('\n'),
            [],
            material,
            { purpose: 'permanent-merge', maxTokens: 700, timeoutMs: 40_000 },
          );
          const mergedText = result.ok
            ? result.text.trim().slice(0, 2000)
            : selected.map((item) => item.text).join('；').slice(0, 2000);
          if (mergedText === '') return send(200, { ok: false, message: '合并结果为空' });
          const merged = permanentMerge(root, groupId, ids, mergedText, scope);
          if (merged === undefined) return send(200, { ok: false, message: '合并失败' });
          return send(200, {
            ok: true,
            item: merged,
            count: permanentList(root, groupId, scope).length,
          });
        }
        return send(200, { ok: false, message: '未知 action' });
      }

      if (rest === 'qzone/remote' && method === 'GET') {
        const qz = readSettings(root).qzone;
        if (!qz.remoteEnabled || !qz.remoteRiskAccepted) {
          return send(200, { ok: false, message: '远程读取未启用，或尚未接受风险提示' });
        }
        const cookies = (await qqHost.qzone('cookies')) as {
          ok?: boolean;
          cookies?: string;
          bkn?: string;
          message?: string;
        };
        if (cookies.ok !== true || cookies.cookies === undefined) {
          return send(200, { ok: false, message: cookies.message || '拿不到 Qzone cookies' });
        }
        const cookieUin = /(?:^|;\s*)uin=o?(\d{5,12})/.exec(cookies.cookies)?.[1] ?? '';
        const uinParam = (url.searchParams.get('uin') ?? '').trim();
        const uin = /^\d{5,12}$/.test(uinParam) ? uinParam : cookieUin;
        if (uin === '') return send(200, { ok: false, message: '无法确定要读取的 QQ 号' });
        const limit = Math.max(1, Math.min(20, Math.round(Number(url.searchParams.get('limit') ?? '10') || 10)));
        const endpoint =
          'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6' +
          `?uin=${encodeURIComponent(uin)}&ftype=0&sort=0&pos=0&num=${limit}` +
          `&replynum=10&g_tk=${encodeURIComponent(cookies.bkn ?? '')}` +
          '&code_version=1&format=json&need_private_comment=1';
        try {
          const response = await fetch(endpoint, {
            headers: {
              cookie: cookies.cookies,
              'user-agent': 'Mozilla/5.0',
              referer: `https://user.qzone.qq.com/${uin}`,
            },
            signal: AbortSignal.timeout(20_000),
          });
          const data = (await response.json()) as {
            code?: unknown;
            message?: unknown;
            msglist?: unknown;
          };
          if (data.code !== undefined && Number(data.code) !== 0) {
            return send(200, { ok: false, message: String(data.message ?? `Qzone code=${String(data.code)}`) });
          }
          const strip = (html: string): string =>
            html
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<[^>]+>/g, '')
              .replace(/&nbsp;/gi, ' ')
              .replace(/&amp;/gi, '&')
              .replace(/&lt;/gi, '<')
              .replace(/&gt;/gi, '>')
              .replace(/\s+/g, ' ')
              .trim();
          const includeComments = qz.commentEnabled && qz.commentRiskAccepted;
          const list = Array.isArray(data.msglist) ? data.msglist : [];
          const entries = list.slice(0, limit).map((raw) => {
            const item = (raw ?? {}) as Record<string, unknown>;
            const comments = includeComments && Array.isArray(item.conlist)
              ? item.conlist.slice(0, 10).map((c) => {
                  const comment = (c ?? {}) as Record<string, unknown>;
                  return {
                    name: typeof comment.name === 'string' ? comment.name : '',
                    uin: typeof comment.uin === 'number' ? String(comment.uin) : '',
                    content: typeof comment.content === 'string' ? strip(comment.content) : '',
                    ts: typeof comment.createTime === 'number' ? comment.createTime * 1000 : 0,
                  };
                })
              : [];
            return {
              tid: typeof item.tid === 'string' ? item.tid : '',
              content: typeof item.content === 'string' ? strip(item.content) : '',
              ts: typeof item.createTime === 'number' ? item.createTime * 1000 : 0,
              commentCount: typeof item.cmtnum === 'number' ? item.cmtnum : comments.length,
              images: Array.isArray(item.pic) ? item.pic.filter((x): x is string => typeof x === 'string').slice(0, 9) : [],
              comments,
            };
          });
          return send(200, {
            ok: true,
            uin,
            entries,
            risk: 'Qzone cookie 读取可能触发风控；仅在需要时手动读取，不要高频轮询。',
          });
        } catch (e) {
          return send(200, { ok: false, message: e instanceof Error ? e.message : String(e) });
        }
      }

      if (rest === 'qzone') {
        const settings = readSettings(root);
        if (method === 'GET') {
          const available = (await qqHost.qzone('available')) as { ok?: boolean };
          const limit = Math.max(1, Math.min(200, Math.round(Number(url.searchParams.get('limit') ?? '50') || 50)));
          const before = Number(url.searchParams.get('before') ?? '');
          const from = Number(url.searchParams.get('from') ?? '');
          const to = Number(url.searchParams.get('to') ?? '');
          const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
          let filtered = readQzone(root);
          if (Number.isFinite(from) && from > 0) filtered = filtered.filter((e) => e.ts >= from);
          if (Number.isFinite(to) && to > 0) filtered = filtered.filter((e) => e.ts <= to);
          if (Number.isFinite(before) && before > 0) filtered = filtered.filter((e) => e.ts < before);
          const page =
            order === 'asc' ? filtered.slice(0, limit) : filtered.slice(-limit).reverse();
          return send(200, {
            ok: true,
            settings: settings.qzone,
            entries: page,
            total: filtered.length,
            hasMore: filtered.length > page.length,
            available: available.ok === true,
          });
        }
        if (method !== 'POST') return send(405, { error: 'method not allowed' });
        const payload = (JSON.parse(body || 'null') as {
          action?: unknown;
          content?: unknown;
          tid?: unknown;
          ugcRight?: unknown;
          images?: unknown;
        } | null) ?? {};
        const action = typeof payload.action === 'string' ? payload.action : '';

        if (action === 'generate') {
          const today = new Date();
          const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
          const entries = readDiary(root)
            .filter((e) => e.ts >= start)
            .slice(-6);
          if (entries.length === 0) {
            return send(200, { ok: false, message: '今天还没有日记，先聊几句再生成' });
          }
          const qzone = settings.qzone;
          const material = entries
            .map((e) => `- 群友：${(e.incoming ?? '').slice(0, 120)}；她：${e.reply.slice(0, 160)}；内心：${(e.thought ?? '').slice(0, 160)}`)
            .join('\n');
          const mentionCandidates = qzone.mentionList.map((m) => `${m.name}（${m.qq}）`).join('、');
          const systemLines = [
            '你在帮鲸鱼娘写一条 QQ 空间说说，用第一人称，像她自己在分享生活。',
            '要求：100~180 字；口语、有画面、有情绪；可以提今天的聊天感受，但不要复述群聊原文。',
            '绝对不能出现：QQ 号、群号、人名、文件路径、链接、任何隐私；不要提“AI”“模型”“插件”。',
            '不要用列表、不要用话题标签、不要写“今天更新了”。只输出说说正文。',
          ];
          if (qzone.mentionMode === 'model' && mentionCandidates !== '' && Math.random() < qzone.mentionChance) {
            systemLines.push(`可选 @ 名单：${mentionCandidates}。如果合适，在正文里写「@昵称」，不要写 QQ 号；也可以不 @。`);
          }
          const result = await generate(systemLines.join('\n'), [], `今天的素材：\n${material}`, {
            purpose: 'qzone',
            maxTokens: 400,
            timeoutMs: 40_000,
          });
          if (!result.ok) return send(200, { ok: false, message: result.message });
          const mention = chooseQzoneMention(qzone);
          let content = sanitizeQzone(result.text.trim());
          if (mention !== undefined && !content.startsWith('@')) {
            content = `@${mention.name} ${content}`.slice(0, 2000);
          }
          let imageCount = 0;
          if (qzone.imageMode === 'fixed') imageCount = qzone.imageFixed;
          else if (qzone.imageMode === 'range') {
            const min = Math.min(qzone.imageMin, qzone.imageMax);
            const max = Math.max(qzone.imageMin, qzone.imageMax);
            imageCount = min + Math.floor(Math.random() * (max - min + 1));
          } else if (qzone.imageMode === 'model') {
            const decided = await generate(
              '只输出一个 0 到 9 的整数，表示这条说说配几张图；不要解释。',
              [],
              `说说内容：${content}`,
              { purpose: 'qzone-image', maxTokens: 20, timeoutMs: 15_000 },
            );
            const match = decided.ok ? /\d+/u.exec(decided.text) : null;
            imageCount = match === null ? Math.floor(Math.random() * 4) : Number(match[0]);
          }
          imageCount = Math.max(0, Math.min(9, Math.round(imageCount)));
          const images = pickQzoneImages(root, qzone, imageCount);
          return send(200, {
            ok: true,
            content,
            images,
            imageCount: images.length,
            mention: mention === undefined ? null : { qq: mention.qq, name: mention.name },
          });
        }

        if (action === 'publish') {
          if (!settings.qzone.enabled) return send(200, { ok: false, message: 'QQ空间未启用' });
          let content = sanitizeQzone(typeof payload.content === 'string' ? payload.content : '');
          if (content === '') return send(200, { ok: false, message: '说说正文为空' });
          const history = readQzone(root);
          const now = Date.now();
          const dayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
          const todayCount = history.filter((e) => e.ts >= dayStart).length;
          if (todayCount >= settings.qzone.dailyLimit) {
            return send(200, { ok: false, message: `今天已达上限（${settings.qzone.dailyLimit} 条）` });
          }
          const last = history[history.length - 1];
          if (last !== undefined && now - last.ts < settings.qzone.minIntervalMinutes * 60_000) {
            return send(200, { ok: false, message: `距上一条不足 ${settings.qzone.minIntervalMinutes} 分钟` });
          }
          const ugcRight =
            typeof payload.ugcRight === 'number' && [1, 4, 16, 64, 128].includes(payload.ugcRight)
              ? payload.ugcRight
              : settings.qzone.ugcRight;
          const mention = chooseQzoneMention(settings.qzone);
          if (mention !== undefined && !content.startsWith('@')) {
            content = `@${mention.name} ${content}`.slice(0, 2000);
          }
          let images = Array.isArray(payload.images)
            ? payload.images
                .filter((x): x is string => typeof x === 'string')
                .filter((p) => /\.(?:png|jpe?g|gif|webp)$/i.test(p) && existsSync(p))
                .slice(0, 9)
            : [];
          if (images.length === 0 && settings.qzone.imageMode !== 'off') {
            let count = 0;
            if (settings.qzone.imageMode === 'fixed') count = settings.qzone.imageFixed;
            else if (settings.qzone.imageMode === 'range') {
              const min = Math.min(settings.qzone.imageMin, settings.qzone.imageMax);
              const max = Math.max(settings.qzone.imageMin, settings.qzone.imageMax);
              count = min + Math.floor(Math.random() * (max - min + 1));
            } else {
              count = Math.floor(Math.random() * 4);
            }
            images = pickQzoneImages(root, settings.qzone, count);
          }
          const published = (await qqHost.qzone('publish', { content, ugcRight, images })) as {
            ok?: boolean;
            tid?: string;
            message?: string;
          };
          if (published.ok !== true) {
            return send(200, { ok: false, message: published.message || '发布失败' });
          }
          appendQzone(root, {
            tid: published.tid ?? '',
            content,
            ts: now,
            ugcRight,
            ...(images.length > 0 ? { images } : {}),
          });
          return send(200, { ok: true, tid: published.tid ?? '' });
        }

        if (action === 'delete') {
          const tid = typeof payload.tid === 'string' ? payload.tid.trim() : '';
          if (tid === '') return send(200, { ok: false, message: '缺少 tid' });
          const deleted = (await qqHost.qzone('delete', { tid })) as { ok?: boolean; message?: string };
          if (deleted.ok !== true) return send(200, { ok: false, message: deleted.message || '删除失败' });
          writeQzone(root, readQzone(root).filter((e) => e.tid !== tid));
          return send(200, { ok: true });
        }

        return send(200, { ok: false, message: '未知 action' });
      }

      const proxied = await qqHost.handle(`qq/${rest}`, method, body);
      if (proxied === null) return send(404, { error: 'not found', rest });
      return send(200, proxied);
    } catch (e) {
      send(500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  // 启用了就自动连：DSH 重启后不用再点一次「启动」。
  // NapCat 没开时会一直显示「重连中」，等 NapCat 起来会自动连上。
  ctx.effect(() => {
    let cancelled = false;
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (cancelled) return;
      try {
        const cfg = readQqConfig(qqConfigPath(root)).config;
        const settings = readSettings(root);
        if (settings.autoStart && (cfg.enabled || Object.keys(cfg.groups).length > 0)) {
          const napcat = await ensureNapcat();
          if (napcat.ok) await qqHost.handle('qq/start', 'POST');
        }
      } catch {
        /* 启动失败会体现在状态里 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, 'dsh-qq-group: auto-start');

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: '/dsh-qq-group', handler: route });
    return () => {
      dispose?.();
      void qqHost.dispose();
    };
  }, 'dsh-qq-group: routes');
}
