package com.forsion.tangu.localengine;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.math.BigInteger;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Random;

/**
 * The phone's own Ed25519 (no JCA: API 26–32 have none). RFC 8032 §7.1 vectors, cross-checked against the JDK's
 * provider (JDK 15+ on the test JVM only — never on the phone), and the strictness cases.
 */
public class Ed25519Test {
    private static byte[] h(String s) { return EngineSignature.unhex(s); }

    private static final String[][] RFC8032 = {
        {"d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
         "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"},
        {"3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
         "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"},
        {"fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
         "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"},
    };

    @Test public void rfc8032Vectors() throws Exception {
        for (String[] v : RFC8032) {
            assertTrue(Ed25519.verify(h(v[0]), h(v[1]), h(v[2])));
            assertTrue("the JDK agrees the vector is valid", jdkVerify(h(v[0]), h(v[1]), h(v[2])));
        }
    }

    @Test public void agreesWithTheJdkOnRandomKeysAndMessages() throws Exception {
        Random r = new Random(42);
        KeyPairGenerator g = KeyPairGenerator.getInstance("Ed25519");
        for (int i = 0; i < 40; i++) {
            KeyPair kp = g.generateKeyPair();
            byte[] pub = Ed25519.rawFromSpki(kp.getPublic().getEncoded());
            byte[] msg = new byte[r.nextInt(300)];
            r.nextBytes(msg);
            Signature s = Signature.getInstance("Ed25519");
            s.initSign(kp.getPrivate());
            s.update(msg);
            byte[] sig = s.sign();
            assertTrue(Ed25519.verify(pub, msg, sig));
            byte[] bad = sig.clone();
            bad[r.nextInt(64)] ^= (byte) (1 << r.nextInt(8));
            assertEquals(jdkVerify(pub, msg, bad), Ed25519.verify(pub, msg, bad));
            if (msg.length > 0) {
                byte[] m2 = msg.clone();
                m2[0] ^= 1;
                assertFalse(Ed25519.verify(pub, m2, sig));
            }
        }
    }

    @Test public void refusesWhatIsNotASignature() {
        String[] v = RFC8032[1];
        byte[] pub = h(v[0]), msg = h(v[1]), sig = h(v[2]);
        assertFalse(Ed25519.verify(pub, msg, java.util.Arrays.copyOf(sig, 63)));
        assertFalse(Ed25519.verify(java.util.Arrays.copyOf(pub, 31), msg, sig));
        assertFalse(Ed25519.verify(h(RFC8032[0][0]), msg, sig)); // another key
        // S + L: same point, but S must be < L (malleability)
        BigInteger L = BigInteger.ONE.shiftLeft(252).add(new BigInteger("27742317777372353535851937790883648493"));
        byte[] sLe = java.util.Arrays.copyOfRange(sig, 32, 64);
        byte[] be = new byte[33];
        for (int i = 0; i < 32; i++) be[32 - i] = sLe[i];
        byte[] big = new BigInteger(be).add(L).toByteArray();
        byte[] s2 = new byte[32];
        for (int i = 0; i < 32 && i < big.length; i++) s2[i] = big[big.length - 1 - i];
        byte[] mall = sig.clone();
        System.arraycopy(s2, 0, mall, 32, 32);
        assertFalse(Ed25519.verify(pub, msg, mall));
        // y ≥ p in the key
        byte[] badPub = new byte[32];
        java.util.Arrays.fill(badPub, (byte) 0xff);
        badPub[31] = 0x7f;
        assertFalse(Ed25519.verify(badPub, msg, sig));
    }

    @Test public void spkiPrefix() throws Exception {
        KeyPair kp = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
        byte[] raw = Ed25519.rawFromSpki(kp.getPublic().getEncoded());
        assertEquals(32, raw.length);
        assertNull(Ed25519.rawFromSpki(new byte[44]));
        assertArrayEquals(raw, Ed25519.rawFromSpki(kp.getPublic().getEncoded()));
    }

    static boolean jdkVerify(byte[] raw, byte[] msg, byte[] sig) throws Exception {
        byte[] prefix = {0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00};
        byte[] der = new byte[44];
        System.arraycopy(prefix, 0, der, 0, 12);
        System.arraycopy(raw, 0, der, 12, 32);
        java.security.PublicKey k = java.security.KeyFactory.getInstance("Ed25519").generatePublic(new java.security.spec.X509EncodedKeySpec(der));
        Signature s = Signature.getInstance("Ed25519");
        s.initVerify(k);
        s.update(msg);
        try { return s.verify(sig); } catch (java.security.SignatureException e) { return false; }
    }
}
