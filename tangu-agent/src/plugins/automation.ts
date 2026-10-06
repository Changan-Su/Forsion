/** Plugin schedules share the native automation store, scheduler and execution history. */
import { currentRunId } from '../seams/runContext.js';
import { deps } from '../seams/runtime.js';
import { loadTriggers, validateTriggerInput, upsertTrigger, removeTrigger, nextRunAt, type TriggerInput } from '../services/museTriggers.js';
import { sendInboxMessage } from '../tools/builtin/inboxSend.js';
export function createPluginAutomation(owner: string, alive: () => boolean, tools: () => string[]) {
  const prefix = `plugin:${owner}:`;
  const check = (write = false) => { if (!alive() || !deps().profile.capabilities.hostExec || (write && currentRunId())) throw new Error('Schedule changes require the local user interface'); };
  const idOf = (key: string) => { if (!/^[a-z0-9][a-z0-9-]{0,150}$/.test(key)) throw new Error('Invalid schedule key');return prefix+key; };
  return {
    async list() {check();return (await loadTriggers()).filter(t=>t.id.startsWith(prefix)).map(t=>({...t,nextRunAt:nextRunAt(t)}));},
    async save(key: string, input: {description: string; type: 'at'|'every'|'daily_at'; datetime?: string; interval?: string; time?: string; tool: string; args: Record<string,unknown>; enabled: boolean}) {
      check(true);if(!tools().includes(input.tool))throw new Error('The scheduled tool must belong to this plugin and declare automationSafe');
      const validated=validateTriggerInput({desc:input.description,cond_type:input.type,datetime:input.datetime,interval:input.interval,time:input.time,enabled:input.enabled,cooldown_hours:0,actions:[{type:'tool_call',tool:input.tool,args:input.args}]} as TriggerInput,{allowToolCall:true});
      if(!validated.ok)throw new Error(validated.error);
      const result=await upsertTrigger(validated.value,idOf(key),{allowPluginCreate:true,actor:'user'});
      if(!result.ok)throw new Error(result.error);return result.trigger;
    },
    // Revoking an owned schedule must also work from a native-approved task Stop tool.
    async remove(key: string) {check();return removeTrigger(idOf(key));},
    async notify(userId: string, title: string, body: string) {
      check();return sendInboxMessage(userId,{title,body,senderId:`plugin:${owner}`,forward:false});
    },
  };
}
