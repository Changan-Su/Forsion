/** Short-lived MCP bridge for an external run. Only its host-approved tool set is exposed. */
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveTools } from '../tools/toolRegistry.js';
import { executeTool } from '../tools/registry.js';
import { gateToolCall } from '../services/approvals.js';
import type { ToolContext } from '../tools/toolTypes.js';
import { deps } from '../seams/runtime.js';
import { enterRunContext } from '../seams/runContext.js';

export async function createRunToolServer(ctx: ToolContext & { runId: string }, names: string[]) {
  const token = randomBytes(32).toString('hex');
  const live = () => !ctx.signal?.aborted;
  const allowed = () => new Map([...resolveTools(deps().profile, ctx)].filter(([n]) => names.includes(n)));
  const open = new Set<Server>();
  const http = createServer(async (req, res) => {
    const got = Buffer.from(String(req.headers.authorization || '')), expected = Buffer.from(`Bearer ${token}`);
    if (!live() || req.method !== 'POST' || req.url !== '/mcp' || got.length !== expected.length || !timingSafeEqual(got, expected)) { res.writeHead(403).end(); return; }
    const server = new Server({ name: 'forsion-task', version: '1.0.0' }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    open.add(server);
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...allowed().values()].map(t => ({name:t.name,description:t.definition.function.description,inputSchema:t.definition.function.parameters})) }));
    server.setRequestHandler(CallToolRequestSchema, async req => {
      if (!live() || !allowed().has(req.params.name)) throw new Error('Tool is unavailable');
      enterRunContext(ctx.userId, ctx.runId);
      const call = { id:randomUUID(),type:'function' as const,function:{name:req.params.name,arguments:JSON.stringify(req.params.arguments||{})} };
      const decision = await gateToolCall(ctx.runId,call,{sessionId:ctx.sessionId,userId:ctx.userId,execMode:'host',cwd:ctx.cwd,approvalMode:ctx.approvalMode,modeSessionId:ctx.sessionId},ctx.signal);
      if (decision.action==='reject') return {isError:true,content:[{type:'text',text:'The user denied this tool call.'}]};
      ctx.signal?.throwIfAborted();
      if (!allowed().has(req.params.name)) throw new Error('Tool is no longer available');
      const approved = decision.argsOverride ? { ...call, function: { ...call.function, arguments: JSON.stringify(decision.argsOverride) } } : call;
      const result = await executeTool(approved,ctx);
      return {isError:!!result.isError,content:[{type:'text',text:String(result.result)}]};
    });
    try {
      let raw='';for await (const b of req) {raw+=b;if(raw.length>1024*1024)throw new Error('Request too large');}
      await server.connect(transport); await transport.handleRequest(req,res,JSON.parse(raw));
    } catch { if(!res.headersSent)res.writeHead(400);res.end(); }
    finally { await server.close();open.delete(server); }
  });
  await new Promise<void>((resolve,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',resolve);});
  const port=(http.address() as {port:number}).port;
  return { server: {type:'http' as const,name:'forsion_task',url:`http://127.0.0.1:${port}/mcp`,headers:[{name:'Authorization',value:`Bearer ${token}`}]} ,
    async close(){await Promise.allSettled([...open].map(s=>s.close()));http.closeAllConnections();await new Promise<void>(r=>http.close(()=>r()));} };
}
