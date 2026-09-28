package com.forsion.tangu;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 身份条目落盘:SharedPreferences `forsion_unit`(MODE_PRIVATE)+ KeystoreBox 包裹(P1-K8)。
 * 该文件被 backup_rules / data_extraction_rules 排除在备份与设备迁移之外(即便带走,钥匙也不在新机上)。
 * ⚠️ 与 Capacitor Preferences 的 `CapacitorStorage` 分开:那一组 JS 能读写,这一组 JS 碰不到。
 */
final class PrefsUnitStore implements UnitStore {
    static final String PREFS = "forsion_unit";

    private final SharedPreferences prefs;

    PrefsUnitStore(Context ctx) {
        this.prefs = ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @Override
    public String get(String key) throws Exception {
        String sealed = prefs.getString(key, null);
        return sealed == null ? null : KeystoreBox.open(sealed, key);
    }

    @Override
    public void put(String key, String plaintext) throws Exception {
        String sealed = KeystoreBox.seal(plaintext, key);
        if (!prefs.edit().putString(key, sealed).commit()) throw new IllegalStateException("prefs commit failed");
    }

    @Override
    public void remove(String key) {
        prefs.edit().remove(key).commit();
    }
}
