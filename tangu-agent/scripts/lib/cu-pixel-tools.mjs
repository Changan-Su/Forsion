// Fixture boundary around the installed provider. Only the entry points and targets of this
// experiment are exposed. Forward production results and preserve exactly the delivered image.
import { AsyncLocalStorage } from 'node:async_hooks';
import plugin from './provider.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.TANGU_PIXEL_HARNESS_DIR;
const allowed = new Map();
const fixtureUrl = new AsyncLocalStorage();
export default {
  ...plugin,
  activate(ctx) {
    return plugin.activate({
      ...ctx,
      sdk: {
        ...ctx.sdk,
        validateBrowserUrl(url) {
          if (url === fixtureUrl.getStore()) return Promise.resolve(url);
          return ctx.sdk.validateBrowserUrl(url);
        },
      },
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
                  if (!/^live-cu(?:paintfill|paintoutline|preview)-\d+$/.test(tcx.sessionId || ''))
                    return t.execute(args, tcx);
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
                    (t.name === 'find_roots' &&
                      rules.pid &&
                      args.pid === rules.pid &&
                      (!args.kind || args.kind === 'window')) ||
                    (t.name === 'observe_ui' &&
                      state.root &&
                      args.root === state.root &&
                      (rules.url || args.mode === 'pixels')) ||
                    (t.name === 'act_ui' &&
                      state.id &&
                      args.stateId === state.id &&
                      !args.expect &&
                      Array.isArray(args.actions) &&
                      args.actions.length === 1 &&
                      args.actions.every(
                        (a) =>
                          !a.ref &&
                          (rules.pid
                            ? a.action === 'click' && (a.clickCount ?? 1) === 1 && (a.button ?? 'left') === 'left'
                            : ['click', 'moveMouse', 'scroll', 'drag', 'keypress'].includes(a.action)),
                      ));
                  if (!matches) throw Error('This run is limited to its own screenshot-only test target.');
                  const images = [];
                  const request = t.name === 'find_roots' ? { ...args, kind: 'window', text: rules.title } : args;
                  let text = await fixtureUrl.run(rules.url, () =>
                    t.execute(request, { ...tcx, collectImage: (item) => images.push(item) }),
                  );
                  if (t.name === 'find_roots') {
                    const lines = text
                      .split('\n')
                      .filter(
                        (line) =>
                          line.startsWith('- @r') &&
                          line.includes(' pid ' + rules.pid + ' — ' + rules.title + ' ('),
                      );
                    if (lines.length !== 1 || images.length)
                      throw Error('Could not uniquely resolve the generated Preview document.');
                    state.root = /@r\d+/.exec(lines[0])[0];
                    text = lines[0];
                  } else if (!images.length) {
                    throw Error('No successor screenshot of the test target; the effect is unverified.');
                  }
                  const image = images.find((item) => item.name !== 'detail-2x.png')?.url;
                  if (t.name === 'launch_browser') state.root = /@r\d+/.exec(text)?.[0];
                  if (image) {
                    const id = /State ([\da-f-]{36})\./.exec(text)?.[1];
                    if (!id || !text.includes('Screenshot only') || /@e\d+|Page text:/.test(text))
                      throw Error('Expected an image-bearing screenshot-only result');
                    if (!state.root || !text.includes(state.root)) throw Error('Unexpected screenshot root.');
                    if (t.name === 'act_ui') {
                      if (rules.pid) {
                        const line = text.split('\n').find((v) => v.startsWith('[execution] '));
                        const trace = line && JSON.parse(line.slice(12));
                        if (
                          !trace?.strictBackground ||
                          trace.error ||
                          trace.steps?.length !== 1 ||
                          trace.steps[0].error ||
                          !['ax', 'pid'].includes(trace.steps[0].delivery) ||
                          text.includes('[foreground]')
                        ) {
                          throw Error('Native background delivery could not be verified.');
                        }
                      }
                      state.actions = (state.actions || 0) + 1;
                    }
                    if (t.name === 'observe_ui' && state.actions) state.checked = true;
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
                      JSON.stringify({
                        state: id,
                        count: state.count,
                        actions: state.actions || 0,
                        checked: state.checked || false,
                      }),
                    );
                  }
                  for (const item of images) tcx.collectImage(item);
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
