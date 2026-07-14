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
//
// It runs in BATCHES, trailing the analyzer rather than waiting for it. Moments finalize in
// time order, so each batch covers a contiguous stretch of the lecture and is still one
// monotonic pass — just over a slice. Waiting for `done` instead meant a 59-minute lecture
// showed 602 numbered placeholders for the FOURTEEN MINUTES the analysis took, which is
// exactly the window in which the table of contents is worth having. The whole pass costs
// ~25s for that lecture (1.6 MB of crops), so spreading it out is nearly free; the only new
// cost is one seek per batch.
//
// The file is opened ONCE and the sink reused across batches — reopening per batch would
// re-parse the container every time.

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import { SNIPPET_MAX_WIDTH, SNIPPET_MEM_BUDGET, type CropRect } from "./snippets";

// One frame to capture: which activity it belongs to, when, and the (fixed) crop window.
export type SnippetReq = { activityId: number; t: number; rect: CropRect };

export type SnippetInMsg =
  | { type: "open"; file: File }
  | { type: "batch"; reqs: SnippetReq[] };

export type SnippetOutMsg =
  | { type: "snippet"; activityId: number; t: number; blob: Blob }
  | { type: "batchDone"; count: number; bytes: number; wallMs: number }
  | { type: "error"; message: string };

const post = (m: SnippetOutMsg) => (self as unknown as Worker).postMessage(m);

let sink: VideoSampleSink | null = null;
let frame: OffscreenCanvas | null = null;
let frameCtx: OffscreenCanvasRenderingContext2D | null = null;
// Budget is cumulative across batches, not per batch — it caps what we hold, not what we do.
let totalBytes = 0;

self.onmessage = async (e: MessageEvent<SnippetInMsg>) => {
  try {
    if (e.data.type === "open") await open(e.data.file);
    else if (e.data.type === "batch") await run(e.data.reqs);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

async function open(file: File) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No video track found");
  sink = new VideoSampleSink(track);
  frame = new OffscreenCanvas(track.displayWidth, track.displayHeight);
  frameCtx = frame.getContext("2d");
}

async function run(reqs: SnippetReq[]) {
  if (reqs.length === 0 || totalBytes >= SNIPPET_MEM_BUDGET) {
    post({ type: "batchDone", count: 0, bytes: 0, wallMs: 0 });
    return;
  }
  // A batch can only arrive after `open` — the caller serializes them.
  if (!sink || !frame || !frameCtx) throw new Error("Snippet worker got a batch before the file");

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

  const wallStart = performance.now();
  let count = 0;
  let bytes = 0;
  let done = 0;

  for await (const sample of sink.samplesAtTimestamps(timestamps)) {
    // samplesAtTimestamps yields one entry per requested timestamp, in request order —
    // including a null when a timestamp has no frame. The index must advance even for a
    // null, or every crop after it pairs with the wrong timestamp (and so with the wrong
    // activity).
    const t = timestamps[done];
    done++;
    if (!sample) continue;

    // Draw the decoded frame once at native size, then crop out each activity's window.
    sample.draw(frameCtx, 0, 0, frame.width, frame.height);
    sample.close();

    for (const req of byTime.get(t) ?? []) {
      if (totalBytes >= SNIPPET_MEM_BUDGET) break;
      const { x, y, w, h } = req.rect;
      if (w < 2 || h < 2) continue;
      const outW = Math.min(SNIPPET_MAX_WIDTH, Math.round(w));
      const outH = Math.max(1, Math.round((outW / w) * h));
      canvas.width = outW;
      canvas.height = outH;
      ctx.drawImage(frame, x, y, w, h, 0, 0, outW, outH);
      const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
      bytes += blob.size;
      totalBytes += blob.size;
      count++;
      post({ type: "snippet", activityId: req.activityId, t: req.t, blob });
    }

    if (totalBytes >= SNIPPET_MEM_BUDGET) break;
  }

  post({ type: "batchDone", count, bytes, wallMs: performance.now() - wallStart });
}
