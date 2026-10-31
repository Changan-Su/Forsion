/**
 * plugin-api/tangu-agent.d.ts(公开契约正典)与核心真类型的双向兼容断言。纯类型层,零运行时产物;
 * 随 `tsc --noEmit` 跑——正典或真类型任一侧漂移,这里立刻编译错误。
 *   核心 → 公开:插件拿到的 ctx/sdk 必须满足它编译所依赖的公开形状。
 *   公开 → 核心:插件产出的 TanguPlugin/ToolProvider/PluginMeta 必须被核心接受。
 */
import type * as Pub from '../../plugin-api/tangu-agent.js';
import type { TanguPluginContext, TanguPlugin, TanguSdk } from './types.js';
import type { PluginMeta } from './registry.js';
import type { ToolProvider, ToolDef } from '../tools/toolRegistry.js';
import type { ToolContext } from '../tools/toolTypes.js';
import type { AppProfile } from '../seams/appProfile.js';
import type { PluginChannelSpec } from '../channels/types.js';

type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

// 核心 → 公开(插件消费面)
type _CtxOk = Assert<Extends<TanguPluginContext, Pub.TanguPluginContext>>;
type _SdkOk = Assert<Extends<TanguSdk, Pub.TanguSdk>>;
type _ToolCtxOk = Assert<Extends<ToolContext, Pub.ToolContext>>;
type _ProfileOk = Assert<Extends<AppProfile, Pub.AppProfile>>;

// 公开 → 核心(插件产出面)
type _PluginOk = Assert<Extends<Pub.TanguPlugin, TanguPlugin>>;
type _ProviderOk = Assert<Extends<Pub.ToolProvider, ToolProvider>>;
type _MetaOk = Assert<Extends<Pub.PluginMeta, PluginMeta>>;
type _ToolDefOk = Assert<Extends<Pub.ToolDef, ToolDef>>;
type _ChannelOk = Assert<Extends<Pub.PluginChannelSpec, PluginChannelSpec>>;

export {};
