/**
 * 接缝①:AppProfile —— 每个 app/部署一份的装载声明。
 * microserver:{ appId:'ai-studio', sandboxMode:'docker', … }
 * standalone :{ appId:'tangu',     sandboxMode:'docker'|'none'(探测), … }
 */
export interface AppProfile {
  /** 取代硬编码的 'ai-studio'(会话/沙箱/资产作用域)。 */
  appId: string;
  defaultModelId?: string;
  /** 代码执行后端:docker 沙箱 / 无(禁 exec 类工具)。 */
  sandboxMode: 'docker' | 'none';
  features: {
    sandbox: boolean;
    webSearch: boolean;
    historian: boolean;
    customTools: boolean;
  };
}
