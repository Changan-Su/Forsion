/** 上游反代(openresty/nginx)在超时/不可用时会吐一整页 HTML 错误(504/502/503)。别把这坨 HTML 原样
 *  塞进聊天气泡——转成给用户看的简短中文。非 HTML(如后端 JSON detail)原样返回,空 body 回退英文 sentinel。 */
export function friendlyUpstreamError(status: number, body: string): string {
  const b = (body || '').trim();
  const isHtml = b.startsWith('<') || /<html|<!doctype/i.test(b);
  if (isHtml) {
    if (status === 504) return '网关超时(504):模型这次响应太久,请重试,或换一个更快的模型。';
    if (status === 502 || status === 503) return `网关暂时不可用(${status}),请稍后重试。`;
    return `上游网关返回错误(${status})。`;
  }
  return b || `brain stream ${status}`;
}
