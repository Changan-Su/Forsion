package com.forsion.tangu;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Locale;

/**
 * 本机作为 Unit(kind='phone')的身份(P1-K8,规格 K8 §3.2)—— 纯数据 + 纯函数,JVM 单测。
 *
 * - deviceSecret(登记时 hub 下发的 unit secret)与 callerSecret(换调用方票用)**只住原生**:
 *   Keystore 包裹后落 SharedPreferences `forsion_unit`(PrefsUnitStore),永不过 Capacitor 桥、永不进日志。
 * - 按 (apiBase, userId) 分账号存:键 = `acct.` + hex(sha256(apiBase + "|" + userId))。换号 = 换键,A 的凭据绝不用于 B。
 * - 名字只作显示,不作信任(信任 = unit id + 执行设备本机首次确认)。
 */
final class UnitIdentity {
    final String unitId;
    final String deviceSecret;
    final String callerSecret;
    final String name;
    final long createdAt;

    UnitIdentity(String unitId, String deviceSecret, String callerSecret, String name, long createdAt) {
        this.unitId = unitId;
        this.deviceSecret = deviceSecret;
        this.callerSecret = callerSecret;
        this.name = name;
        this.createdAt = createdAt;
    }

    UnitIdentity withCallerSecret(String next) {
        return new UnitIdentity(unitId, deviceSecret, next, name, createdAt);
    }

    String toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("v", 1);
            o.put("unitId", unitId);
            o.put("deviceSecret", deviceSecret);
            o.put("callerSecret", callerSecret);
            o.put("name", name == null ? "" : name);
            o.put("createdAt", createdAt);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        return o.toString();
    }

    /** 坏值 / 版本不对 / 缺字段 → null(调用方按「未登记」处理并删掉条目)。 */
    static UnitIdentity fromJson(String s) {
        if (s == null) return null;
        try {
            JSONObject o = new JSONObject(s);
            if (o.optInt("v", 0) != 1) return null;
            String unitId = o.optString("unitId", "");
            String dev = o.optString("deviceSecret", "");
            String caller = o.optString("callerSecret", "");
            if (!RelayPaths.isUnitId(unitId) || dev.isEmpty() || caller.isEmpty()) return null;
            return new UnitIdentity(unitId, dev, caller, o.optString("name", ""), o.optLong("createdAt", 0));
        } catch (Exception e) {
            return null;
        }
    }

    /** 条目键:按 (apiBase, userId) 分账号。 */
    static String entryKey(String apiBase, String userId) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] h = md.digest((apiBase + "|" + userId).getBytes(StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder("acct.");
            for (byte x : h) b.append(String.format(Locale.ROOT, "%02x", x));
            return b.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * forsion_token(JWT)payload 里的 `userId`(server src/middleware/auth.ts 的签发口径)。**不验签** —— 只用来选条目,
     * 选错了 hub 会拒。不是三段式 / 解不开 / 没有 userId → null(调用方按「未登录」处理)。
     */
    static String userIdFromJwt(String token) {
        if (token == null) return null;
        String[] parts = token.split("\\.");
        if (parts.length != 3 || parts[1].isEmpty()) return null;
        try {
            String p = parts[1].replace('-', '+').replace('_', '/');
            while (p.length() % 4 != 0) p += "=";
            JSONObject o = new JSONObject(new String(Base64.getDecoder().decode(p), StandardCharsets.UTF_8));
            Object v = o.opt("userId");
            if (v == null || v == JSONObject.NULL) return null;
            String id = String.valueOf(v).trim();
            return id.isEmpty() ? null : id;
        } catch (Exception e) {
            return null;
        }
    }
}
