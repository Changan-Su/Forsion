package com.forsion.tangu;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * AndroidKeyStore 包裹(P1-K8,规格 K8 §3.2):别名 `forsion_unit_v1`,AES-256-GCM/NoPadding,不要求用户认证
 * (P2 设备通道要在首次解锁后于后台用)。密文 = base64(iv(12) || ciphertext+tag),AAD = 条目键 ——
 * 把密文钉在所属账号的键上,挪到别的键下解不开。
 * 不引入 androidx.security:security-crypto(已弃用)。钥匙不随备份走:恢复到新机 / OEM 丢钥 → 解不开 → 调用方按未登记处理。
 */
final class KeystoreBox {
    private KeystoreBox() {}

    static final String ALIAS = "forsion_unit_v1";
    private static final String STORE = "AndroidKeyStore";
    private static final int IV_LEN = 12;
    private static final int TAG_BITS = 128;

    private static synchronized SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance(STORE);
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            KeyStore.Entry e = ks.getEntry(ALIAS, null);
            if (e instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) e).getSecretKey();
            ks.deleteEntry(ALIAS);
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
        kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build());
        return kg.generateKey();
    }

    static String seal(String plaintext, String aad) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        c.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
        byte[] iv = c.getIV();
        byte[] ct = c.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        if (iv == null || iv.length != IV_LEN) throw new IllegalStateException("unexpected GCM iv length");
        byte[] out = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(ct, 0, out, iv.length, ct.length);
        return Base64.encodeToString(out, Base64.NO_WRAP);
    }

    static String open(String sealed, String aad) throws Exception {
        byte[] all = Base64.decode(sealed, Base64.NO_WRAP);
        if (all.length <= IV_LEN) throw new IllegalArgumentException("sealed value too short");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, all, 0, IV_LEN));
        c.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
        return new String(c.doFinal(all, IV_LEN, all.length - IV_LEN), StandardCharsets.UTF_8);
    }
}
