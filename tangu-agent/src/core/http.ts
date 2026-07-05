/**
 * HTTP 垫片:鉴权中间件 + AuthRequest 类型,收敛到注入的 host。
 * 中间件用 lazy 包装(把 deps() 推迟到请求时),故路由可在装配前的 import 期就构造。
 */
import type { Request, RequestHandler } from 'express';
import { deps } from '../seams/runtime.js';

/** 与 Forsion AuthRequest 同构:core 只读 req.user.userId(其余字段透传)。 */
export interface AuthRequest extends Request {
  user?: { userId: string; username?: string; role?: string; [k: string]: any };
}

/** 用户鉴权中间件(lazy → deps().host.authMiddleware)。 */
export const authMiddleware: RequestHandler = (req, res, next) =>
  deps().host.authMiddleware(req, res, next);

/** 管理员鉴权中间件(lazy → deps().host.adminMiddleware)。 */
export const adminMiddleware: RequestHandler = (req, res, next) =>
  deps().host.adminMiddleware(req, res, next);
