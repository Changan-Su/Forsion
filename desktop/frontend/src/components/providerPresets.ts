/**
 * 设置 → 模型 → 提供方「添加连接」的预设:选一家就填好地址与协议,只剩 key。
 * 清单对齐 server 后台模型管理的 PROVIDER_PRESETS(server/microserver/core-models/admin/panel.js),另加 OpenCode Zen / Go。
 * baseUrl 的 host 要能命中引擎能力表(tangu-agent/src/llm/modelCapabilities.ts)的规则,否则思考参数只走 prefix 兜底;
 * providerPresets.test.ts 钉住这条。拉模型一律 GET {baseUrl}/models(Anthropic 由引擎按协议换头、翻页)。
 * OpenCode Go 是 API key 订阅(opencode.ai/console 复制 key),不是浏览器登录,所以在这里、不在订阅登录(OAUTH_PROVIDERS)里。
 * 它必需的 x-opencode-session / User-Agent 由引擎按 host 自动加(tangu-agent/src/llm/opencodeGo.ts)。
 * base 取 /inference/go/v1:文档按协议给的 /inference/go/openai/v1 没有 /models(404),而本表约定拉模型一律
 * GET {baseUrl}/models;/inference/go/v1 下 /models(文档列出的目录端点)与 /chat/completions 都在(11-05 探针)。
 */
import { registerMessages } from '../i18n'
import type { DirectProviderConfig } from '../types'

registerMessages({
  'prov.preset': { zh: '服务商', en: 'Provider' },
  'prov.presetHint': { zh: '选一家就填好地址和协议，只剩 API Key', en: 'Fills in the address and protocol; you only add the API key' },
  'prov.preset.custom': { zh: '自定义', en: 'Custom' },
  'prov.preset.bailian': { zh: '阿里云百炼', en: 'Alibaba Cloud Bailian' },
  'prov.preset.siliconflow': { zh: '硅基流动', en: 'SiliconFlow' },
  'prov.preset.moonshot': { zh: '月之暗面 Kimi', en: 'Moonshot Kimi' },
  'prov.preset.zhipu': { zh: '智谱', en: 'Zhipu' },
  'prov.protocol': { zh: '协议', en: 'Protocol' },
  'prov.protocolHint': { zh: '大多数服务用 OpenAI 兼容；Anthropic 官方与 Claude 中转用 Anthropic Messages', en: 'Most services are OpenAI-compatible; Anthropic and Claude relays use Anthropic Messages' },
  'prov.protocol.openai': { zh: 'OpenAI 兼容', en: 'OpenAI-compatible' },
  'prov.protocol.anthropic-messages': { zh: 'Anthropic 原生（Messages）', en: 'Anthropic Messages' },
  'prov.baseUrlHintAnthropic': { zh: 'Anthropic Messages 端点，如 https://api.anthropic.com/v1', en: 'Anthropic Messages endpoint, e.g. https://api.anthropic.com/v1' },
})

export interface ProviderPreset {
  /** 也是新连接的缺省名称(= 模型前缀)。 */
  id: string
  /** 品牌名两种语言同写;没有就用 i18n 的 prov.preset.<id>(百炼、硅基流动这类有中文名的)。 */
  name?: string
  baseUrl: string
  protocol: 'openai' | 'anthropic-messages'
  /** 去哪拿 Key(首启引导填 Key 的表上那一行链接;11-06 逐个打开核过,要登录的会先落到登录页)。 */
  keyUrl?: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic-messages', keyUrl: 'https://platform.claude.com/settings/keys' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'bailian', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai', keyUrl: 'https://bailian.console.aliyun.com/' },
  { id: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', protocol: 'openai', keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', protocol: 'openai', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai', keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', protocol: 'openai', keyUrl: 'https://console.x.ai/' },
  { id: 'opencode', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', protocol: 'openai', keyUrl: 'https://opencode.ai/console' },
  { id: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/inference/go/v1', protocol: 'openai', keyUrl: 'https://opencode.ai/console' },
]

/** 预设 id 已被占用(同名保存会覆盖那条)时顺延成 id-2、id-3…… */
export function presetProviderId(id: string, existing: DirectProviderConfig[]): string {
  const taken = new Set(existing.map((p) => p.providerId))
  if (!taken.has(id)) return id
  let n = 2
  while (taken.has(`${id}-${n}`)) n++
  return `${id}-${n}`
}
