/**
 * 发往模型的请求体序列化:把落单的代理项(半个 emoji / 半个增补平面字符)换成 U+FFFD。
 *
 * 为什么:按 UTF-16 码元截断文本(搜索摘录、压缩的机械折叠、各处 slice)会把一个代理对切开。
 * JSON.stringify 把落单代理项写成 `\ud83d` 转义,严格的上游(DeepSeek:`lone leading surrogate
 * in hex escape`)整包拒收;坏文本一旦进了会话历史,该会话之后每一轮都 400。截断点修不完,
 * 所以在出口兜住。
 *
 * 用 replacer 而不是对序列化结果做正则:正文里合法的字面量 `\ud83d` 会被序列化成 `\\ud83d`,
 * 对结果串替换要处理反斜杠奇偶。
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export const wellFormed = (s: string): string => s.replace(LONE_SURROGATE, '�');

export const stringifyWellFormed = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (typeof v === 'string' ? wellFormed(v) : v));
