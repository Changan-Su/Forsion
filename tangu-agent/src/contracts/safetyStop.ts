/**
 * 被模型的安全审核拦下的回答(借鉴 DeepSeek chat-demo ④,11-17)。
 *
 * 收尾原因归一:Anthropic `stop_reason: refusal`(llm 层原样上传)、OpenAI 兼容 `finish_reason: content_filter`、
 * Responses `incomplete_details.reason: content_filter`(openaiResponses 归一成 content_filter,不再并进 length)。
 *
 * 引擎收到这种收尾:这一发已经流出来的正文 / 思考丢掉、工具调用不执行,终稿换成下面的固定文案(落库的就是这句,
 * 原文哪儿都不存);助手行 origin 记 `refused`,done 带 `refused: true` —— 渲染端据此画一行灰字(照「已停止」),
 * 不给「继续生成」。没带上 origin 的落库路径(云端 worker)重载后显示的就是这句正文,回放进上下文也只有这一句。
 *
 * 放 contracts/:引擎与渲染端共用同一份文案与判定(桌面 i18n 的 chat.refused 与这里逐字一致,单测钉住)。
 */
export const SAFETY_STOP_ORIGIN = 'refused';

export function isSafetyStop(finishReason: string | undefined | null): boolean {
  return finishReason === 'refusal' || finishReason === 'content_filter';
}

export const SAFETY_STOP_NOTICE = {
  zh: '这条回答被模型的安全审核拦下了。',
  en: "This reply was blocked by the model's safety check.",
} as const;

/** 界面语言优先(ui_settings.locale);没有快照时看用户这句话里有没有汉字(同重复工具失败那句的口径)。 */
export function safetyStopNotice(uiLocale: string | undefined, userText: string): string {
  const zh = uiLocale === 'zh' || (uiLocale !== 'en' && /[㐀-鿿]/.test(userText));
  return zh ? SAFETY_STOP_NOTICE.zh : SAFETY_STOP_NOTICE.en;
}
