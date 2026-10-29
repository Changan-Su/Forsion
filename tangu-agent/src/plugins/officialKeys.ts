/**
 * 官方捆绑包的签名公钥,按捆绑包 manifest.json 的 id 钉死在引擎里(见 ./official.ts)。
 * 与 desktop/electron/builtinBundles.json 里同一项的 `desktop.signingKey` 是**同一把**:改一边必须改另一边。
 * 这把钥匙永不轮换(Forsion-Extend 仓 scripts/sign.mjs 头注释):换了,所有已装机器上的官方插件都不再被认作官方。
 */
export const OFFICIAL_BUNDLE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'forsion-extend': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAR7HV1LAPMME+MiPnSmpl7GxTiTA1K/DT6xvwIzLdlSI=\n-----END PUBLIC KEY-----\n',
});
