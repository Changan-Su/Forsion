// 伴随包 → 主包的回调(急停)。契约 §9.5。
package com.forsion.tangu.hands;

interface IHandsListener {
    // 药丸「停止」被点 → 伴随包撤租约,并通知主包用自持 token 直接 POST /agent/runs/:runId/abort。
    oneway void onStop();
}
