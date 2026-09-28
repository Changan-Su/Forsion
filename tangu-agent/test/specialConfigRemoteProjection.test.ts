/**
 * 设备能力方案 P1 · K10b(INTEGRATION §4 G3):`GET /agent/special/config` 对远程来源只回最小投影。
 * 真 express + 真 special 路由;配置落在临时 TANGU_HOME 的 config.json(经 saveSpecialAgentsConfig 写,与桌面保存同一条路)。
 *
 * 这条路由远端是 allow(渲染层的鉴权探针 AUTH_PROBE_PATH 就是它),P0 起远端可以整份读走 Historian / Muse 配置:
 * 自定义提示词、Muse 授权文件夹(本机绝对路径)、权限档、心跳 / 运行时段、预算、升级对象、模型……
 * (投影只管这一条:Muse 的权限档 / 心跳 / 次数预算另经 GET /agent/special/muse/status、人格经 GET /agent/agents 对远端可读,不在本测试范围。)
 * 投影只留**渲染层远端调用点真用得到的**四个字段,逐个对到调用点:
 *   historian.enabled / muse.enabled —— appStore.refreshSpecialEnabled(手机焦点在「我的电脑」时点亮 Historian / Muse 入口);
 *   historian.everyRounds / muse.supervisorPollMinutes —— 设备页自动化 Space 详情卡的「触发」一栏(AutomationDetailView)。
 * 鉴权探针只看状态码;设备页的设置页(SpecialAgentsTab)见 remote:true 改显示「只能在那台电脑上设置」+ 开关状态。
 * 本机请求(没有 x-forsion-remote)照旧拿整份配置 + 默认提示词;云端(hostExec=false)分支不动(historianCloudMemory.test 钉)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import specialRouter from '../src/routes/special.js';
import { saveSpecialAgentsConfig, DEFAULT_HISTORIAN_PROMPT } from '../src/services/specialAgentsConfig.js';

let srv: Server;
let base: string;
let home: string;
const prevHome = process.env.TANGU_HOME;

// 哨兵:任何一个出现在远端回包里 = 投影漏了
const SECRET_PROMPT = 'K10B-SECRET-HISTORIAN-PROMPT';
const SECRET_FOLDER = '/Users/k10b-probe/Documents/private-finance';
const SECRET_MODEL = 'k10b-secret-model';
const SECRET_ESCALATE = 'k10b-escalation-agent';

const get = async (headers: Record<string, string> = {}): Promise<{ status: number; body: any; raw: string }> => {
  const r = await fetch(`${base}/agent/special/config`, { headers: { Authorization: 'Bearer x', ...headers } });
  const raw = await r.text();
  let body: any = null;
  try { body = JSON.parse(raw); } catch { /* keep raw */ }
  return { status: r.status, body, raw };
};

const PROJECTION = {
  config: { historian: { enabled: true, everyRounds: 7 }, muse: { enabled: true, supervisorPollMinutes: 11 } },
  remote: true,
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-k10b-special-')); // 目录名不是 tangu → 共享域 = home 自身,config.json 落在这里
  process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  saveSpecialAgentsConfig({
    historian: { enabled: true, modelId: SECRET_MODEL, everyRounds: 7, firstRoundTrigger: false, mode: 'fork', prompt: SECRET_PROMPT, harnessCandidates: false },
    muse: {
      enabled: true, modelId: SECRET_MODEL, supervisorPollMinutes: 11, allowedFolders: [SECRET_FOLDER], mode: 'auto',
      heartbeatMinutes: 45, activeHours: { start: 8, end: 19 }, notify: 'digest', escalateTo: SECRET_ESCALATE, maxTokensPerWindow: 424242,
    },
  });
  const app = express(); app.use(express.json()); app.use(specialRouter);
  srv = app.listen(0); base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(async () => {
  await new Promise((r) => srv.close(r));
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('GET /agent/special/config · 本机', () => {
  it('没有远程来源头:整份配置 + 默认提示词(桌面设置页照旧可编辑)', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body.remote).toBeUndefined();
    expect(r.body.config.historian.prompt).toBe(SECRET_PROMPT);
    expect(r.body.config.historian.mode).toBe('fork');
    expect(r.body.config.muse.allowedFolders).toEqual([SECRET_FOLDER]);
    expect(r.body.config.muse.escalateTo).toBe(SECRET_ESCALATE);
    expect(r.body.config.muse.mode).toBe('auto');
    expect(r.body.defaults.historianPrompt).toBe(DEFAULT_HISTORIAN_PROMPT);
  });
});

describe('GET /agent/special/config · 远程来源只回最小投影', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['隧道(手机经 hub)', { 'x-forsion-remote': 'tunnel' }],
    ['局域网配对', { 'x-forsion-remote': 'lan' }],
    ['P2P', { 'x-forsion-remote': 'p2p' }],
    ['头值不在契约内(本机进程自己加的头)仍按远程', { 'x-forsion-remote': 'bogus' }],
    ['头名大小写不同', { 'X-Forsion-Remote': 'TUNNEL' }],
    ['带调用方设备(K1 断言)', {
      'x-forsion-remote': 'tunnel',
      'x-forsion-remote-mark': 'not-the-secret',
      'x-forsion-remote-caller': Buffer.from(JSON.stringify({ u: '11111111-2222-4333-8444-555555555555', k: 'phone', n: 'Pixel' })).toString('base64url'),
    }],
  ];
  for (const [name, headers] of cases) {
    it(name, async () => {
      const r = await get(headers);
      expect(r.status).toBe(200);
      expect(r.body).toEqual(PROJECTION); // 精确相等:多漏一个字段即红
      for (const s of [SECRET_PROMPT, SECRET_FOLDER, SECRET_MODEL, SECRET_ESCALATE, DEFAULT_HISTORIAN_PROMPT, '424242', 'digest']) {
        expect(r.raw, s).not.toContain(s);
      }
    });
  }

  it('投影跟随真值:本机关掉 Muse 后远端读到 enabled:false(不是写死的常量)', async () => {
    saveSpecialAgentsConfig({ muse: { enabled: false, supervisorPollMinutes: 3 } });
    try {
      const r = await get({ 'x-forsion-remote': 'tunnel' });
      expect(r.body).toEqual({ ...PROJECTION, config: { ...PROJECTION.config, muse: { enabled: false, supervisorPollMinutes: 3 } } });
    } finally {
      saveSpecialAgentsConfig({ muse: { enabled: true, supervisorPollMinutes: 11 } });
    }
  });
});
