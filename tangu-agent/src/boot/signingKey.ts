/**
 * 引擎热更新包(npm `@forsion/tangu-agent`)的签名公钥,ed25519。
 *
 * ⚠️ 这把钥匙永不轮换:它编进了每一份已发出去的安装包,换了钥匙,所有已装机器都会拒绝之后的每一个引擎更新。
 * 私钥只在两处:Genesis 仓的 Actions secret `TANGU_ENGINE_SIGNING_KEY`,和维护者本机
 * `~/.forsion-dev/secrets/tangu-engine-signing/key.pem`。
 */
export const ENGINE_SIGNING_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAO18f9nC/LKWH2pvmM99snGnI+FsTQsM/ZI90NXtwkXo=
-----END PUBLIC KEY-----
`;
