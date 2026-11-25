// Fixture boundary around the installed provider. Only the entry points and targets of this
// experiment are exposed. Forward production results and preserve exactly the delivered image.
import plugin from './provider.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.TANGU_PIXEL_HARNESS_DIR;
const allowed = new Map();
export default {
  ...plugin,
  activate(ctx) {
    return plugin.activate({
      ...ctx,
      registerPlugin(meta) {
        if (!meta.toolProvider) return ctx.registerPlugin(meta);
        const provider = meta.toolProvider;
        return ctx.registerPlugin({
          ...meta,
          toolProvider: {
            ...provider,
            tools: () =>
              provider.tools().map((t) => ({
                ...t,
                execute: async (args, tcx) => {
                  const rules = JSON.parse(readFileSync(join(dir, 'pixel-target.json'), 'utf8'));
                  if (tcx.sessionId !== rules.sessionId) throw Error('Unknown test session.');
                  const state = allowed.get(tcx.sessionId) ?? {};
                  const matches =
                    (t.name === 'launch_browser' &&
                      rules.url &&
                      args.url === rules.url &&
                      args.mode === 'pixels' &&
                      !args.visible &&
                      !state.root) ||
                    (t.name === 'find_roots' && rules.pid && args.pid === rules.pid) ||
                    (t.name === 'observe_ui' &&
                      state.root &&
                      args.root === state.root &&
                      (rules.url || args.mode === 'pixels')) ||
                    (t.name === 'act_ui' &&
                      state.id &&
                      args.stateId === state.id &&
                      !args.expect &&
                      args.actions.every(
                        (a) =>
                          !a.ref &&
                          (rules.pid
                            ? a.action === 'click'
                            : ['click', 'moveMouse', 'scroll', 'drag', 'keypress'].includes(a.action)),
                      ));
                  if (!matches) throw Error('This run is limited to its own screenshot-only test target.');
                  let image;
                  const text = await t.execute(args, {
                    ...tcx,
                    collectImage(item) {
                      tcx.collectImage(item);
                      image = item.url;
                    },
                  });
                  if (t.name === 'act_ui' && image) state.actions = (state.actions || 0) + 1;
                  if (t.name === 'find_roots' || t.name === 'launch_browser') state.root = /@r\d+/.exec(text)?.[0];
                  if (image) {
                    const id = /State ([\da-f-]{36})\./.exec(text)?.[1];
                    if (!id || !text.includes('Screenshot only') || /@e\d+|Page text:/.test(text))
                      throw Error('Expected an image-bearing screenshot-only result');
                    state.id = id;
                    const ext = image.startsWith('data:image/png;') ? 'png' : 'jpg';
                    writeFileSync(
                      join(dir, rules.key + '-delivered.' + ext),
                      Buffer.from(image.slice(image.indexOf(',') + 1), 'base64'),
                    );
                    if (!state.first) {
                      writeFileSync(
                        join(dir, rules.key + '-first.' + ext),
                        Buffer.from(image.slice(image.indexOf(',') + 1), 'base64'),
                      );
                      state.first = true;
                    }
                    state.count = (state.count || 0) + 1;
                    writeFileSync(
                      join(dir, rules.key + '-receipt.json'),
                      JSON.stringify({ state: id, count: state.count, actions: state.actions || 0 }),
                    );
                  }
                  allowed.set(tcx.sessionId, state);
                  return text;
                },
              })),
          },
        });
      },
    });
  },
};
