import type { StandaloneConfig } from './config.js';
import { loadProviders } from './assemble.js';
import { loadMcpConfig } from '../mcp/config.js';
import { loadEngines, loadEnginePrefs } from '../engines/config.js';
import { loadSpecialAgentsConfig } from '../services/specialAgentsConfig.js';
import { configFile } from '../core/tanguHome.js';
import { redactDiagnosticUrl } from '../core/util/diagnosticUrl.js';
/** --print-config:打印生效配置(config.json + env 叠加),token/apiKey 脱敏(仅留尾 4 位)。 */
function maskSecret(s?: string): string {
  if (!s) return '';
  return s.length <= 8 ? '***' : `***${s.slice(-4)}`;
}
export function printEffectiveConfig(cfg: StandaloneConfig): void {
  const providers = loadProviders(cfg).map((p) => ({
    providerId: p.providerId, baseUrl: redactDiagnosticUrl(p.baseUrl), apiKey: maskSecret(p.apiKey),
    modelIds: p.modelIds, imageModelIds: p.imageModelIds, ttsModelIds: p.ttsModelIds, protocol: p.protocol,
  }));
  const mcp = Object.entries(loadMcpConfig().mcpServers).map(([name, s]: [string, any]) => ({
    name, transport: s.transport || (s.command ? 'stdio' : 'http'), enabled: s.enabled !== false,
  }));
  const special = loadSpecialAgentsConfig();
  const out = {
    configFile: configFile(),
    cloud: { url: redactDiagnosticUrl(cfg.cloudUrl), token: maskSecret(cfg.token), defaultModel: cfg.defaultModelId || '' },
    database: { url: redactDiagnosticUrl(cfg.databaseUrl), dataDir: cfg.dataDir },
    server: { port: cfg.port, host: cfg.host, userId: cfg.userId },
    sandbox: cfg.sandbox,
    providers,
    mcp,
    engines: loadEngines().map((e) => ({ id: e.id, name: e.name, command: e.command })),
    enginePrefs: loadEnginePrefs(),
    specialAgents: {
      historian: { enabled: special.historian.enabled, modelId: special.historian.modelId },
      muse: { enabled: special.muse.enabled, modelId: special.muse.modelId },
    },
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
