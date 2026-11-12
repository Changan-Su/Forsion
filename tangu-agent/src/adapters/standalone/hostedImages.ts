import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { imageMimeOf, imageOutputFields, type ImageGenRequest, type ImageGenResult, type ImagesBrain } from '../../seams/cloudBrain.js';
import { LlmError } from '../../core/types.js';

interface Job {
  id: string; state: string; error?: string; receipt?: string;
  result?: { data?: Array<{ b64_json: string }> };
}
const TOTAL_MS = 15 * 60_000;
const POLL_MS = 2000;
const TRANSFER_MS = 300_000; // Allow slow uploads and complete GIF downloads.

/** Long image generation is a durable cloud task. A broken HTTP leg never creates a new task. */
export function hostedImages(base: string, headers: () => Record<string, string>): ImagesBrain {
  async function call(path: string, auth: Record<string, string>, body?: unknown, signal?: AbortSignal, timeout = 30_000) {
    const timed = AbortSignal.timeout(timeout);
    const response = await fetch(`${base}/v1/images${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: auth,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timed]) : timed,
    });
    if (!response.ok) {
      const raw = (await response.text()).slice(0, 2000);
      let detail: any; try { detail = JSON.parse(raw); } catch {}
      throw new LlmError(response.status, String(detail?.error?.message || detail?.error || detail?.detail || raw || `Image task request failed (${response.status})`));
    }
    return response.json();
  }
  function result(job: Job): ImageGenResult {
    if (job.state === 'failed') throw new Error(job.error || 'Image generation failed. No points were charged.');
    const images = (job.result?.data || []).filter(d => d.b64_json).map(d => ({ b64: d.b64_json, mime: imageMimeOf(d.b64_json) }));
    if (!images.length || !job.receipt) throw new Error('The image result is not ready. Use recover_image to retrieve it later; no points have been charged.');
    return { images, delivery: { id: job.id, receipt: job.receipt } };
  }
  async function wait(job: Job, auth: Record<string, string>, signal?: AbortSignal, deadline = Date.now() + TOTAL_MS): Promise<ImageGenResult> {
    let current = job;
    while (current.state === 'running' && Date.now() < deadline) {
      await delay(POLL_MS, undefined, { signal });
      try { current = await call(`/jobs/${encodeURIComponent(job.id)}`, auth, undefined, signal, TRANSFER_MS) as Job; }
      catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof LlmError && error.status < 500) throw error;
        // Network interruption: continue polling the SAME job, never resubmit generation.
      }
    }
    if (current.state === 'running') throw new Error(`Image task ${job.id} is still pending. Use recover_image with this request_id; do not generate it again. No points have been charged.`);
    return result(current);
  }
  async function submit(operation: string, req: ImageGenRequest, images?: Array<{ mime: string; b64: string }>) {
    // Capture authentication for this run: a multi-user worker must not pick up another run's token.
    const auth = headers(), key = randomUUID(), deadline = Date.now() + TOTAL_MS;
    const body = {
      operation, request_id: key, model: req.model, prompt: req.prompt,
      ...(images ? { image: images.map(i => `data:${i.mime};base64,${i.b64}`) } : {}),
      size: req.size || (req.outputFormat === 'gif' ? 'auto' : '1:1'), n: req.n || 1,
      transparent_background: !!req.transparentBackground, output_format: 'png', ...imageOutputFields(req),
      ...(req.quality ? { quality: req.quality } : {}),
    };
    let job: Job | undefined;
    for (let attempt = 0; attempt < 3 && !job; attempt++) {
      req.signal?.throwIfAborted();
      try { job = await call('/jobs', auth, body, req.signal, TRANSFER_MS) as Job; }
      catch (error) {
        if (req.signal?.aborted) throw error;
        if (error instanceof LlmError && error.status < 500) {
          if (error.status === 404) throw new Error('The cloud server needs the recoverable image-task update. No image request was submitted.');
          throw error;
        }
        // The submission response may have been lost AFTER acceptance. Look up the idempotency key.
        try { job = await call(`/jobs/request/${key}`, auth, undefined, req.signal) as Job; }
        catch (lookupError) {
          if (req.signal?.aborted) throw lookupError;
          if (lookupError instanceof LlmError && lookupError.status !== 404 && lookupError.status < 500) throw lookupError;
        }
        if (!job) await delay(POLL_MS, undefined, { signal: req.signal });
      }
    }
    if (!job) throw new Error(`Image submission could not be confirmed (request ${key}). Use recover_image to check existing tasks before trying again. No delivery was charged.`);
    return wait(job, auth, req.signal, deadline);
  }
  return {
    generate: req => submit('generations', req),
    edit: req => submit('edits', req, req.images),
    listPending: async () => (await call('/jobs', headers()) as any).jobs,
    recover: async (id, signal) => {
      const auth = headers();
      return wait(await call(`/jobs/${encodeURIComponent(id)}`, auth, undefined, signal, TRANSFER_MS) as Job, auth, signal);
    },
    acknowledge: async delivery => {
      const auth = headers();
      for (let attempt = 0; ; attempt++) {
        try { await call(`/jobs/${encodeURIComponent(delivery.id)}/ack`, auth, { receipt: delivery.receipt }); return; }
        catch (error) {
          if (attempt >= 2 || (error instanceof LlmError && error.status < 500)) throw error;
          await delay(POLL_MS);
        }
      }
    },
  };
}
