/**
 * DeepSeek Harness(DSH)外部引擎定义。
 *
 * 走 DSH 官方的对话入口 `dsh --profile acp`(标准 ACP v1 over stdio,只用公开协议)。用的是用户自己装的 DSH 和它
 * 自己的目录($DSH_HOME,缺省 ~/.dsh):登录、模型目录、会话都是用户那一份 —— 在 DSH 里聊过的这里接得上,这里聊的
 * 也会出现在 DSH 自己的历史里。本引擎只检测、不托管运行时:不装包、不落配置文件。
 *
 * 这个入口和别的 ACP 适配器不一样的三处(都由 acpEngine 按握手里报的能力处理,不按引擎 id 特判):
 *   - 续接走 `session/resume`(不回放历史),没有 `session/load`;
 *   - 模型和思考档在 `configOptions` 里,用 `session/set_config_option` 改,没有 `models` / `session/set_model`;
 *   - 审批请求(`session/request_permission`)只带 toolCallId,标题和参数在它前面那条 `tool_call` 更新里。
 *
 * 只用 DeepSeek 账号登录(没有 API key)的 DSH,新会话的缺省模型走的是要 API key 的那条线:不选模型,每一句都失败
 * (`no API key for provider route "deepseek-official"`);在模型下拉里选了账号那一组的模型就通。公开协议里没有
 * 「哪条线有凭据」这一项,所以这里不替用户换模型,只把失败原因换成一句点名当前模型、说得出能换成哪些的话
 * (acpEngine.modelNoApiKeyError;实测 scripts/dsh-engine.check.mjs 的 nokey)。
 *
 * 历史:早先在 ~/.tangu/engines/dsh 里种一份 cordis 组合去跑 `@deepseek-ai/dsh-acp-demo`,那个包上游已删。
 * 那个目录不再读写(留着无害,用户可自行删除)。
 */
import type { EngineDef } from './config.js';

/** DSH 自己的目录:$DSH_HOME 优先,缺省 ~/.dsh。存在 = 这台机器上跑过 DSH。 */
function dshHomeHint(): string {
  return process.env.DSH_HOME || '~/.dsh';
}

/**
 * DSH 引擎定义。按调用时求值($DSH_HOME 可能变)。
 * detect.requireBin:别的内置引擎经 npx 拉适配器,有配置目录就能跑;DSH 跑的是 `dsh` 这个命令本身,
 * 目录在、命令不在(卸了 / 只用过桌面版)时必须报「未安装」,不能报成可用再在 spawn 时失败。
 * models / commands 不静态声明 → 走懒探测,模型和思考档从 configOptions 里读。
 */
export function dshEngineDef(): EngineDef {
  return {
    id: 'dsh',
    name: 'DeepSeek Harness',
    command: 'dsh',
    args: ['--profile', 'acp'],
    detect: { bin: 'dsh', requireBin: true, dirs: [dshHomeHint()], env: ['DEEPSEEK_API_KEY'] },
    setup: 'npm i -g @deepseek-ai/dsh',
  };
}
