import { errorText } from "../faults.js";
const ALARM_TOOLS = ['plan_next', 'check_alarm', 'cancel_alarm'];
const HOME_TOOLS = ['reach_out'];
/** Disposes in reverse; a disposer whose agent scope is already gone may throw and is skipped. */
function undo(list) {
    for (const dispose of list.splice(0).reverse()) {
        try {
            dispose();
        }
        catch { /* scope already disposed */ }
    }
}
/**
 * The alarm tools are held by every world session (she can set her alarm anywhere; it rings at home);
 * reach_out only by the current home. A registration that fails (a name clash) is a fault and never breaks
 * agent creation; it registers all of a group or none.
 */
export function createToolRegistry(deps) {
    const alarm = new Map();
    const home = new Map();
    function register(agent, tools, names) {
        const done = [];
        try {
            for (const tool of tools)
                if (names.includes(tool.name))
                    done.push(agent.ctx.tools.register(tool));
        }
        catch (error) {
            undo(done);
            throw error;
        }
        return done;
    }
    return {
        attach(agent) {
            const needsAlarm = !alarm.get(agent)?.length, needsHome = deps.isHome(agent) && !home.get(agent)?.length;
            if (!needsAlarm && !needsHome)
                return;
            try {
                const tools = deps.tools();
                if (needsAlarm)
                    alarm.set(agent, register(agent, tools, ALARM_TOOLS));
                if (needsHome)
                    home.set(agent, register(agent, tools, HOME_TOOLS));
                deps.faults.clear(`attach:${agent.id}`);
            }
            catch (error) {
                deps.faults.set(`attach:${agent.id}`, `工具挂载失败：${errorText(error)}`);
                deps.logger.error(error);
            }
        },
        forget(agent) { alarm.delete(agent); home.delete(agent); deps.faults.clear(`attach:${agent.id}`); },
        /** A rebuilt home takes reach_out from the old one. */
        releaseOldHomes() { for (const [agent, list] of home)
            if (!deps.isHome(agent))
                undo(list); },
        clear() {
            for (const list of [...home.values(), ...alarm.values()])
                undo(list);
            home.clear();
            alarm.clear();
        },
    };
}
