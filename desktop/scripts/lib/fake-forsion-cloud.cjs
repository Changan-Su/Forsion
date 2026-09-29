/**
 * 假 Forsion 云端（台架专用）：按 server 路由的真实响应形状回罐头数据，有状态（用卡、兑换、工单、昵称），
 * 并记下每个请求（method + path + 是否带 token）。给「Forsion 云端」里 Extend 画的个人中心五页拍已登录态的真实截图、
 * 做交互断言用 —— 不连真云端、不碰真账号。
 *
 * 形状出处（改 server 时一起核）：server/src/services/tokenQuotaService.ts getUserQuota、routes/tokenQuota.ts、
 * routes/membership.ts、routes/credits.ts、routes/invite.ts、routes/usage.ts、routes/feedback.ts + services/feedbackService.ts、
 * microserver/brain-api/routes.ts（/brain/users/me，桌面 authStatus 的 whoami）、routes/auth.ts（/auth/me、send-code、password…）。
 * 用法：const cloud = await startFakeForsionCloud({ scenario: 'both' }); … cloud.url / cloud.requests / cloud.close()
 */
const http = require('http')

async function startFakeForsionCloud(opts = {}) {
  const scenario = opts.scenario || 'both' // 'both' 手机+邮箱 | 'email-only' | 'none'
  const LIMIT = { daily: 1000, weekly: 5000 }
  const state = {
    cards: 2,
    used: { daily: 880, weekly: 3000 },
    bg: { daily: 120, weekly: 200, autoMain: false },
    nickname: '演示用户',
    avatar: null,
    autoDeduct: false,
    tickets: [
      { id: 't1', user_id: 'u1', title: null, description: '笔记同步后图片丢了，重新打开才出现。', status: 'in_progress', user_unread: true, admin_unread: false, created_at: '2026-09-26T08:00:00Z', updated_at: '2026-09-27T10:00:00Z' },
      { id: 't2', user_id: 'u1', title: null, description: '希望 Muse 能按项目分开记忆。', status: 'resolved', user_unread: false, admin_unread: false, created_at: '2026-09-20T08:00:00Z', updated_at: '2026-09-21T09:00:00Z' },
    ],
    replies: { t1: [{ id: 'r1', ticket_id: 't1', author_id: 'admin', author_role: 'admin', content: '收到，已复现，下个版本修复。', created_at: '2026-09-27T10:00:00Z' }], t2: [] },
  }
  const requests = []
  const bgLimit = (limit) => Math.round(limit * 0.15)
  const quota = () => {
    const d = bgLimit(LIMIT.daily), w = bgLimit(LIMIT.weekly)
    return {
      dailyLimit: LIMIT.daily, dailyUsed: state.used.daily, dailyRemaining: Math.max(LIMIT.daily - state.used.daily, 0), dailyPercent: Math.round(state.used.daily / LIMIT.daily * 100),
      weeklyLimit: LIMIT.weekly, weeklyUsed: state.used.weekly, weeklyRemaining: Math.max(LIMIT.weekly - state.used.weekly, 0), weeklyPercent: Math.round(state.used.weekly / LIMIT.weekly * 100),
      weeklyResetAt: '2026-10-05', monthlyLimit: -1, monthlyUsed: 0, monthlyRemaining: -1, monthlyPercent: 0,
      extraTokenPoints: 0, tier: 'plus', hasOverride: false, pointsAutoDeduct: state.autoDeduct,
      background: {
        sharePercent: 15, modelId: 'glm-bg', autoMain: state.bg.autoMain,
        dailyLimit: d, dailyUsed: state.bg.daily, dailyRemaining: Math.max(d - state.bg.daily, 0), dailyPercent: Math.round(state.bg.daily / d * 100),
        weeklyLimit: w, weeklyUsed: state.bg.weekly, weeklyRemaining: Math.max(w - state.bg.weekly, 0), weeklyPercent: Math.round(state.bg.weekly / w * 100),
      },
      exchangeRate: 1, resetCardPricePoints: 100, resetCards: state.cards,
    }
  }
  const user = () => ({
    id: 'u1', username: 'demo_user', role: 'USER', nickname: state.nickname, avatar: state.avatar,
    email: scenario === 'none' ? null : 'demo.user@example.com', emailVerified: scenario !== 'none',
    phone: scenario === 'both' ? '13812345678' : null, phoneVerified: scenario === 'both',
  })
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const p = url.pathname
      const authed = /^Bearer \S+/.test(req.headers.authorization || '')
      requests.push({ method: req.method, path: p, authed })
      let body = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { /* 非 JSON */ }
      const needAuth = p.startsWith('/api/') && !['/api/features', '/api/auth/region'].includes(p)
      if (needAuth && !authed) return send(res, 401, { detail: 'Not authenticated' })

      // 账号身份
      if (p === '/api/brain/users/me') return send(res, 200, { ...user(), membershipTier: 'plus' })
      if (p === '/api/auth/me') return send(res, 200, user())
      if (p === '/api/auth/refresh') return send(res, 404, { detail: 'Not found' }) // 续期缺席 = Extend 什么都不做
      if (p === '/api/features') return send(res, 200, { payment: true, redemption_codes: true, shop: true, cloud_storage: true, invite_codes: true })
      if (p === '/api/settings' && req.method === 'PUT') {
        if (typeof body.nickname === 'string') state.nickname = body.nickname
        if (typeof body.avatar === 'string' || body.avatar === null) state.avatar = body.avatar
        return send(res, 200, { success: true })
      }
      if (p === '/api/settings') return send(res, 200, { nickname: state.nickname, avatar: state.avatar })
      if (p === '/api/membership/my') return send(res, 200, { membership: { status: 'active', tier: 'plus', plan: { name: 'Plus 月付', tier: 'plus' }, startedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-12-31T00:00:00Z' } })

      // 额度与积分
      if (p === '/api/token-quota/my') return send(res, 200, quota())
      if (p === '/api/token-quota/reset-card/use') {
        if (state.cards <= 0) return send(res, 400, { error: 'no_reset_card', detail: '没有可用的重置卡' })
        state.cards -= 1
        state.used = { daily: 0, weekly: 0 }
        return send(res, 200, { success: true, quota: quota(), resetCards: state.cards })
      }
      if (p === '/api/points/exchange-reset-cards') {
        const n = Number(body.count) || 1
        state.cards += n
        return send(res, 200, { success: true, cardsGranted: n, pointsSpent: n * 100, pricePerCard: 100, newPointsBalance: 1234 - n * 100, resetCards: state.cards })
      }
      if (p === '/api/token-quota/auto-deduct') { state.autoDeduct = !!body.enabled; return send(res, 200, { success: true, pointsAutoDeduct: state.autoDeduct }) }
      if (p === '/api/token-quota/background/auto-main') { state.bg.autoMain = !!body.enabled; return send(res, 200, { success: true, autoMain: state.bg.autoMain }) }
      if (p === '/api/token-quota/background/convert') return send(res, 200, { success: true, converted: { daily: 10, weekly: 50 }, quota: quota() })
      if (p === '/api/token-quota/my/logs') return send(res, 200, {
        logs: [
          { createdAt: '2026-09-28T10:00:00Z', modelName: 'GPT X', tokensInput: 12000, tokensOutput: 800, pointsCost: 6, success: true },
          { createdAt: '2026-09-28T09:00:00Z', modelName: 'GLM', tokensInput: 300, tokensOutput: 20, pointsCost: 0.37, success: true },
          { createdAt: '2026-09-28T08:00:00Z', modelName: 'GLM', tokensInput: 30, tokensOutput: 2, pointsCost: 0.0004, success: false },
        ], total: 3, limit: 20, offset: 0,
      })
      if (p === '/api/credits/balance') return send(res, 200, { balance: 1234 })
      if (p === '/api/invite/my-code') return send(res, 200, { code: 'FS7K2Q', invitedCount: 3, claim: { eligible: true } })
      if (p === '/api/invite/claim') return send(res, 400, { detail: '邀请码无效或已失效', code: 'invalid_invite_code' })
      if (p === '/api/redemption/redeem') return send(res, 400, { detail: '兑换码无效' })
      if (p === '/api/usage/stats') return send(res, 200, {
        totalRequests: 128, totalTokensInput: 820000, totalTokensOutput: 91000, totalPointsCost: 1240, successRate: 98.4,
        byModel: [{ modelId: 'gpt-x', modelName: 'GPT X', count: 90, pointsCost: 1100 }, { modelId: 'glm', modelName: 'GLM', count: 38, pointsCost: 0.4 }],
        byProject: [{ projectSource: 'tangu', count: 120, tokens: 900000, pointsCost: 1239.6 }, { projectSource: 'ai-studio', count: 8, tokens: 11000, pointsCost: 0.4 }],
      })

      // 安全
      if (p === '/api/auth/send-code') return send(res, 200, { success: true, message: 'Verification code sent' })
      if (p === '/api/auth/bind-phone' || p === '/api/auth/bind-email') return send(res, 400, { detail: '验证码错误或已过期' })
      if (p === '/api/auth/password' && req.method === 'PUT') {
        if (body.currentPassword !== 'Old-Pass1') return send(res, 401, { detail: 'Current password is incorrect' })
        return send(res, 200, { success: true, message: 'Password updated successfully' })
      }
      if (p === '/api/auth/reset-password') return send(res, body.code === '123456' ? 200 : 400, body.code === '123456' ? { success: true } : { detail: '账号或验证码错误' })
      if (p === '/api/auth/logout' || p === '/api/auth/logout-all') return send(res, 200, { ok: true })
      if (p === '/api/auth/delete-account') return send(res, 400, { detail: '验证码错误或已过期' })

      // 反馈工单
      if (p === '/api/feedback' && req.method === 'GET') return send(res, 200, { tickets: state.tickets })
      if (p === '/api/feedback' && req.method === 'POST') {
        const id = `t${state.tickets.length + 1}`
        const now = new Date('2026-09-28T12:00:00Z').toISOString()
        state.tickets.unshift({ id, user_id: 'u1', title: null, description: String(body.description || ''), status: 'open', user_unread: false, admin_unread: true, created_at: now, updated_at: now })
        state.replies[id] = []
        return send(res, 201, { id, success: true })
      }
      if (p === '/api/feedback/unread-count') return send(res, 200, { count: state.tickets.filter((x) => x.user_unread).length })
      const m = /^\/api\/feedback\/([^/]+)(\/read|\/replies)?$/.exec(p)
      if (m) {
        const t = state.tickets.find((x) => x.id === m[1])
        if (!t) return send(res, 404, { detail: 'Ticket not found' })
        if (m[2] === '/read') { t.user_unread = false; return send(res, 200, { success: true }) }
        if (m[2] === '/replies') {
          state.replies[t.id].push({ id: `r${Date.parse('2026-09-28T12:00:00Z')}`, ticket_id: t.id, author_id: 'u1', author_role: 'user', content: String(body.content || ''), created_at: '2026-09-28T12:00:00Z' })
          return send(res, 201, { success: true })
        }
        return send(res, 200, { ticket: t, replies: state.replies[t.id] || [], attachments: [], viewer: 'user' })
      }
      return send(res, 404, { detail: 'Not found' })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, requests, state, close: () => new Promise((resolve) => server.close(resolve)) }
}

module.exports = { startFakeForsionCloud }
