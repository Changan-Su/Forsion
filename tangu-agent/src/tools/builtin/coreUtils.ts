/**
 * 零依赖纯函数工具:get_datetime / calculator(execute 体从 registry.ts 原样搬移)。
 * 拆成两个 provider 以保持原 TOOLS 字面量的字段顺序(get_datetime 在 memoryLog 组之前、
 * calculator 在其之后)——喂给 LLM 的 defs 顺序必须字节级一致。
 */
import type { ToolProvider } from '../toolRegistry.js';

export const datetimeProvider: ToolProvider = {
  id: 'builtin:datetime',
  tools: () => [
    {
      name: 'get_datetime',
      definition: {
        type: 'function',
        function: {
          name: 'get_datetime',
          description: 'Get the current date and time (server timezone).',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      execute: () => {
        const now = new Date();
        return JSON.stringify({ iso: now.toISOString(), local: now.toString() });
      },
    },
  ],
};

export const calculatorProvider: ToolProvider = {
  id: 'builtin:calculator',
  tools: () => [
    {
      name: 'calculator',
      definition: {
        type: 'function',
        function: {
          name: 'calculator',
          description: 'Evaluate an arithmetic expression, supporting + - * / % ( ) and decimals.',
          parameters: {
            type: 'object',
            properties: { expression: { type: 'string', description: 'Arithmetic expression, e.g. (3+4)*2' } },
            required: ['expression'],
          },
        },
      },
      execute: (args) => {
        const expr = String(args.expression ?? '');
        // 只允许数字、运算符、括号、空白、小数点与指数记号，杜绝代码注入。
        if (!/^[0-9+\-*/%(). \t eE]+$/.test(expr)) {
          return 'Error: expression contains invalid characters';
        }
        try {
          // eslint-disable-next-line no-new-func
          const val = Function(`"use strict"; return (${expr});`)();
          return String(val);
        } catch (e: any) {
          return `Error: ${e?.message || 'invalid expression'}`;
        }
      },
    },
  ],
};
