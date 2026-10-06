import {expect,it,vi} from 'vitest';
import {createTanguProfile} from '../profiles/tangu.js';
const calls=vi.hoisted(()=>({execute:vi.fn(async()=> 'allowed')}));
vi.mock('./customTools.js',()=>({executeCustomTool:calls.execute}));
vi.mock('../core/config.js',()=>({configExists:()=>true,loadRawConfig:()=>({hostSandbox:{mode:'off'}}),getRawSection:()=>undefined}));
vi.mock('../services/userActivity.js',()=>({appendActivityLine:vi.fn()}));
import {executeTool,getToolDefinitions} from './registry.js';
it('strict allowlists gate custom and MCP fallback definitions and execution',async()=>{
  const execute=calls.execute;
  const tool=(name:string)=>({name,definition:{type:'function',function:{name,description:'test',parameters:{type:'object',properties:{}}}},execute});
  const ctx:any={userId:'u',sessionId:'s',appId:'tangu',execMode:'host',profile:createTanguProfile({sandboxMode:'none'}),toolsStrict:true,toolsMode:'allow',toolsList:['custom_yes'],customTools:new Map([['custom_yes',tool('custom_yes')],['custom_no',tool('custom_no')]]),mcpTools:new Map([['mcp_no',tool('mcp_no')]])};
  expect(getToolDefinitions(ctx).map(x=>x.function.name)).toEqual(['custom_yes']);
  for(const name of ['custom_no','mcp_no','execute_command'])expect((await executeTool({id:name,type:'function',function:{name,arguments:'{}'}},ctx)).isError).toBe(true);
  expect(execute).not.toHaveBeenCalled();
  expect((await executeTool({id:'yes',type:'function',function:{name:'custom_yes',arguments:'{}'}},ctx)).isError).toBeFalsy();
  expect(execute).toHaveBeenCalledOnce();
});
