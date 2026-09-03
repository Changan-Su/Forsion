/**
 * manage_automation(原 muse_watch)—— 在任意聊天里管理自动化规则:触发条件 × 动作链。
 *
 * 规则落 ~/.tangu/agents/muse/triggers.json,由 supervisor tick 零 token 评估(见 services/museTriggers.ts):
 * 命中 → 动作链(runActions)或旧式 agentSlug 无人值守 run,两者皆无则唤醒 Muse。
 * 可见性:本地限定(hostExec,照 inbox_send);不进 PLAN_MODE_TOOLS(写操作;Muse 自己的 planMode 周期设不了=防自激)。
 * **tool_call 步骤刻意不在本工具开放**(validateTriggerInput allowToolCall=false):
 * 聊天 agent 在 full-auto 下能自建规则,放开=自授权 run_bash 提权链;tool_call 只走桌面构建器(人工预批)。
 * 旧名 muse_watch 在 registry.executeTool 留静默别名(不进 defs/快照,只兜升级瞬间的存量调用)。
 */
import type { ToolProvider } from '../toolRegistry.js';
import {
  loadTriggers,
  removeTrigger,
  validateTriggerInput,
  upsertTrigger,
  condSummary,
  isPluginTriggerId,
  precheckWatchCols,
  MAX_ACTIONS,
  type MuseTrigger,
  type DbLike,
} from '../../services/museTriggers.js';
import { readDbOrNull } from '../../services/amadeusDb.js';
import { dropCursors } from '../../services/dbCursors.js';
import { getAgent } from '../../agents/agentRegistry.js';
import { amadeusVaultPath } from './amadeus.js';

function fmt(t: MuseTrigger): string {
  const act = t.actions?.length
    ? `, actions: ${t.actions.map((a) =>
        a.type === 'tool_call' ? `tool_call(${a.tool})`
        : a.type === 'agent_run' ? `agent_run(${a.agentSlug})`
        : a.type === 'db_row_add' || a.type === 'db_row_edit' ? `${a.type}(${a.path})`
        : 'notify').join(' → ')}`
    : t.agentSlug ? `, runs agent "${t.agentSlug}"` : '';
  const cd = t.cooldownHours ? `, cooldown ${t.cooldownHours}h` : '';
  return `${t.id}${t.enabled ? '' : ' (disabled)'} — ${t.desc} [${condSummary(t.cond)}]${act}${cd}, last fired ${t.lastFiredAt || 'never'}`;
}

