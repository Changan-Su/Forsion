import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { deps } from '../../seams/runtime.js';
import type { ImageGenResult } from '../../seams/cloudBrain.js';
import type { DisplayFileItem, ToolContext } from '../toolTypes.js';
import type { ToolProvider } from '../toolRegistry.js';

/** Save every result before acknowledging delivery. A write failure leaves the hosted task uncharged. */
export async function deliverImages(result: ImageGenResult, ctx: ToolContext, source: 'generate_image' | 'edit_image') {
  if (!ctx.displayFile) throw new Error('This environment cannot display images.');
  if (!result.images.length) throw new Error('The image service returned no images.');
  const names: string[] = [];
  const files: DisplayFileItem[] = [];
  for (let i = 0; i < result.images.length; i++) {
    const image = result.images[i];
    const ext = image.mime === 'image/gif' ? 'gif' : image.mime === 'image/jpeg' ? 'jpg' : image.mime === 'image/webp' ? 'webp' : 'png';
    const id = result.delivery?.id || randomUUID();
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error('Invalid image task ID.');
    const name = `${source === 'edit_image' ? 'edit' : 'image'}-${id}-${i + 1}.${ext}`;
    const bytes = Buffer.from(image.b64, 'base64');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    ctx.signal?.throwIfAborted();
    if (ctx.execMode === 'host' && ctx.cwd) {
      const file = path.resolve(ctx.cwd, 'generated', name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temp, 'wx');
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await fs.link(temp, file); // Atomic publication without replacing an existing user file.
      } catch (error: any) {
        if (error.code !== 'EEXIST' || createHash('sha256').update(await fs.readFile(file)).digest('hex') !== sha256) throw error;
      } finally { await fs.unlink(temp).catch(() => {}); }
      files.push({ name, mime: image.mime, path: file, source, sha256 });
    } else {
      files.push({ name, mime: image.mime, dataUrl: `data:${image.mime};base64,${image.b64}`, source });
    }
    names.push(name);
  }
  if (result.delivery) {
    if (!ctx.persistImageFiles) throw new Error('Durable image delivery is unavailable. Use recover_image after updating the engine; no points were charged.');
    await ctx.persistImageFiles(files.map(file => ({ ...file, imageDelivery: result.delivery })));
  } else {
    for (const file of files) await ctx.displayFile(file);
  }
  if (result.delivery) {
    try { await deps().brain.images?.acknowledge?.(result.delivery); }
    catch (error) {
      // The user already has the files. A lost ACK must never turn success into another generation.
      console.warn('[image delivery] acknowledgement pending', result.delivery.id, error instanceof Error ? error.message : String(error));
    }
  }
  return names;
}

export const recoverImageTool: ReturnType<ToolProvider['tools']>[number] = {
  name: 'recover_image', mode: 'both', deferred: true,
  deferHint: 'Recover hosted image/GIF generation after a timeout, disconnect, stopped turn or restart. Lists recent tasks or retrieves an existing result without generating or charging twice.',
  capabilities: { sideEffect: 'network', parallel: false, defaultTimeoutMs: 1_000_000 },
  definition: { type: 'function', function: {
    name: 'recover_image',
    description: 'Retrieve an existing Forsion-hosted image result after a timeout, disconnect or interrupted turn. Call without request_id to list recent tasks, then pass the returned task id to retrieve and display its images. Prefer this over generating again when the previous outcome is unknown. Results can also be recovered after restarting the app. Delivery is charged at most once, after the images have been saved/displayed; listing and fetching an already delivered result never charge again.',
    parameters: { type: 'object', properties: { request_id: { type: 'string', description: 'Task id returned by the task list or a pending-generation message. Omit to list recent tasks.' } } },
  } },
  execute: async (args, ctx) => {
    const images = deps().brain.images;
    if (!images?.recover || !images.listPending) return 'Error: Image recovery is unavailable for this connection.';
    try {
      if (!args.request_id) return JSON.stringify(await images.listPending());
      const result = await images.recover(String(args.request_id), ctx.signal);
      const names = await deliverImages(result, ctx, 'generate_image');
      return `Recovered ${names.length} image(s): ${names.join(', ')}. Results are displayed. Do not generate them again or call display_file.`;
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

/** Chat persistence is the retry record. Authentication comes from this run, never from stored credentials. */
export async function retryImageDeliveries(ctx: Pick<ToolContext, 'userId' | 'sessionId'>): Promise<void> {
  const { brain, state } = deps();
  if (!state.hasImageDelivery || !brain.images?.listPending || !brain.images.recover || !brain.images.acknowledge) return;
  const jobs = await brain.images.listPending();
  for (const job of jobs) {
    if (job.state !== 'ready') continue;
    // Metadata lists contain the content receipt, so a retry does not download the image again.
    if (!job.receipt || !await state.hasImageDelivery(ctx.userId, ctx.sessionId, { id: job.id, receipt: job.receipt })) continue;
    await brain.images.acknowledge({ id: job.id, receipt: job.receipt });
  }
}
