/**
 * 常驻的桌面操作宿主。
 *
 * 为什么要有这个：原来是「一次动作 ⇒ 起一个 powershell.exe ⇒ Add-Type 重新编译 C#」，
 * 单次 500~600ms，其中 95% 花在启动和编译上。点一次要半秒，实时游戏根本玩不了。
 *
 * 现在：进程常驻，C# 只编译一次，之后一行 JSON 进、一行 JSON 出。
 * 单次开销降到几十毫秒。
 *
 * 设计：
 * - 串行队列：一个请求处理完才发下一个，避免 stdout 交错。
 * - 空闲 5 分钟自动退出，不留后台垃圾。
 * - 进程挂了会自动重启一次；连续失败就退回到「一次性调用」。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type HostReply = Record<string, unknown> & { ok?: boolean; message?: string };

const IDLE_MS = 5 * 60_000;

export class ComputerHost {
  private child: ReturnType<typeof spawn> | null = null;
  private pending: Array<{ resolve: (v: HostReply) => void; reject: (e: Error) => void }> = [];
  private stdoutBuf = '';
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly script: string;

  constructor(resourcesDir: string) {
    this.script = join(resourcesDir, 'computer-host.ps1');
  }

  available(): boolean {
    return existsSync(this.script);
  }

  private ensure(): ReturnType<typeof spawn> {
    if (this.child !== null && this.child.exitCode === null) return this.child;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.script],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.stdoutBuf += chunk;
      let idx = this.stdoutBuf.indexOf('\n');
      while (idx >= 0) {
        const line = this.stdoutBuf.slice(0, idx).trim();
        this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
        if (line !== '') {
          const waiter = this.pending.shift();
          if (waiter !== undefined) {
            try {
              waiter.resolve(JSON.parse(line) as HostReply);
            } catch {
              waiter.reject(new Error(`host 返回的不是 JSON：${line.slice(0, 120)}`));
            }
          }
        }
        idx = this.stdoutBuf.indexOf('\n');
      }
    });
    child.on('exit', () => {
      this.child = null;
      const lost = this.pending;
      this.pending = [];
      for (const w of lost) w.reject(new Error('computer host 已退出'));
    });
    child.stderr?.on('data', () => {
      /* 启动噪音，忽略；真错误会走响应 */
    });
    this.child = child;
    return child;
  }

  private touchIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
    this.idleTimer.unref?.();
  }

  /** 发一个请求；串行执行，保证不回错配。 */
  call(payload: Record<string, unknown>): Promise<HostReply> {
    const task = this.queue.then(() => this.dispatch(payload));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private dispatch(payload: Record<string, unknown>): Promise<HostReply> {
    const child = this.ensure();
    this.touchIdle();
    return new Promise<HostReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error('computer host 超时（20s）'));
      }, 20_000);
      this.pending.push({
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        child.stdin?.write(`${JSON.stringify(payload)}\n`);
      } catch (e) {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  stop(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.child !== null) {
      try {
        this.child.stdin?.end();
      } catch {
        /* 已经没了 */
      }
      this.child = null;
    }
  }
}
