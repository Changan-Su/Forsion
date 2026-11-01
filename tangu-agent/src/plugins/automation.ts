/** Plugin schedules share the native automation store, scheduler and execution history. */
import { currentRunId } from '../seams/runContext.js';
import { deps } from '../seams/runtime.js';
import { loadTriggers, validateTriggerInput, upsertTrigger, removeTrigger, nextRunAt, type TriggerInput } from '../services/museTriggers.js';
import { kickMuse } from '../services/muse.js';
import { eventSince } from '../services/triggerSources.js';
import { getTriggerSource, parseParams, registerTriggerSource, unregisterTriggerSource, type LocalizedName, type TriggerParam, type TriggerRequirement, type TriggerSource } from '../services/triggerRegistry.js';
import { sendInboxMessage } from '../tools/builtin/inboxSend.js';

/** 插件自己的触发源。`id` 只是 key,宿主拼成 `plugin:<插件 id>:<key>`,碰不到别家的命名空间。 */
export interface PluginTriggerSpec { id: string; name: LocalizedName; params?: TriggerParam[]; requires?: TriggerRequirement[] }

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PARAM_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const OWNER_RE = /^[A-Za-z0-9._-]+$/;
const NAME_CHARS = 60;
const MAX_PARAMS = 8;
const EVENTS_KEPT = 20;
const KICK_DELAY_MS = 2_000;
const PAYLOAD_FIELDS = 20;
const PAYLOAD_VALUE_CHARS = 500;

// ponytail: 事件只在内存里,引擎重启丢掉还没被规则看到的那几条;要补发时再落盘。
const pluginEvents = new Map<string, Array<{ t: number; cells: Record<string, string> }>>();
let kickTimer: ReturnType<typeof setTimeout> | null = null;

const triggerType = (owner: string, key: string): string => `plugin:${owner}:${key}`;

const goodName = (n: LocalizedName | undefined): boolean =>
  [n?.zh, n?.en].every((s) => typeof s === 'string' && !!s.trim() && s.length <= NAME_CHARS && !/[\r\n]/.test(s));

function checkSpec(owner: string, spec: PluginTriggerSpec): void {
  if (!OWNER_RE.test(owner)) throw new Error('Invalid plugin id');
  if (!KEY_RE.test(String(spec?.id))) throw new Error('Trigger id must be lowercase letters, digits and hyphens');
  if (!goodName(spec.name)) throw new Error(`Trigger name needs zh and en, one line of at most ${NAME_CHARS} characters`);
  const params = spec.params ?? [];
  if (!Array.isArray(params) || params.length > MAX_PARAMS) throw new Error(`A trigger takes at most ${MAX_PARAMS} params`);
  for (const p of params) {
    if (!PARAM_KEY_RE.test(String(p?.key))) throw new Error(`Invalid param key: ${p?.key}`);
    if (!['app', 'number', 'text'].includes(p.type)) throw new Error(`Invalid param type: ${p.type}`);
    if (!goodName(p.name)) throw new Error(`Param ${p.key} needs a name in zh and en, one line of at most ${NAME_CHARS} characters`);
  }
  if ((spec.requires ?? []).some((r) => r !== 'computer_history')) throw new Error('Unknown requirement');
}

/** 登记一个插件触发源,返回注销函数。同 key 再登记 = 覆盖(插件重载)。注销后相关规则不动,只暂停(source_missing)。 */
export function registerPluginTrigger(owner: string, spec: PluginTriggerSpec): () => void {
  checkSpec(owner, spec);
  const type = triggerType(owner, spec.id);
  const src: TriggerSource = {
    id: type, group: 'plugin', name: spec.name, params: spec.params ?? [], requires: spec.requires, eventSource: 'plugin', defaultCooldownHours: 1,
    parse: (input) => {
      const p = parseParams(src, input.params);
      return p.ok ? { ok: true, cond: { type: type as `plugin:${string}`, params: p.params } } : p;
    },
    // 规则里填的参数要和事件同名字段相等;事件没带这个字段不比。多条新事件只认最新一条。
    evaluate: async (t, io) => {
      const since = eventSince(t, io);
      const want = Object.entries(t.cond.type === type && 'params' in t.cond ? t.cond.params : {});
      const hit = [...(pluginEvents.get(type) ?? [])].reverse()
        .find((e) => e.t > since && want.every(([k, v]) => !(k in e.cells) || e.cells[k] === String(v)));
      if (hit) io.hit({ row: { id: String(hit.t), cells: hit.cells } });
    },
    summary: () => `plugin event ${spec.id}`, // 进模型:只用校验过形状的 key,显示名是插件写的文本
  };
  registerTriggerSource(src);
  return () => unregisterPluginTrigger(owner, spec.id);
}

export function unregisterPluginTrigger(owner: string, key: string): void {
  const type = triggerType(owner, key);
  unregisterTriggerSource(type);
  pluginEvents.delete(type);
}

/** 记一条事件并叫巡检看一眼(2s 内合并,没有启用的插件规则就不醒)。payload 只留标量,模板里用 `{{row.字段}}`。 */
export function emitPluginTrigger(owner: string, key: string, payload?: unknown): void {
  const type = triggerType(owner, key);
  if (!getTriggerSource(type)) throw new Error(`Trigger "${key}" is not registered`);
  const cells: Record<string, string> = {};
  const fields = payload && typeof payload === 'object' ? Object.entries(payload as Record<string, unknown>) : [];
  for (const [k, v] of fields.slice(0, PAYLOAD_FIELDS)) {
    if (['string', 'number', 'boolean'].includes(typeof v)) cells[k] = String(v).slice(0, PAYLOAD_VALUE_CHARS);
  }
  const list = pluginEvents.get(type) ?? [];
  list.push({ t: Date.now(), cells });
  if (list.length > EVENTS_KEPT) list.shift();
  pluginEvents.set(type, list);
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void loadTriggers().then((rules) => { if (rules.some((t) => t.enabled && t.cond?.type?.startsWith('plugin:'))) kickMuse(); }).catch(() => {});
  }, KICK_DELAY_MS);
  kickTimer.unref?.();
}

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
    registerTrigger(spec: PluginTriggerSpec) {check();return registerPluginTrigger(owner,spec);},
    emit(key: string, payload?: Record<string, unknown>) {check();emitPluginTrigger(owner,key,payload);},
  };
}
