/**
 * manage_automation 的工具定义(11-21 去重写短):
 * - 参数结构(属性名 / 类型 / enum / required)不许跟着说明一起变 —— approvals.ts 的控制面分类器按参数口径判批不批;
 *   改参数形状须同步那边,再改这里的指纹。
 * - 说明里的这几条事实校验器不会报错、写错了只会静默出错,写短时不许丢。
 * - 体积上限防回胀:Muse 周期与自动化 run 每次全量带着它。
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { manageAutomationProvider } from '../src/tools/builtin/manageAutomation.js';

const def = manageAutomationProvider.tools()[0].definition;
const strip = (o: unknown): unknown =>
  Array.isArray(o) ? o.map(strip)
  : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'description').map(([k, v]) => [k, strip(v)]))
  : o;
const text = JSON.stringify(def);

describe('manage_automation definition', () => {
  it('keeps the parameter structure (descriptions aside)', () => {
    const fp = createHash('sha256').update(JSON.stringify(strip(def))).digest('hex').slice(0, 16);
    expect(fp).toBe('5499fcca62457445');
  });

  it.each([
    ['templates expand only in notify text and cells', 'ONLY in notify text and db cell values'],
    ['column ID, not name', 'NOT its name'],
    ['remind is skipped outside active hours', 'skipped outside Muse active hours'],
    ['notify is the timed-reminder route', 'the right way to deliver timed reminders'],
    ['at disables itself', 'disables itself after firing'],
    ['manual = button block', 'button block in a note'],
    ['computer.* needs Computer History', 'need Computer History on'],
    ['no actions wakes Muse', 'Without actions the rule wakes Muse'],
    ['only the user turns observing rules on', 'Only the user can turn an observing rule on'],
    ['cooldown defaults', 'default 24'],
  ])('keeps: %s', (_label, phrase) => {
    expect(text).toContain(phrase);
  });

  it('stays under the size budget', () => {
    expect(text.length).toBeLessThanOrEqual(7000);
  });
});
