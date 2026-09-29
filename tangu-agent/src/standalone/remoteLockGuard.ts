/**
 * 远程锁定的引擎侧纵深防御(设备能力 MCP 方案 P1 · K2 §3.4):锁定时,带远程来源头(x-forsion-remote)的非只读请求一律 423,
 * 只放 GET / HEAD / OPTIONS 与「中止 run」。与桌面 unitWeb 的顶层闸同口径 —— unitWeb 之外哪天再多出一个入口也挡得住。
 * 只有 standalone 用(桌面 / TUI 的本机引擎);放在 standalone/ 而不是 routes/:路由表生成器按目录扫路由文件,
 * 这里没有 Router(),不该被当成路由文件。
 */
import type { NextFunction, Request, Response } from 'express';
import { parseRemoteOrigin } from '../services/remoteOrigin.js';
import { remoteLocked, remoteLockedBody } from '../services/remoteLock.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ABORT_PATH = /^\/agent\/runs\/[^/]+\/abort\/?$/i;

export function remoteLockGuard(req: Request, res: Response, next: NextFunction): void {
  if (!parseRemoteOrigin(req.headers as Record<string, string | string[] | undefined>)) return next();
  if (READ_METHODS.has(String(req.method || 'GET').toUpperCase())) return next();
  if (ABORT_PATH.test(req.path || '')) return next();
  let locked = true;
  try { locked = remoteLocked(); } catch { locked = true; } // 读不出 = 锁定(fail closed)
  if (!locked) return next();
  res.status(423).json(remoteLockedBody);
}
