package com.forsion.tangu;

/**
 * 身份条目的存储口(P1-K8)。实现 {@link PrefsUnitStore}:SharedPreferences `forsion_unit` + Keystore AES-GCM 包裹
 * (AAD = 条目键,把密文钉在所属账号上)。JVM 单测注入内存实现。
 */
interface UnitStore {
    /** 条目明文;不存在 → null;解不开(备份恢复到新机、OEM 丢钥、被挪到别的键)→ 抛,调用方删掉按「未登记」处理。 */
    String get(String key) throws Exception;

    void put(String key, String plaintext) throws Exception;

    void remove(String key);
}
