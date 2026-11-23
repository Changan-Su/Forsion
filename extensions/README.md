# Forsion Health · 健康

Install the signed `forsion-health` directory with its original name in the local Forsion plugins folder, then rescan. Open Health, connect Mi Fitness, complete authorization in the browser and enter its confirmation code in the Space. The backend requires the wellness Microserver and an approved Xiaomi application. Enable agent access to use `read_health_summary` with a Tangu engine that supports this bundle.

将已签名的 `forsion-health` 目录放入本地 Forsion 插件目录后重新扫描。打开健康 Space，连接小米运动健康，在浏览器授权后回到 Space 输入确认码。新设备需用同一小米账号授权一次。打开 Agent 读取开关，即可查询指定日期结束的七天摘要。需要支持此插件的 Tangu 引擎和已配置小米凭据的健康微后端。

Maintainers sign changes with `node extensions/sign-health.mjs /path/to/health-signing-key.pem`. The matching public key is pinned in the engine.
