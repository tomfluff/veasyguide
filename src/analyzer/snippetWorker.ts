/// <reference lib="webworker" />
// Generates activity snippet sequences: a few native-resolution crops per activity,
// showing how it evolved (before → start → …every 0.5s… → end).
//
// The naive way is to seek a <video> element once per crop. That is ~250 random seeks
// for a 5-minute lecture, each flushing the decoder — minutes of work. Instead we
// collect EVERY requested timestamp across all activities, sort them, and run ONE
// monotonic decode pass via Mediabunny's samplesAtTimestamps(), which decodes each
// packet at most once. Same cost shape as an analysis pass, at native resolution.
//
// This runs only when snippets are switched on, so analysis throughput is untouched.

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import { SNIPPET_MAX_WIDTH, SNIPPET_MEM_BUDGET, type CropRect } from "./snippets";

// One frame to capture: which activity it belongs to, when, and the (fixed) crop window.
export type SnippetReq = { activityId: number; t: number; rect: CropRect };

export type SnippetInMsg = { type: "start"; file: File; reqs: SnippetReq[] };

export type SnippetOutMsg =
  | { type: "snippet"; activityId: number; t: number; blob: Blob }
  | { type: "progress"; done: number; total: number }
  | { type: "done"; count: number; bytes: number; wallMs: number }
  | { type: "error"; message: string };

const post = (m: SnippetOutMsg) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<SnippetInMsg>) => {
  if (e.data.type !== "start") return;
  try {
    await run(e.data);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

async function run({ file, reqs }: SnippetInMsg) {
  if (reqs.length === 0) {
    post({ type: "done", count: 0, bytes: 0, wallMs: 0 });
    return;
  }

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No video track found");
  const sink = new VideoSampleSink(track);

  // Sort by time and group requests that share a timestamp: one decoded frame can
  // serve several activities (they overlap in time more often than you'd think).
  const sorted = [...reqs].sort((a, b) => a.t - b.t);
  const byTime = new Map<number, SnippetReq[]>();
  for (const r of sorted) {
    const list = byTime.get(r.t);
    if (list) list.push(r);
    else byTime.set(r.t, [r]);
  }
  const timestamps = [...byTime.keys()]; // already ascending (Map preserves insertion)

  const canvas = new OffscreenCanvas(SNIPPET_MAX_WIDTH, SNIPPET_MAX_WIDTH);
  const ctx = canvas.getContext("2d")!;
  const frame = new OffscreenCanvas(track.displayWidth, track.displayHeight);
  const frameCtx = frame.getContext("2d")!;

  const wallStart = performance.now();
  let count = 0;
  let bytes = 0;
  let done = 0;

  for await (const sample of sink.samplesAtTimestamps(timestamps)) {
    if (!sample) continue;
    // samplesAtTimestamps yields in request order, so pair by index.
    const t = timestamps[done];
    done++;

    // Draw the decoded frame once at native size, then crop out each activity's window.
    sample.draw(frameCtx, 0, 0, frame.width, frame.height);
    sample.close();

    for (const req of byTime.get(t) ?? []) {
      if (bytes >= SNIPPET_MEM_BUDGET) break;
      const { x, y, w, h } = req.rect;
      if (w < 2 || h < 2) continue;
      const outW = Math.min(SNIPPET_MAX_WIDTH, Math.round(w));
      const outH = Math.max(1, Math.round((outW / w) * h));
      canvas.width = outW;
      canvas.height = outH;
      ctx.drawImage(frame, x, y, w, h, 0, 0, outW, outH);
      const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
      bytes += blob.size;
      count++;
      post({ type: "snippet", activityId: req.activityId, t: req.t, blob });
    }

    if (done % 10 === 0) post({ type: "progress", done, total: timestamps.length });
    if (bytes >= SNIPPET_MEM_BUDGET) break;
  }

  post({ type: "done", count, bytes, wallMs: performance.now() - wallStart });
  input.dispose?.();
}
