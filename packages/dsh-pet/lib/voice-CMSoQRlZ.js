import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

//#region src/host/voice.ts
const DEFAULT_VOICE = "zh-CN-XiaoyiNeural";
const DEFAULT_RATE = "+0%";
const DEFAULT_GATEWAY_ENDPOINT = "http://127.0.0.1:50123";
/** 单次合成超时：热调用约 1 秒，给足 25 秒余量兜卡死 */
const TTS_TIMEOUT_MS = 25e3;
/**
* 常驻 worker 的 Python 源码。
*
* 协议（stdin/stdout，二进制）：
*   请求  = uint32 BE 长度 + UTF-8 JSON {text, voice, rate, pitch, volume}
*   响应  = uint8 状态（0 = 成功音频，1 = 错误文本）+ uint32 BE 长度 + 载荷
*
* 用定长前缀而不是行分隔：MP3 是二进制，任何分隔符都可能出现在音频里。
*
* pitch / volume 是后加的（QQ 群唱歌与「换个调说话」要用），**空串表示不传**：
* edge-tts 对不认的参数会直接抛 TypeError，老版本 edge-tts 上没有这两个关键字，
* 所以带条件拼 kwargs，而不是一股脑塞进去。
*/
const TTS_WORKER_SCRIPT = String.raw`
import asyncio
import json
import struct
import sys

import edge_tts

DEFAULT_VOICE = "zh-CN-XiaoyiNeural"
DEFAULT_RATE = "+0%"


async def synth(text: str, voice: str, rate: str, pitch: str, volume: str) -> bytes:
    out = bytearray()
    kwargs = {"rate": rate}
    if pitch:
        kwargs["pitch"] = pitch
    if volume:
        kwargs["volume"] = volume
    communicate = edge_tts.Communicate(text, voice, **kwargs)
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            out.extend(chunk["data"])
    return bytes(out)


def read_exact(stream, size: int) -> bytes:
    data = stream.read(size)
    return data if data is not None else b""


def main() -> int:
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer
    while True:
        head = read_exact(stdin, 4)
        if len(head) < 4:
            return 0
        (length,) = struct.unpack(">I", head)
        payload = read_exact(stdin, length)
        if len(payload) < length:
            return 0
        try:
            request = json.loads(payload.decode("utf-8"))
            text = str(request.get("text") or "")
            voice = str(request.get("voice") or DEFAULT_VOICE)
            rate = str(request.get("rate") or DEFAULT_RATE)
            pitch = str(request.get("pitch") or "")
            volume = str(request.get("volume") or "")
            if not text.strip():
                raise ValueError("empty text")
            audio = asyncio.run(synth(text, voice, rate, pitch, volume))
            status, body = 0, audio
        except Exception as exc:  # noqa: BLE001 —— 任何失败都要让 Node 侧看见原因
            status, body = 1, f"{type(exc).__name__}: {exc}".encode("utf-8", "replace")
        stdout.write(bytes([status]))
        stdout.write(struct.pack(">I", len(body)))
        stdout.write(body)
        stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
`;
function resolvePython(configured) {
	if (configured !== void 0 && configured.trim() !== "") return configured.trim();
	if (process.env.DSH_PYTHON) return process.env.DSH_PYTHON;
	const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
	if (home) {
		const bundled = [join(home, ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python", "python.exe"), join(home, ".dsh", "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python", "bin", "python3")];
		for (const candidate of bundled) if (existsSync(candidate)) return candidate;
	}
	return process.platform === "win32" ? "python.exe" : "python3";
}
/** 驱动脚本落盘位置（每进程只写一次） */
let scriptPath;
function ensureScript(userRoot) {
	if (scriptPath !== void 0 && existsSync(scriptPath)) return scriptPath;
	const dir = join(userRoot, "cache");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "tts-worker.py");
	writeFileSync(file, TTS_WORKER_SCRIPT, "utf8");
	scriptPath = file;
	return file;
}
function createTtsWorker(python, script) {
	let child;
	let buffer = Buffer.alloc(0);
	let pending = [];
	let starting;
	let dead = false;
	/** 按长度前缀切包，逐条兑现等待者 */
	function onData(chunk) {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 5) {
			const status = buffer[0];
			const length = buffer.readUInt32BE(1);
			if (buffer.length < 5 + length) return;
			const body = buffer.subarray(5, 5 + length);
			buffer = buffer.subarray(5 + length);
			const waiting = pending.shift();
			if (waiting === void 0) continue;
			clearTimeout(waiting.timer);
			if (status === 0) waiting.resolve({
				ok: true,
				audio: new Uint8Array(body),
				mime: "audio/mpeg"
			});
			else {
				const message = body.toString("utf8");
				const isImportError = /ModuleNotFoundError|No module named '?edge_tts/.test(message);
				waiting.resolve({
					ok: false,
					reason: isImportError ? "edge-tts-missing" : "error",
					message: isImportError ? "Python 里没有 edge-tts（请执行 pip install edge-tts）" : message
				});
			}
		}
	}
	/** 确保进程在跑；失败抛错（由调用方转成结构化失败） */
	function ensure() {
		if (child !== void 0 && !dead) return Promise.resolve();
		if (starting !== void 0) return starting;
		starting = new Promise((resolvePromise, reject) => {
			const spawned = spawn(python, [script], {
				stdio: [
					"pipe",
					"pipe",
					"pipe"
				],
				windowsHide: true
			});
			let settled = false;
			spawned.on("error", (err) => {
				if (settled) return;
				settled = true;
				starting = void 0;
				reject(err.code === "ENOENT" ? Object.assign(new Error(`找不到 Python：${python}`), { code: "python-missing" }) : err);
			});
			spawned.on("spawn", () => {
				if (settled) return;
				settled = true;
				child = spawned;
				buffer = Buffer.alloc(0);
				dead = false;
				starting = void 0;
				resolvePromise();
			});
			spawned.stdout.on("data", (chunk) => onData(chunk));
			spawned.stderr.on("data", () => {});
			spawned.on("close", () => {
				dead = true;
				child = void 0;
				const waiting = pending;
				pending = [];
				for (const p of waiting) {
					clearTimeout(p.timer);
					p.resolve({
						ok: false,
						reason: "worker-dead",
						message: "语音合成进程意外退出"
					});
				}
			});
		});
		return starting;
	}
	async function synthesize$1(text, voice, rate, extras = {}) {
		const trimmed = text.trim();
		if (trimmed === "") return {
			ok: false,
			reason: "empty-text",
			message: "要合成的文本为空"
		};
		try {
			await ensure();
		} catch (e) {
			const err = e;
			if (err.code === "python-missing") return {
				ok: false,
				reason: "python-missing",
				message: err.message
			};
			return {
				ok: false,
				reason: "error",
				message: err.message
			};
		}
		const running = child;
		if (running === void 0) return {
			ok: false,
			reason: "worker-dead",
			message: "语音合成进程不可用"
		};
		const payload = Buffer.from(JSON.stringify({
			text: trimmed,
			voice,
			rate,
			pitch: extras.pitch ?? "",
			volume: extras.volume ?? ""
		}), "utf8");
		const header = Buffer.alloc(4);
		header.writeUInt32BE(payload.length, 0);
		return new Promise((resolvePromise) => {
			const timer = setTimeout(() => {
				pending = pending.filter((p) => p.timer !== timer);
				child?.kill();
				resolvePromise({
					ok: false,
					reason: "timeout",
					message: `语音合成超时（${TTS_TIMEOUT_MS} ms）`
				});
			}, TTS_TIMEOUT_MS);
			pending.push({
				resolve: resolvePromise,
				timer
			});
			try {
				running.stdin.write(header);
				running.stdin.write(payload);
			} catch (e) {
				clearTimeout(timer);
				pending = pending.filter((p) => p.timer !== timer);
				resolvePromise({
					ok: false,
					reason: "worker-dead",
					message: e instanceof Error ? e.message : String(e)
				});
			}
		});
	}
	/** 插件卸载时收掉子进程，别留孤儿 */
	function dispose() {
		child?.kill();
		child = void 0;
		dead = true;
	}
	return {
		synthesize: synthesize$1,
		dispose
	};
}
/** 每个 (python, 用户目录) 组合一个 worker —— 正常情况只有一个 */
const workers = new Map();
/** 取（或建）worker；key 里带 python 路径，换解释器时不会复用旧进程 */
function workerFor(python, userRoot) {
	const key = `${python}::${userRoot}`;
	const existing = workers.get(key);
	if (existing !== void 0) return existing;
	const created = createTtsWorker(python, ensureScript(userRoot));
	workers.set(key, created);
	return created;
}
function disposeVoiceWorkers() {
	for (const worker of workers.values()) worker.dispose();
	workers.clear();
}
/**
* 本地 TTS 网关（GPT-SoVITS）合成。
*
* ── 为什么要走 HTTP 网关而不是直接调 Python ──
* GPT-SoVITS 本体是一个常驻的 Python 服务（api_v2.py 听 9880），换音色要重新加载
* 上百 MB 权重。把它塞进宿主进程既没法热重载、又会让插件启动慢几十秒。
* 所以这里只做一件事：**调一个已经在跑的 HTTP 网关**（默认 127.0.0.1:50123）。
* 网关负责切换权重、挑情感参考音频；插件只知道「给文本和音色，拿 WAV」。
*
* ── 为什么必须先健康检查 ──
* 服务没起来时 fetch 会等到超时（网关内部给合成留了 180 秒）。桌宠按住说话是
* **实时交互**，等三分钟等于卡死。所以先打 /health，2.5 秒不通就直接回退 edge-tts。
*
* ── 为什么返回 WAV 也要检查 ──
* 网关出错时返回的是 JSON 错误体，不是音频。只看 `response.ok` 会把一段 JSON
* 当音频丢给播放器，表现为「点了没声，也没有报错」——最难查的那种。所以校验 RIFF 头。
*/
async function synthesizeGateway(endpoint, text, options) {
	const base = endpoint.trim().replace(/\/+$/, "");
	if (base === "") return {
		ok: false,
		reason: "gateway-unavailable",
		message: "本地 TTS 网关地址为空（voice.json 的 endpoint）"
	};
	try {
		const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2500) });
		if (!health.ok) return {
			ok: false,
			reason: "gateway-unavailable",
			message: `本地 TTS 网关未就绪（HTTP ${health.status}）`
		};
	} catch (e) {
		return {
			ok: false,
			reason: "gateway-unavailable",
			message: `本地 TTS 网关不可用：${base}（${e instanceof Error ? e.message : String(e)}）`
		};
	}
	try {
		const response = await fetch(`${base}/tts`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				text,
				...options.voice === void 0 ? {} : { voice: options.voice },
				...options.style === void 0 ? {} : { style: options.style }
			}),
			signal: AbortSignal.timeout(12e4)
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			return {
				ok: false,
				reason: "gateway-error",
				message: `本地 TTS 网关 ${response.status}：${detail.slice(0, 300)}`
			};
		}
		const audio = new Uint8Array(await response.arrayBuffer());
		if (audio.length < 12 || audio[0] !== 82 || audio[1] !== 73 || audio[2] !== 70 || audio[3] !== 70) return {
			ok: false,
			reason: "gateway-error",
			message: "本地 TTS 网关没有返回 WAV（RIFF 头缺失）"
		};
		return {
			ok: true,
			audio,
			mime: "audio/wav"
		};
	} catch (e) {
		return {
			ok: false,
			reason: "gateway-error",
			message: `本地 TTS 网关调用失败：${e instanceof Error ? e.message : String(e)}`
		};
	}
}
async function synthesize(userRoot, text, options = {}) {
	const provider = options.provider ?? "edge";
	if (provider === "gpt-sovits") {
		const local = await synthesizeGateway(options.endpoint ?? DEFAULT_GATEWAY_ENDPOINT, text, {
			voice: options.voice,
			style: options.style
		});
		if (local.ok) return local;
		console.warn(`[dsh-whale-girl] 本地 GPT-SoVITS 失败，回退 edge-tts：${local.message}`);
	}
	const edgeVoice = typeof options.voice === "string" && /^[a-z]{2}-[A-Z]{2}-/i.test(options.voice) ? options.voice : DEFAULT_VOICE;
	const python = resolvePython(options.pythonPath);
	const worker = workerFor(python, userRoot);
	return worker.synthesize(text, edgeVoice, options.rate ?? DEFAULT_RATE, {
		pitch: options.pitch,
		volume: options.volume
	});
}

//#endregion
export { DEFAULT_GATEWAY_ENDPOINT, DEFAULT_RATE, DEFAULT_VOICE, createTtsWorker, disposeVoiceWorkers, resolvePython, synthesize };