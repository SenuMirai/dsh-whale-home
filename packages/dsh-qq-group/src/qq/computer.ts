import { spawn } from 'node:child_process';

import type { ComputerHost } from './computer-host';

export type ComputerToolResult =
  | { ok: true; text: string; png?: Uint8Array }
  | { ok: false; message: string };

export type ComputerTool = 'screenshot' | 'click' | 'type' | 'keypress' | 'scroll';

/** 调用 resources/windows-driver.ps1；只接受白名单动作，不把任意 shell 暴露给模型。 */
export async function runComputerTool(
  driver: string,
  tool: string,
  args: unknown,
  host?: ComputerHost,
): Promise<ComputerToolResult> {
  let payload: Record<string, unknown>;
  switch (tool) {
    case 'screenshot':
      payload = { action: 'screenshot', maxWidth: 1280, maxHeight: 800 };
      break;
    case 'click': {
      const input = (args ?? {}) as Record<string, unknown>;
      const x = Number(input.x);
      const y = Number(input.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, message: 'click 需要数字 x/y' };
      const button = input.button === 'right' || input.button === 'middle' ? input.button : 'left';
      const clicks = Math.max(1, Math.min(3, Math.round(Number(input.clicks ?? 1))));
      payload = { action: 'click', x, y, button, clicks, delayMs: 80 };
      break;
    }
    case 'type': {
      const input = (args ?? {}) as Record<string, unknown>;
      const text = typeof input.text === 'string' ? input.text.slice(0, 2000) : '';
      if (text === '') return { ok: false, message: 'type 需要 text' };
      payload = { action: 'type', text };
      break;
    }
    case 'keypress': {
      const input = (args ?? {}) as Record<string, unknown>;
      const keys = Array.isArray(input.keys)
        ? input.keys.filter((x): x is string => typeof x === 'string').slice(0, 4)
        : [];
      if (keys.length === 0) return { ok: false, message: 'keypress 需要 keys' };
      payload = { action: 'keypress', keys, delayMs: 80 };
      break;
    }
    case 'scroll': {
      const input = (args ?? {}) as Record<string, unknown>;
      const amount = Math.max(-10, Math.min(10, Math.round(Number(input.amount ?? 0))));
      if (amount === 0) return { ok: false, message: 'scroll 需要非零 amount' };
      payload = { action: 'scroll', amount };
      break;
    }
    default:
      return { ok: false, message: `不支持的电脑工具：${tool}` };
  }

  // 常驻宿主：省掉每次启动 powershell 和重新编译 C# 的开销（500ms → 几十毫秒）。
  if (host !== undefined && host.available()) {
    try {
      const reply = await host.call(payload);
      if (reply.ok === true) {
        if (typeof reply.pngBase64 === 'string') {
          return { ok: true, text: '已截图', png: new Uint8Array(Buffer.from(reply.pngBase64, 'base64')) };
        }
        return { ok: true, text: '已执行' };
      }
      // 宿主明确说不行（参数不对之类）就别再退回慢路
      if (typeof reply.message === 'string' && reply.message !== '') {
        return { ok: false, message: reply.message };
      }
    } catch {
      /* 宿主出问题就退回一次性调用 */
    }
  }

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driver, '-PayloadBase64', encoded],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let done = false;
    const finish = (result: ComputerToolResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, message: '电脑工具执行超时（30 秒）' });
    }, 30_000);
    child.stdout.on('data', (chunk) => out.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => err.push(Buffer.from(chunk)));
    child.on('error', (e) => finish({ ok: false, message: `启动 Windows 驱动失败：${e.message}` }));
    child.on('close', () => {
      const stdout = Buffer.concat(out).toString('utf8').trim();
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (stdout === '') {
        finish({ ok: false, message: stderr || 'Windows 驱动没有返回结果' });
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { pngBase64?: unknown; width?: unknown; height?: unknown };
        if (tool === 'screenshot' && typeof parsed.pngBase64 === 'string') {
          finish({
            ok: true,
            text: `截图 ${String(parsed.width ?? '')}x${String(parsed.height ?? '')}`,
            png: Buffer.from(parsed.pngBase64, 'base64'),
          });
          return;
        }
        finish({ ok: true, text: `${tool} 已执行` });
      } catch {
        finish({ ok: false, message: `Windows 驱动返回非 JSON：${stdout.slice(0, 200)}` });
      }
    });
  });
}
