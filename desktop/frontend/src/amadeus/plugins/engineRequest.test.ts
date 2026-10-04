import {describe,it,expect} from 'vitest';
import {pluginRequestPath} from './engineRequest';
describe('plugin engine request scope',()=>{
  it('only routes to a declared bundled engine',()=>{
    expect(pluginRequestPath('bundle','engine','/tasks',['engine'])).toBe('/extensions/bundle/engine/tasks');
    expect(()=>pluginRequestPath('bundle','foreign','/tasks',['engine'])).toThrow();
  });
  it.each(['/../agent/runs','/%2e%2e/agent/runs','//agent/runs','/tasks?x=1','/tasks#x','https://example.com','/a\\b'])('rejects path escape %s',p=>{
    expect(()=>pluginRequestPath('bundle','engine',p,['engine'])).toThrow();
  });
});
