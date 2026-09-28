/**
 * 会话工作区上传 → host 模式 run 的附件引用(P1 · M1A,K9 KNOWN-GAP「host 模式的模型看得到手机发来的附件」)。
 *
 * 桌面本机的附件怎么到 host 模式的模型:输入区「已选择」芯片 = 正文**第一行**的路径 token(fileChip:裸绝对路径,含空白则加引号,
 * 单空格连),气泡用 splitLeadingRefs 还原成芯片,模型看到的就是这行绝对路径。手机(以及桌面原生选择器读成工作区附件的小文件、
 * 右栏上传)没有本机路径可给:文件经 POST /agent/workspace/upload 落进引擎的会话沙箱目录(AGENT_SANDBOX_SESSION_DIR/<hash>/),
 * 而 host 模式工具的 cwd 是工作区、提示词里也没有那个目录 —— 模型根本不知道有附件。
 *
 * 这里补上同一条路:上传路由(本地会话目录那一支)登记写入的绝对路径;下一条**来自输入区**的 host 模式 run(input.origin==='client')
 * 起跑时取走,按 fileChip 的格式拼成正文第一行再落库 —— 模型、气泡、之后每一轮的历史回放看到的都是同一行。
 * 不给 run 任何新权限:host 模式的读本来就不限根(只硬拒凭据,契约 C4);往会话目录**写**仍是「工作区外」要审批;
 * 上传 / 下载 / 列目录照旧经 confinedFs 钳在会话目录里(K10a);远程 run 不因此多出可写根(C8)。
 *
 * 进程内表:上传与起 run 是同一个客户端紧挨着的两次请求(appStore.send 先 upload 再 startRun / steer)。引擎重启丢了也只是退回
 * 旧行为(模型看不到附件)。sandbox 模式的 run 也会取走(提示词已让它 list_files),免得会话日后切到 host 时把旧上传当新附件报。
 */

const MAX_SESSIONS = 256;
/** 一条消息最多列多少个路径 token;超出的只报个数(一次拖进几十个文件时,第一行不该长成一屏)。 */
export const MAX_UPLOAD_REFS = 20;

const pending = new Map<string, string[]>();

/** 上传路由:本地会话目录里写成功的一个文件(绝对路径,按根的真实路径)。 */
export function noteWorkspaceUpload(sessionId: string, absPath: string): void {
  if (!sessionId || !absPath) return;
  const list = pending.get(sessionId) ?? [];
  const i = list.indexOf(absPath);
  if (i >= 0) list.splice(i, 1); // 同名重传:挪到末尾,不重复列
  list.push(absPath);
  pending.delete(sessionId);
  pending.set(sessionId, list); // Map 按插入序:最近上传的会话在末尾
  while (pending.size > MAX_SESSIONS) pending.delete(pending.keys().next().value as string);
}

/** 取走某会话尚未报给模型的上传(取完即清)。 */
export function takeWorkspaceUploads(sessionId: string): string[] {
  const list = pending.get(sessionId);
  if (!list) return [];
  pending.delete(sessionId);
  return list;
}

/** 只给测试:清空进程内表。 */
export function _resetWorkspaceUploads(): void {
  pending.clear();
}

// 引号 / 控制符 / 行分隔:fileChip token 装不下(会把第一行拆坏);这类路径改在正文末尾单列一行 JSON 串。
const UNSAFE_TOKEN = /["\u0000-\u001f\u007f\u2028\u2029]/;

/**
 * 把上传路径拼成正文第一行(与桌面 fileChip 同一格式,气泡还原成文件芯片)。没有上传 → 原样返回。
 * 格式:`<token> <token>…\n<原正文>`;token = 裸路径,含空白则 `"路径"`。装不进 token 的路径与超出 MAX_UPLOAD_REFS 的个数放在末尾。
 */
export function withUploadRefs(message: string, paths: string[]): string {
  if (!paths.length) return message;
  const shown = paths.slice(-MAX_UPLOAD_REFS); // 多了留最近的
  const extra = paths.length - shown.length;
  const tokens: string[] = [];
  const odd: string[] = [];
  for (const p of shown) {
    if (UNSAFE_TOKEN.test(p)) odd.push(p);
    else tokens.push(/\s/.test(p) ? `"${p}"` : p);
  }
  const tail = [
    ...(odd.length ? [`Attached files: ${odd.map((p) => JSON.stringify(p)).join(', ')}`] : []),
    ...(extra > 0 ? [`(${extra} more attached file${extra === 1 ? '' : 's'} in the same folder)`] : []),
  ].join('\n');
  let out = tokens.length ? `${tokens.join(' ')}\n${message}` : message;
  if (tail) out = out.trim() ? `${out.replace(/\s+$/, '')}\n\n${tail}` : tail;
  return out;
}
