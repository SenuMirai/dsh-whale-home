import { jsonObject, knownHost, readBody, sendJson } from "../http.js";
import { PERSONA_LAYERS } from "../persona.js";
import { validTurns, validWechatBuffer, validWechatContext, MAX_WECHAT_BUFFER_SECONDS, MAX_WECHAT_CONTEXT } from "../worldSwitch.js";
import { validArchiveScope } from "../archiveSelection.js";
export const CONSOLE_PREFIX = '/dsh-jingjing';
/** A write must carry this header; a page on another site cannot add it without a CORS preflight, which is never answered. */
export const WRITE_HEADER = 'x-dsh-world';
const MAX_BODY_BYTES = 64 * 1024;
const ok = (body = { ok: true }) => ({ status: 200, body });
const bad = (error) => ({ status: 400, body: { error } });
function persona(body) {
    if (!body)
        return undefined;
    const entries = Object.entries(body);
    if (!entries.every(([key, value]) => PERSONA_LAYERS.includes(key) && typeof value === 'string'))
        return undefined;
    return Object.fromEntries(entries);
}
/** 整段人设文本的入参校验：只要一个 text 字符串。 */
function personaText(body) {
    if (!body || typeof body !== 'object')
        return undefined;
    const text = body.text;
    if (typeof text !== 'string')
        return undefined;
    if (text.length > MAX_BODY_BYTES)
        return undefined;
    return text;
}
async function write(actions, path, body) {
    switch (path) {
        case '/console/start':
            await actions.start();
            return ok();
        case '/console/stop':
            await actions.stop();
            return ok();
        case '/console/persona': {
            // 新版：整段纯文本。带了 text 就走这条。
            if (body && typeof body === 'object' && 'text' in body) {
                const text = personaText(body);
                if (text === undefined)
                    return bad('persona text must be a string');
                actions.savePersonaText(text);
                return ok();
            }
            // 旧版：按层提交，继续兼容（纯文本下只有「全文」一层有意义）
            const layers = persona(body);
            if (!layers)
                return bad('persona layers must be strings');
            actions.savePersona(layers);
            return ok();
        }
        case '/console/budget': {
            const daily = body?.daily;
            if (daily !== null && (typeof daily !== 'number' || !Number.isFinite(daily) || daily < 0))
                return bad('daily must be a non-negative number or null');
            actions.setDailyBudget(daily === null ? undefined : daily);
            return ok();
        }
        case '/console/memory': {
            const turns = body?.turns;
            if (turns !== null && !validTurns(turns))
                return bad('turns must be a whole number of at least 1, or null');
            actions.setMemoryTurns(turns === null ? undefined : turns);
            return ok();
        }
        case '/console/wechat': {
            const context = body?.contextMessages, bufferSeconds = body?.bufferSeconds;
            if (context !== undefined && context !== null && !validWechatContext(context))
                return bad(`contextMessages must be a whole number from 1 to ${MAX_WECHAT_CONTEXT}, or null`);
            if (bufferSeconds !== undefined && bufferSeconds !== null && !validWechatBuffer(bufferSeconds))
                return bad(`bufferSeconds must be a number from 0 to ${MAX_WECHAT_BUFFER_SECONDS}, or null`);
            if (context === undefined && bufferSeconds === undefined)
                return bad('nothing to change');
            actions.setWechatSettings({ ...(context === undefined ? {} : { context }), ...(bufferSeconds === undefined ? {} : { bufferSeconds }) });
            return ok();
        }
        case '/console/modules': {
            const wechat = body?.wechat, qq = body?.qq;
            if ((wechat !== undefined && typeof wechat !== 'boolean') || (qq !== undefined && typeof qq !== 'boolean'))
                return bad('wechat 和 qq 必须是 true 或 false');
            if (wechat === undefined && qq === undefined)
                return bad('nothing to change');
            const refused = await actions.setModules({ ...(wechat === undefined ? {} : { wechat }), ...(qq === undefined ? {} : { qq }) });
            return refused ? bad(refused) : ok();
        }
        case '/console/wechat-adapter': return await actions.restartWechatAdapter() ? ok() : bad('适配器不是由插件管理的，请在配置里写 wechatAdapter');
        case '/console/archive-scope': {
            if (!validArchiveScope(body?.scope))
                return bad('scope must be home or workspace');
            return ok({ ok: true, restartRequired: actions.setArchiveScope(body.scope) });
        }
        case '/console/world-prompt': {
            if (typeof body?.text !== 'string')
                return bad('text must be a string');
            actions.saveWorldPrompt(body.text);
            return ok();
        }
        // 换家：把家切到指定会话
        case '/console/home': {
            const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
            if (sessionId === '')
                return bad('sessionId must be a non-empty string');
            try {
                const id = await actions.switchHome(sessionId);
                return ok({ homeSessionId: id });
            }
            catch (error) {
                return bad(error instanceof Error ? error.message : String(error));
            }
        }
        default: return { status: 404, body: { error: 'not found' } };
    }
}
/** Reads are open to the console page; writes need POST, the write header and a JSON body. */
export async function handleConsole(sources, actions, request) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== CONSOLE_PREFIX && !url.pathname.startsWith(CONSOLE_PREFIX + '/'))
        return { status: 404, body: { error: 'not found' } };
    const path = url.pathname.slice(CONSOLE_PREFIX.length);
    if (request.method === 'POST') {
        if (!request.write)
            return { status: 403, body: { error: 'forbidden' } };
        return write(actions, path, request.body);
    }
    if (request.method !== 'GET')
        return { status: 405, body: { error: 'method not allowed' }, headers: { allow: 'GET, POST' } };
    switch (path) {
        case '/console/snapshot': return ok(await sources.snapshot());
        case '/console/activity': return ok(sources.activity(url.searchParams.get('day') ?? '', url.searchParams.get('outside') === '1'));
        case '/console/diary': {
            const date = url.searchParams.get('date') ?? '';
            const text = sources.diary(date);
            return text === undefined ? { status: 404, body: { error: 'no diary for this date' } } : ok({ date, text });
        }
        case '/console/prompts': return ok(actions.prompts());
        // 换家：列出房间工作区里可以当家的会话
        case '/console/homes': return ok({ homes: await actions.homes() });
        default: return { status: 404, body: { error: 'not found' } };
    }
}
export function consoleRoute(sources, actions, allowedHosts = []) {
    return {
        kind: 'prefix', path: CONSOLE_PREFIX,
        handler: async (req, res) => {
            let result;
            try {
                if (req.headers['sec-fetch-site'] === 'cross-site' || !knownHost(req.headers.host, allowedHosts))
                    result = { status: 403, body: { error: 'cross-site requests are not allowed' } };
                else {
                    const method = req.method ?? 'GET';
                    const write = method === 'POST' && req.headers[WRITE_HEADER] === '1' && String(req.headers['content-type'] ?? '').startsWith('application/json');
                    const body = write ? jsonObject(await readBody(req, MAX_BODY_BYTES)) : undefined;
                    result = write && body === undefined ? bad('a JSON object body is required') : await handleConsole(sources, actions, { method, url: req.url ?? '/', write, body });
                }
            }
            catch {
                result = { status: 500, body: { error: 'internal error' } };
            }
            sendJson(res, result);
        },
    };
}