export const manageAutomationProvider: ToolProvider = {
  id: 'builtin:manage_automation',
  tools: () => [
    {
      name: 'manage_automation',
      mode: 'both',
      isEnabledFor: (profile) => !!profile.capabilities.hostExec, // 本地限定;云端 no-op
      deferred: true, // P0-2:3.3KB 大 schema,低频管理面 → 按需装载(Muse/自动化 run 例外全量可见)
      deferHint: 'Set up/list/remove automations: reminders ("remind me at 9am"), event watchers, scheduled or recurring agent tasks.',
      definition: {
        type: 'function',
        function: {
          name: 'manage_automation',
          description:
            'Manage automation rules (trigger + actions). Use when the user asks to be reminded at/every some time, ' +
            'or to watch for something ("remind me at 9am tomorrow", "every 2h tell me to stretch", "keep an eye on xxx.md"). ' +
            'Triggers: at (one-time local datetime), every (recurring interval like "30m"/"2h"/"1d"), daily_at (once a day after HH:MM), ' +
            'event_seen (a new in-app activity line contains `match`), file_chars_gte (file reaches n non-whitespace chars), ' +
            'manual (never fires on its own — the user runs it by clicking a button block in a note; use this when asked for "a button that does X"), ' +
            'db_changed (a row was added to, or a column changed in, an Amadeus database file — needs path + event; cell_changed watches one column via column_id or several via column_ids, any of them changing fires). ' +
            'Actions (in order, fail-stop): notify {title, body?} posts to the user inbox with push, zero cost — the right way to deliver timed reminders; ' +
            'agent_run {agentSlug, prompt} runs that agent unattended. Omit actions to instead wake Muse (legacy) or set `agent` as a shorthand for a single agent_run. ' +
            'Rules are evaluated by code every few minutes at zero cost. A one-time (at) rule disables itself after firing.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['set', 'list', 'remove'], description: 'set=add/update a rule, list=show rules, remove=delete by id' },
              id: { type: 'string', description: 'set: update this rule instead of creating; remove: rule id (from list)' },
              desc: { type: 'string', description: 'set: human-readable description of the rule (shown to the user)' },
              cond_type: { type: 'string', enum: ['at', 'every', 'daily_at', 'event_seen', 'file_chars_gte', 'manual', 'db_changed'], description: 'set: trigger type' },
              event: { type: 'string', enum: ['row_added', 'cell_changed'], description: 'set(db_changed): which change to watch' },
              column_id: { type: 'string', description: 'set(db_changed + cell_changed): the column ID (NOT its name — names are neither unique nor stable). Read the .db JSON to find it.' },
              column_ids: { type: 'array', items: { type: 'string' }, description: 'set(db_changed + cell_changed): watch several columns at once (column IDs; the rule fires when ANY of them changes; max 10). May be combined with column_id — the union is watched. Prefer this over creating one rule per column.' },
              equals: { type: 'string', description: 'set(db_changed + cell_changed): only fire when the cell becomes exactly this value (omit = any change)' },
              where: {
                type: 'array',
                description: 'set(db_changed): extra AND conditions on the matched row, compared as strings after computed columns (lookup/formula) are resolved. Max 10.',
                items: {
                  type: 'object',
                  properties: {
                    column: { type: 'string', description: 'column ID or name' },
                    op: { type: 'string', enum: ['eq', 'ne', 'empty', 'notempty'] },
                    value: { type: 'string', description: 'for eq/ne' },
                  },
                  required: ['column', 'op'],
                },
              },
              datetime: { type: 'string', description: 'set(at): one-time local datetime "YYYY-MM-DD HH:mm"' },
              interval: { type: 'string', description: 'set(every): interval like "30m"/"2h"/"1d" (min 15m; min 1h when any agent runs)' },
              time: { type: 'string', description: 'set(daily_at): local time "HH:MM"' },
              match: { type: 'string', description: 'set(event_seen): substring to look for in new activity lines (e.g. a file name, "note.edit", "run.done agent=historian", or a plugin event like "plugin:activitywatch:focus")' },
              path: { type: 'string', description: 'set(file_chars_gte): file path (absolute, or relative to the current workspace). set(db_changed): vault-relative .db path, e.g. "Tasks.db"' },
              n: { type: 'number', description: 'set(file_chars_gte): non-whitespace character threshold' },
              actions: {
                type: 'array',
                description:
                  `set: ordered action steps. Max ${MAX_ACTIONS}. Each item is one of: ` +
                  '{type:"notify", title, body?} — inbox message; ' +
                  '{type:"agent_run", agentSlug, prompt} — run that agent unattended; ' +
                  '{type:"db_row_add", path, cells, skipIfEmpty?} — append a row to an Amadeus database (skipIfEmpty = a cells key; the step is skipped when that value expands to empty); ' +
                  '{type:"db_row_edit", path, cells, rowId? | rowFrom? | match?} — update rows: rowId = one row; rowFrom = a relation column of the trigger row (each linked row is edited, available as {{target.X}}); match = {column, value} edits every row whose column equals value (value may be a template like {{row.id}}); none = the row the trigger matched. ' +
                  'cells maps a column ID (or name) to a value. Values may use {{row.<column>}} / {{target.<column>}} / {{now}} / {{today}} templates and arithmetic {{= {target.qty} - {row.qty} }} (formula syntax, column refs in single braces); ' +
                  'templates are ONLY expanded in notify text and db cell values — never in prompts, paths or tool arguments. ' +
                  'Computed columns (lookup/formula) of the trigger row are resolved before templating.',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['notify', 'agent_run', 'db_row_add', 'db_row_edit'] },
                    title: { type: 'string', description: 'notify: inbox message title' },
                    body: { type: 'string', description: 'notify: optional message body' },
                    agentSlug: { type: 'string', description: 'agent_run: agent to run unattended' },
                    prompt: { type: 'string', description: 'agent_run: task prompt for the agent' },
                    path: { type: 'string', description: 'db_row_add/db_row_edit: vault-relative .db path' },
                    rowId: { type: 'string', description: 'db_row_edit: target row id (omit = the row the trigger matched)' },
                    rowFrom: { type: 'string', description: 'db_row_edit: relation column (ID or name) of the trigger row; edits the linked row(s) in the target table' },
                    match: { type: 'object', description: 'db_row_edit: {column, value} — edit every row of the target table whose column equals value (template allowed)', properties: { column: { type: 'string' }, value: { type: 'string' } }, required: ['column', 'value'] },
                    skipIfEmpty: { type: 'string', description: 'db_row_add: a cells key; skip this step when that value expands to empty' },
                    cells: { type: 'object', description: 'db_row_add/db_row_edit: column ID (or name) → value' },
                  },
                  required: ['type'],
                },
              },
              prompt: { type: 'string', description: 'set(legacy, no actions): extra instruction for the runner when the rule fires' },
              cooldown_hours: { type: 'number', description: 'set: hours before the rule may fire again (default 24; min 1 with agent runs, min 0.25 for pure notify chains; db_changed rules with only notify/db actions default to 0 and allow 0 — they fire per row; ignored for timed triggers at/every/daily_at)' },
              agent: { type: 'string', description: 'set(legacy shorthand, no actions): agent slug to run the prompt unattended when the rule fires (omit = wake Muse)' },
            },
            required: ['action'],
          },
        },
      },
      execute: async (args, ctx) => {
        const action = String(args.action || '');
        if (action === 'list') {
          const list = await loadTriggers();
          return list.length ? `${list.length} automation rule(s):\n${list.map(fmt).join('\n')}` : '(no automation rules)';
        }
        if (action === 'remove') {
          const id = String(args.id || '').trim();
          if (!id) return 'Error: id 必填(先 list 查看)';
          if (isPluginTriggerId(id)) return `Error: 规则 ${id} 由插件管理,请在插件设置里禁用`;
          const gone = await removeTrigger(id);
          // L13(2026-09-02):派生游标随规则一起走 —— HTTP DELETE 一直这么做,这条路从前漏了。
          // 兜底的 pruneCursors 被 tick 起始的「名册里还有 db 规则吗」门控:删掉最后一条 db 规则后 prune
          // 再也不跑 → 孤儿游标永久留在 db-cursors.json 里(文件长胖;id 复用时读端自证兜住误触发)。
          if (gone) await dropCursors([id]).catch(() => {});
          return gone ? `已删除规则 ${id}。` : `Error: 未找到规则 ${id}`;
        }
        if (action !== 'set') return 'Error: action 须为 set/list/remove';

        // 工具参数名是 agent(对模型友好),校验层键是 agent_slug——这里显式映射(修 muse_watch 时代静默掉落的 bug)。
        const v = validateTriggerInput({ ...args, agent_slug: args.agent_slug ?? args.agent } as any, { cwd: ctx.cwd, vaultPath: amadeusVaultPath() });
        if (!v.ok) return `Error: ${v.error}`;
        if (v.value.agentSlug && !(await getAgent(v.value.agentSlug))) {
          return `Error: agent "${v.value.agentSlug}" 不存在(先用 manage_agent 查看可用 agent)`;
        }
        for (const a of v.value.actions || []) {
          if (a.type === 'agent_run' && !(await getAgent(a.agentSlug))) {
            return `Error: agent "${a.agentSlug}" 不存在(先用 manage_agent 查看可用 agent)`;
          }
        }
        const id = String(args.id || '').trim() || undefined;
        // 插件种子规则(plugin:<插件id>:<key>)归插件的 ensure 管:聊天 agent 不能改也不能借它的 id 凭空建(伪插件规则绕 50 条帽)。
        if (id && isPluginTriggerId(id)) return `Error: 规则 ${id} 由插件管理,不能经本工具修改`;
        // 监听列必须是落盘列:公式/引用/投影列的值不落盘,游标恒空 → 规则一次都不触发、零日志、面板正常。
        // 桌面构建器早就把它们过滤掉了,引擎侧从前没有对等闸(这条工具能建出这种「永远不响」的规则)。
        // ⚠️ H2 同款闸(与 HTTP 路由对齐):只在新建 / cond 实质变化 / 本次要置为 enabled:true 时体检。
        // set 是**整量** upsert,agent 要「把这条规则关掉」也走这里 —— 关规则永远不许被预检挡住。
        const prev = id ? (await loadTriggers()).find((x) => x.id === id) : undefined;
        if (!prev || JSON.stringify(prev.cond) !== JSON.stringify(v.value.cond) || (v.value.enabled && !prev.enabled)) {
          const badCol = await precheckWatchCols(v.value.cond, (rel) => readDbOrNull(rel) as Promise<DbLike | null>, amadeusVaultPath());
          if (badCol) return `Error: ${badCol}`;
        }
        // actor='user':agent 经本工具的启停是**显式**操作(与面板同档),不是插件 ensure 那种幂等重放。
        const r = await upsertTrigger(v.value, id, { actor: 'user' });
        if (!r.ok) return `Error: ${r.error}`;
        const c = v.value.cond;
        const note = c.type === 'manual'
          ? '(不会自动触发;在笔记里插入按钮块并选中这条规则,由用户点击执行)'
          : v.value.actions?.length
          ? '(supervisor 巡检约每 5 分钟评估一次,命中即按动作链执行)'
          : v.value.agentSlug
            ? `(命中后由 agent "${v.value.agentSlug}" 全自动执行;巡检约每 5 分钟评估一次)`
            : c.type === 'daily_at'
              ? '(每天过点后的首次巡检触发;若设了 Muse 运行时段,时段外会顺延补发)'
              : '(Muse 巡检周期约每 5 分钟评估一次;需 Muse 已在设置中启用)';
        return `${r.created ? '已设定' : '已更新'}自动化 ${r.trigger.id}:「${v.value.desc}」[${condSummary(c)}]${note}`;
      },
    },
  ],
};
