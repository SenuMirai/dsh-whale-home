import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { durableWrite } from "../../life/lifeStore.js";
import { errorText, Faults } from "../../faults.js";
import { realTimers } from "../../life/alarmTimer.js";
import { busyText, pushOf } from "../shared/outlets.js";
export const REPLY_TIMEOUT_MS = 3 * 60_000;
/** The words could not be handed to her home; the route answers 503. */
export class HomeUnavailable extends Error {
}
const labels = (name) => ({ reply: `${name}的回复`, busy: `「${name}在忙」`, reach: `${name}找你的话` });
/**
 * A local app's way into her home: its words arrive as her partner's own (source `user`), and the first
 * visible text she says after they are admitted goes to the outlets. Only the latest words are tracked.
 */
export function createBridge(deps) {
    const { ctx } = deps;
    const name = deps.name ?? 'TA';
    const clock = deps.clock ?? (() => new Date());
    const timers = deps.timers ?? realTimers;
    const faults = new Faults();
    const disposers = [];
    const token = randomBytes(32).toString('hex');
    let tracked;
    let stopped = false;
    function send(push) {
        for (const outlet of deps.outlets) {
            if (!outlet.kinds.includes(push.kind))
                continue;
            const key = `push:${outlet.name}`;
            void outlet.send(push).then(() => faults.clear(key), error => {
                if (stopped)
                    return;
                faults.set(key, `${outlet.name}没收到${labels(name)[push.kind]}：${errorText(error)}`);
                ctx.logger.warn(`dsh-world: the push to ${outlet.name} failed:`, error);
            });
        }
    }
    function untrack() {
        if (tracked?.timer !== undefined)
            timers.clear(tracked.timer);
        tracked = undefined;
    }
    function track(id, sessionId) {
        untrack();
        const entry = { id, sessionId, admitted: false };
        // The reply stays tracked after "busy": it is still pushed when it comes.
        entry.timer = timers.set(() => { entry.timer = undefined; if (tracked === entry && !stopped)
            send({ text: busyText(name), kind: 'busy', name }); }, REPLY_TIMEOUT_MS);
        tracked = entry;
    }
    function start() {
        disposers.push(ctx.on('session/event', (session, event) => {
            if (!tracked || session.id !== tracked.sessionId)
                return;
            if (event.type === 'user/message' && event.data.id === tracked.id) {
                tracked.admitted = true;
                return;
            }
            if (event.type !== 'assistant/message' || !tracked.admitted)
                return;
            const visible = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
            const reply = pushOf(visible, 'reply', name, safeOrigin());
            if (!reply.text && !reply.images)
                return;
            untrack();
            send(reply);
        }));
        try {
            durableWrite(deps.file, JSON.stringify({ origin: deps.origin(), token, pid: process.pid, startedAt: clock().toISOString(), name }, null, 2));
            faults.clear('file');
        }
        catch (error) {
            faults.set('file', `bridge.json 没能写入，外面的程序找不到家：${errorText(error)}`);
            ctx.logger.error(error);
        }
    }
    function safeOrigin() { try {
        return deps.origin();
    }
    catch {
        return undefined;
    } }
    function stop() {
        if (stopped)
            return;
        stopped = true;
        untrack();
        for (const dispose of disposers.splice(0).reverse())
            dispose();
        // A newer start (a reload) may already have written its own token; that file is not ours to remove.
        try {
            if (JSON.parse(readFileSync(deps.file, 'utf8')).token === token)
                rmSync(deps.file, { force: true });
        }
        catch { /* gone or unreadable */ }
    }
    function checkToken(value) {
        if (typeof value !== 'string')
            return false;
        const given = Buffer.from(value);
        const expected = Buffer.from(token);
        return given.length === expected.length && timingSafeEqual(given, expected);
    }
    async function say(text, images = []) {
        if (stopped)
            throw new HomeUnavailable('the bridge is stopped');
        let agent;
        try {
            agent = await deps.home();
        }
        catch (error) {
            faults.set('home', `从外面送来的话没进家：${errorText(error)}`);
            ctx.logger.error(error);
            throw new HomeUnavailable(errorText(error), { cause: error });
        }
        if (stopped)
            throw new HomeUnavailable('the bridge is stopped');
        const content = [{ type: 'text', text }];
        if (images.length > 0) {
            const attachments = ctx.get?.('attachments')
                ?? ctx.attachments;
            const service = attachments;
            if (service !== undefined && typeof service.saveImages === 'function') {
                const refs = await service.saveImages(images.slice(0, 4));
                for (const ref of refs)
                    content.push({ type: 'image', attachment: ref });
            }
        }
        const words = createUserMessage({ source: { kind: 'user' }, content: content });
        // Tracked first: steering can admit the words before it returns.
        track(words.id, agent.id);
        try {
            // Like her partner typing in the home: into the running turn at its next step, or a new turn.
            if (agent.status === 'running')
                agent.steer(words);
            else
                agent.followup(words);
        }
        catch (error) {
            untrack();
            faults.set('home', `从外面送来的话没进家：${errorText(error)}`);
            ctx.logger.error(error);
            throw new HomeUnavailable(errorText(error), { cause: error });
        }
        faults.clear('home');
        return { id: words.id };
    }
    return { start, stop, say, checkToken, faults: () => faults.list() };
}
