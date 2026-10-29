import type { ChatImage } from './llm';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type WorldBridgeInfo = {
  ok: boolean;
  enabled: boolean;
  worldId: string;
  worldDir: string;
  online: boolean;
  name?: string;
  origin?: string;
  /** 投递路径。老版本的世界没有这个字段，按 /dsh-world/bridge/say 兜底。 */
  path?: string;
  /** 只给桥接客户端用；/world/status 会去掉 */
  token?: string;
  pid?: number;
  pidAlive?: boolean;
  startedAt?: string;
  message?: string;
};

/** dsh-world 默认把世界放在 <DSH_HOME>/worlds/<worldId>。 */
export function resolveWorldDir(root: string, worldId: string, configured = ''): string {
  if (configured.trim() !== '') return configured.trim();
  const parent = dirname(root);
  if (parent.endsWith('.dsh')) return join(parent, 'worlds', worldId);
  return join(homedir(), '.dsh', 'worlds', worldId);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 只读 bridge.json；不发送任何世界消息。 */
export function readWorldBridge(
  root: string,
  options: { enabled: boolean; worldId: string; worldDir: string },
): WorldBridgeInfo {
  const worldId = options.worldId.trim() === '' ? 'default' : options.worldId.trim();
  const worldDir = resolveWorldDir(root, worldId, options.worldDir);
  const base: WorldBridgeInfo = {
    ok: false,
    enabled: options.enabled,
    worldId,
    worldDir,
    online: false,
  };
  const file = join(worldDir, 'bridge.json');
  if (!existsSync(file)) {
    return { ...base, message: 'bridge.json 不存在；dsh-world 还没启动或没开 bridge' };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      origin?: unknown;
      path?: unknown;
      token?: unknown;
      pid?: unknown;
      startedAt?: unknown;
      name?: unknown;
    };
    const origin = typeof parsed.origin === 'string' ? parsed.origin.trim() : '';
    const bridgePath = typeof parsed.path === 'string' && parsed.path.startsWith('/') ? parsed.path : undefined;
    const pid = typeof parsed.pid === 'number' ? parsed.pid : 0;
    const name = typeof parsed.name === 'string' ? parsed.name : undefined;
    const startedAt = typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined;
    const alive = pidAlive(pid);
    return {
      ...base,
      ok: origin !== '' && typeof parsed.token === 'string' && parsed.token !== '',
      online: origin !== '' && alive,
      ...(name === undefined ? {} : { name }),
      ...(origin === '' ? {} : { origin }),
      ...(bridgePath === undefined ? {} : { path: bridgePath }),
      ...(typeof parsed.token === 'string' && parsed.token !== '' ? { token: parsed.token } : {}),
      ...(pid === 0 ? {} : { pid }),
      pidAlive: alive,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(alive ? {} : { message: 'bridge.json 存在，但 pid 不在运行' }),
    };
  } catch (e) {
    return { ...base, message: `bridge.json 读取失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 把话送进她的家；dsh-world 返回 202 表示已受理。 */
export async function postWorldSay(
  info: WorldBridgeInfo,
  text: string,
  images: ChatImage[] = [],
): Promise<void> {
  if (!info.online || info.origin === undefined || info.token === undefined) {
    throw new Error('世界桥不在线');
  }
  const encodedImages = images.slice(0, 4).map((image) => {
    const base64 = Buffer.from(image.data).toString('base64');
    return `data:${image.mediaType};base64,${base64}`;
  });
  const response = await fetch(`${info.origin}${info.path ?? '/dsh-world/bridge/say'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dsh-world-token': info.token,
    },
    body: JSON.stringify({ text, ...(encodedImages.length > 0 ? { images: encodedImages } : {}) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`世界桥受理失败 HTTP ${response.status}${body === '' ? '' : `：${body.slice(0, 200)}`}`);
  }
}

export type WorldOutletPayload = {
  text?: unknown;
  kind?: unknown;
  name?: unknown;
  images?: unknown;
};

/** 连着发的几条会在这个窗口内合并成一次投递，和群聊的去抖一致。 */
const SETTLE_MS = 2500;
/** 默认攒多久再送。设置里可改（0 = 一收到就送，不攒）。 */
const DEFAULT_SETTLE_MS = SETTLE_MS;

/** dsh-world 只跟踪最近一条消息，所以这里串行送、串行等回复。 */
export class WorldRelay {
  private readonly queue: Array<{ text: string; voice: boolean; sticker: boolean; images: ChatImage[] }> = [];
  private busy = false;
  private waiter: ((reply: { text: string; images: string[] } | null) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 攒消息的窗口计时器：你连着打字时，等停一下再一起送。 */
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: {
      getInfo: () => WorldBridgeInfo;
      deliver: (
        text: string,
        kind: 'reply' | 'reach',
        options?: { voice?: boolean; sticker?: boolean; images?: string[] },
      ) => Promise<void>;
      notify: (text: string) => Promise<void>;
      timeoutMs?: number;
      /** 攒消息窗口（毫秒）。0 = 不攒，一收到就送。 */
      settleMs?: () => number;
      log?: (message: string) => void;
      /** 投递留痕：她到底收到了什么，供主人核对。 */
      record?: (entry: { at: number; chars: number; images: number; voice: boolean; sticker: boolean; preview: string }) => void;
    },
  ) {}

  /** 返回 false 表示当前不能接管，调用方应回退普通聊天。 */
  enqueue(text: string, options?: { voice?: boolean; sticker?: boolean; images?: ChatImage[] }): boolean {
    const info = this.options.getInfo();
    if (!info.online || info.token === undefined || info.origin === undefined) return false;
    this.queue.push({
      text,
      voice: options?.voice === true,
      sticker: options?.sticker === true,
      images: options?.images ?? [],
    });
    this.schedule();
    return true;
  }

  /** 你连着发的几条，先攒一小会儿再一起送进去——她看到的是一整段，不是被切碎的单句。 */
  private schedule(): void {
    if (this.busy) return;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    const settle = Math.max(0, Math.round(this.options.settleMs?.() ?? DEFAULT_SETTLE_MS));
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      void this.pump();
    }, settle);
  }

  /** 把窗口内攒下的消息合成一次投递：多条用换行隔开，语音/表情取并集。 */
  private drainBatch(): { text: string; voice: boolean; sticker: boolean; images: ChatImage[] } | undefined {
    const batch: Array<{ text: string; voice: boolean; sticker: boolean; images: ChatImage[] }> = [];
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next !== undefined) batch.push(next);
    }
    if (batch.length === 0) return undefined;
    if (batch.length === 1) {
      const one = batch[0]!;
      return one;
    }
    const text = batch.map((item) => item.text.trim()).filter((part) => part !== '').join('\n');
    return {
      text: `[连着发的 ${batch.length} 条]\n${batch
        .map((item) => item.text.trim())
        .filter((part) => part !== '')
        .map((part) => `- ${part}`)
        .join('\n')}\n\n（这是主人一口气连着说的几句，一起看，别只回最后一句）`,
      voice: batch.some((item) => item.voice),
      sticker: batch.some((item) => item.sticker),
      images: batch.flatMap((item) => item.images).slice(0, 4),
    };
  }

  /** outlet 收到她的话。reach 不占用队列，直接转发。 */
  outlet(payload: WorldOutletPayload): boolean {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const kind = typeof payload.kind === 'string' ? payload.kind : 'reply';
    const images = Array.isArray(payload.images)
      ? payload.images
          .filter((url): url is string => typeof url === 'string' && /^https?:\/\//iu.test(url))
          .slice(0, 4)
      : [];
    if (text === '' && images.length === 0) return false;
    if (kind === 'reach') {
      void this.options.deliver(text, 'reach', { images });
      return true;
    }
    if (kind !== 'reply') return false;
    if (this.waiter === null) {
      this.options.log?.('世界桥回复到达，但当前没有等待中的私聊，已丢弃');
      return false;
    }
    const resolve = this.waiter;
    this.waiter = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    resolve({ text, images });
    return true;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length > 0) {
        const item = this.drainBatch();
        if (item === undefined) break;
        const text = item.text;
        const info = this.options.getInfo();
        if (!info.online || info.token === undefined || info.origin === undefined) {
          await this.options.notify('世界桥刚好离线了，这条没有送进去。');
          continue;
        }
        try {
          await postWorldSay(info, text, item.images);
        } catch (e) {
          await this.options.notify(`世界桥送话失败：${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        const reply = await this.waitForReply(this.options.timeoutMs ?? 240_000);
        if (reply !== null) {
          // 留痕：记她这一次真正说出去的话，预览去掉标签、压平换行，方便主人核对。
          const tidyPreview = reply.text
            .replace(/<\/?br\s*\/?>/giu, ' ')
            .replace(/\s+/gu, ' ')
            .trim();
          this.options.record?.({
            at: Date.now(),
            chars: tidyPreview.length,
            images: reply.images.length,
            voice: item.voice,
            sticker: item.sticker,
            preview: tidyPreview.slice(0, 160),
          });
          await this.options.deliver(reply.text, 'reply', {
            voice: item.voice,
            sticker: item.sticker,
            images: reply.images,
          });
        } else {
          await this.options.notify('她这次没有回消息；可能还在忙，也可能这个世界桥没把回复推出来。');
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private waitForReply(timeoutMs: number): Promise<{ text: string; images: string[] } | null> {
    return new Promise((resolve) => {
      this.waiter = resolve;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
    });
  }
}

export type WorldConversationLine = { time: string; role: string; content: string };

export type WorldMemorySnapshot = {
  ok: boolean;
  worldDir: string;
  self: string;
  persona: string;
  worldPrompt: string;
  permanent: string;
  diaries: Array<{ date: string; text: string }>;
  conversations: WorldConversationLine[];
  compactions: Array<Record<string, unknown>>;
  message?: string;
};

function readText(file: string): string {
  try { return existsSync(file) ? readFileSync(file, 'utf8') : ''; } catch { return ''; }
}

/** 只读世界记忆快照：自述、日记、最近对话、压缩记录、QQ 永久记忆导出。 */
export function readWorldMemory(
  root: string,
  options: { enabled: boolean; worldId: string; worldDir: string },
  limit = 80,
): WorldMemorySnapshot {
  const worldDir = resolveWorldDir(root, options.worldId, options.worldDir);
  const result: WorldMemorySnapshot = {
    ok: true, worldDir, self: '', persona: '', worldPrompt: '', permanent: '', diaries: [], conversations: [], compactions: [],
  };
  try {
    result.self = readText(join(worldDir, 'room', '我是谁.md'));
    result.persona = readText(join(worldDir, 'persona.md'));
    result.worldPrompt = readText(join(worldDir, 'world-prompt.md'));
    result.permanent = readText(join(worldDir, 'room', 'from-qq-permanent.md'));
    const diaryDir = join(worldDir, 'diary');
    if (existsSync(diaryDir)) {
      result.diaries = readdirSync(diaryDir)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name))
        .sort()
        .slice(-14)
        .reverse()
        .map((name) => ({ date: name.slice(0, 10), text: readText(join(diaryDir, name)) }));
    }
    const convDir = join(worldDir, 'conversations');
    if (existsSync(convDir)) {
      const files = readdirSync(convDir)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name))
        .sort()
        .slice(-5);
      const lines: WorldConversationLine[] = [];
      for (const name of files) {
        const raw = readText(join(convDir, name));
        for (const line of raw.split(/\r?\n/u)) {
          if (line.trim() === '') continue;
          try {
            const item = JSON.parse(line) as { occurredAt?: unknown; role?: unknown; content?: unknown };
            if (typeof item.content !== 'string') continue;
            lines.push({
              time: typeof item.occurredAt === 'string' ? item.occurredAt : '',
              role: typeof item.role === 'string' ? item.role : '',
              content: item.content.slice(0, 1200),
            });
          } catch { /* skip broken line */ }
        }
      }
      result.conversations = lines.slice(-Math.max(1, Math.min(500, limit)));
    }
    const comp = readText(join(worldDir, 'compactions.jsonl'));
    result.compactions = comp
      .split(/\r?\n/u)
      .filter(Boolean)
      .slice(-20)
      .flatMap((line) => {
        try {
          const item = JSON.parse(line) as Record<string, unknown>;
          return [item];
        } catch { return []; }
      });
  } catch (e) {
    result.ok = false;
    result.message = e instanceof Error ? e.message : String(e);
  }
  return result;
}

export function writeWorldSelf(root: string, options: { worldId: string; worldDir: string }, text: string): void {
  const dir = resolveWorldDir(root, options.worldId, options.worldDir);
  mkdirSync(join(dir, 'room'), { recursive: true });
  writeFileSync(join(dir, 'room', '我是谁.md'), text, 'utf8');
}

export function writeWorldPersona(
  root: string,
  options: { worldId: string; worldDir: string },
  text: string,
): void {
  const dir = resolveWorldDir(root, options.worldId, options.worldDir);
  writeFileSync(join(dir, 'persona.md'), text, 'utf8');
}

export function writeWorldPrompt(
  root: string,
  options: { worldId: string; worldDir: string },
  text: string,
): void {
  const dir = resolveWorldDir(root, options.worldId, options.worldDir);
  writeFileSync(join(dir, 'world-prompt.md'), text, 'utf8');
}

export function writeWorldDiary(
  root: string,
  options: { worldId: string; worldDir: string },
  date: string,
  text: string,
): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('日期格式必须是 YYYY-MM-DD');
  const dir = resolveWorldDir(root, options.worldId, options.worldDir);
  mkdirSync(join(dir, 'diary'), { recursive: true });
  writeFileSync(join(dir, 'diary', date + '.md'), text, 'utf8');
}

/** 把 QQ 插件的永久记忆同步成 world 房间里的只读文件。 */
/**
 * 世界人设跟随 QQ 插件：把「p:<主人QQ>」这个私聊绑定的角色卡写进 world/persona.md。
 *
 * 为什么要这一步：QQ 和世界原来是两份独立副本，改一份另一份不知道，
 * 时间一长就是两个她。现在只认 QQ 插件那一份——那才是主人手动选的地方。
 *
 * 绑定优先级和 QQ 插件里一致：私聊绑定的卡 > 全局激活卡 > 旧 persona 字段。
 * 文件内容没变就不写（避免 mtime 抖动触发世界重读提示词）。
 *
 * 返回 true 表示同步完成（哪怕内容没变）；worldDir 不可用时返回 false。
 */
export function syncWorldPersona(
  root: string,
  options: { worldId: string; worldDir: string },
  ownerQq: string,
  settings: {
    persona?: string;
    activePersonaId?: string;
    personas?: Array<{ id: string; name?: string; text: string }>;
    groupPersonaIds?: Record<string, string>;
  },
): boolean {
  try {
    const cards = settings.personas ?? [];
    const key = `p:${ownerQq}`;
    const boundId = settings.groupPersonaIds?.[key] ?? '';
    const bound = cards.find((item) => item.id === boundId);
    const active = cards.find((item) => item.id === settings.activePersonaId);
    const text = (bound?.text ?? active?.text ?? settings.persona ?? '').trim();
    if (text === '') return false;
    const dir = resolveWorldDir(root, options.worldId, options.worldDir);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'persona.md');
    if (existsSync(target) && readFileSync(target, 'utf8') === `${text}\n`) return true;
    writeFileSync(target, `${text}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function syncWorldPermanent(
  root: string,
  options: { worldId: string; worldDir: string },
): boolean {
  try {
    const file = join(root, 'permanent-memory.json');
    if (!existsSync(file)) return false;
    const pm = JSON.parse(readFileSync(file, 'utf8')) as {
      global?: { items?: Array<{ text?: unknown }> };
      groups?: Record<string, { items?: Array<{ text?: unknown }> }>;
    };
    const lines = ['# 来自 QQ 插件的永久记忆', '', '这是 dsh-qq-group 自动导出的只读副本，不是 world 自己写的日记。', ''];
    const push = (title: string, items: Array<{ text?: unknown }> | undefined): void => {
      const valid = (items ?? []).filter((item) => typeof item.text === 'string' && item.text.trim() !== '');
      if (valid.length === 0) return;
      lines.push(`## ${title}`, '');
      for (const item of valid) lines.push(`- ${String(item.text).replace(/\n/gu, ' / ')}`);
      lines.push('');
    };
    push('全局主人记忆', pm.global?.items);
    for (const [groupId, group] of Object.entries(pm.groups ?? {})) push(`群 ${groupId}`, group.items);
    const dir = resolveWorldDir(root, options.worldId, options.worldDir);
    mkdirSync(join(dir, 'room'), { recursive: true });
    const target = join(dir, 'room', 'from-qq-permanent.md');
    const text = lines.join('\n');
    if (!existsSync(target) || readFileSync(target, 'utf8') !== text) writeFileSync(target, text, 'utf8');
    return true;
  } catch {
    return false;
  }
}
