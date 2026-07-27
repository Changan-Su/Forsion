/**
 * Slash 命令目录接口 —— Desktop 输入框据此渲染 `/` 菜单。
 *   GET /agent/commands  → { builtin: CommandSpec[], custom: [...] , dir }
 *
 * builtin 来自 core/commandCatalog(与 TUI 同一张表);custom 是用户放在 ~/.tangu/commands/*.md 的
 * 自定义命令。custom 是本地特性(读用户家目录),云端 hostExec=false 时只回 builtin。
 *
 * 展开(把 $ARGUMENTS 填进正文)也放服务端:两端各写一份正则迟早不一致。
 *   POST /agent/commands/:name/expand { args } → { text }
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { commandsFor } from '../core/commandCatalog.js';
import { listCustomCommands, getCustomCommand, expandCustomCommand, commandsDir } from '../services/customCommands.js';

const router = Router();

const localOnly = (): boolean => !!deps().profile.capabilities.hostExec;

router.get('/agent/commands', authMiddleware, async (_req: AuthRequest, res) => {
  const custom = localOnly()
    ? listCustomCommands().map((c) => ({ name: c.name, description: c.description, argHint: c.argHint }))
    : [];
  res.json({ builtin: commandsFor('desktop'), custom, dir: localOnly() ? commandsDir() : null });
});

router.post('/agent/commands/:name/expand', authMiddleware, async (req: AuthRequest, res) => {
  if (!localOnly()) {
    res.status(404).json({ detail: '自定义命令仅在本地（桌面/TUI）可用' });
    return;
  }
  const cmd = getCustomCommand(String(req.params.name || ''));
  if (!cmd) {
    res.status(404).json({ detail: '未找到该自定义命令' });
    return;
  }
  res.json({ text: expandCustomCommand(cmd, String(req.body?.args ?? '')) });
});

export default router;
