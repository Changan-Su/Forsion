// marked-terminal@7 自身不带类型（@types/marked-terminal 只覆盖 v6 的旧 API）。
// 这里按 v7 的实际导出补一个最小声明：markedTerminal(options?, highlightOptions?) → marked 扩展。
declare module 'marked-terminal' {
  export function markedTerminal(options?: any, highlightOptions?: any): any;
  const _default: typeof markedTerminal;
  export default _default;
}
