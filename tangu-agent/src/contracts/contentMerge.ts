/** Pure content merge policies; the caller supplies its diff3 implementation. */
export function mergeText3With(ours:string,base:string,theirs:string,diff3:(a:string[],b:string[],c:string[],options:{excludeFalseConflicts:boolean})=>Array<{ok?:string[];conflict?:unknown}>):string|null{
  const regions=diff3(ours.split('\n'),base.split('\n'),theirs.split('\n'),{excludeFalseConflicts:true}),out:string[]=[];
  for(const region of regions){if(region.conflict)return null;if(region.ok)out.push(...region.ok)}
  return out.join('\n');
}

/** 把一天的日志正文切成 { header, blocks }:header=首个 `### ` 之前(`# date` 头),blocks=各 `### …` 条目块。 */
export function splitLogBlocks(content: string): { header: string; blocks: string[] } {
  if (!content) return { header: '', blocks: [] };
  const idx = content.indexOf('### ');
  if (idx === -1) return { header: content, blocks: [] };
  const header = content.slice(0, idx);
  const rest = content.slice(idx);
  // 按行首的 `### ` 切分(保留分隔标记)
  const blocks = rest.split(/\n(?=### )/).map((b) => b.replace(/\s+$/, '')).filter(Boolean);
  return { header, blocks };
}

/** 从块里取 time + body(heading 之后的全部行,含 `@deviceId` 前缀)。 */
export function parseBlock(block: string): { time: string; body: string } {
  const nl = block.indexOf('\n');
  const heading = nl === -1 ? block : block.slice(0, nl);
  const body = nl === -1 ? '' : block.slice(nl + 1);
  const m = /^###\s+(\d{2}:\d{2})/.exec(heading);
  return { time: m ? m[1] : '00:00', body };
}

/** 合并日志块:union + 按归一化块串去重,按 time 升序。 */
export function mergeBlocks(a: string[], b: string[]): { merged: string[]; onlyInA: string[]; onlyInB: string[] } {
  const norm = (s: string): string => s.replace(/\s+$/, '');
  const setB = new Set(b.map(norm));
  const setA = new Set(a.map(norm));
  const onlyInA = a.filter((x) => !setB.has(norm(x)));
  const onlyInB = b.filter((x) => !setA.has(norm(x)));
  const all = [...a];
  for (const x of onlyInB) all.push(x);
  // 去重 + 按 time 排序(稳定:同 time 保持插入序)
  const seen = new Set<string>();
  const dedup = all.filter((x) => { const k = norm(x); if (seen.has(k)) return false; seen.add(k); return true; });
  dedup.sort((x, y) => parseBlock(x).time.localeCompare(parseBlock(y).time));
  return { merged: dedup, onlyInA, onlyInB };
}

/** 合并日志页眉(首个 `### ` 之前的部分):按行并集,和块一样只增不减。行按去掉首尾空白后的文本比,空行不算。
 *  header 以云端那份为底、本地独有的行接在后面 —— 各设备因此收敛到同一份文本;云端没有新行时原样保留本地页眉。 */
export function mergeLogHeaders(local: string, remote: string): { header: string; localAdds: boolean; remoteAdds: boolean } {
  const lines = (s: string): string[] => s.split('\n').filter((l) => l.trim());
  const localKeys = new Set(lines(local).map((l) => l.trim()));
  const remoteKeys = new Set(lines(remote).map((l) => l.trim()));
  const localOnly = lines(local).filter((l) => !remoteKeys.has(l.trim()));
  const remoteAdds = [...remoteKeys].some((k) => !localKeys.has(k));
  if (!remoteAdds) return { header: local, localAdds: localOnly.length > 0, remoteAdds };
  return { header: localOnly.length ? `${remote.trimEnd()}\n${localOnly.map((l) => l.trimEnd()).join('\n')}\n` : remote, localAdds: localOnly.length > 0, remoteAdds };
}
