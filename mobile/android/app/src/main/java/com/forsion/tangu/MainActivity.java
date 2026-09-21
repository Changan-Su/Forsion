package com.forsion.tangu;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // ⚠️ 必须排在 super.onCreate **之前**:BridgeActivity 在 super 里就把桥连同插件表一起装好了,
        //    晚一步注册 JS 侧就 registerPlugin 不到,表现为「调用永远 reject: plugin not implemented」。
        registerPlugin(SpaceShortcutsPlugin.class);
        registerPlugin(LiveIslandPlugin.class);
        // 重建(配置变更 / 进程被杀后从最近任务回来)会重放当初的启动 intent:点岛跳会话只在全新启动时认一次。
        LiveIslandPlugin.freshLaunch = savedInstanceState == null;
        super.onCreate(savedInstanceState);
    }
}
