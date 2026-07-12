/// <reference lib="webworker" />
// Analysis worker: sequential WebCodecs decode (via Mediabunny) of sampled frames
// -> diff pipeline -> streaming clusterer -> postMessage.
//
// Analysis is segmented, not a single forward pass. A seek into unanalyzed video
// abandons the current segment and restarts there, so the viewer's position is
// always the priority; when a segment runs into already-analyzed video (or the end),
// the worker backfills the earliest remaining gap. Coverage is therefore a set of
// ranges, not one frontier.

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import { componentBoxes, contentScore, diffMask, dilate, toGray } from "./pipeline";
import { StreamingClusterer, type RawActivity } from "./graph";
import { addRange, isAnalyzed, nextGap } from "./ranges";
import type { Activity, AnalysisMeta, Box, InMsg, Range, WorkerMsg } from "./types";

const post = (m: WorkerMsg) => (self as unknown as Worker).postMessage(m);

let seekRequest: number | null = null; // set by the main thread; aborts the current segment

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === "seek") {
    seekRequest = msg.t;
    return;
  }
  if (msg.type !== "start") return;
  try {
    seekRequest = null;
    await run(msg);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

async function run({ file, params, debug }: Extract<InMsg, { type: "start" }>) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No video track found");
  if (!(await track.canDecode())) throw new Error(`Cannot decode codec: ${track.codec ?? "unknown"}`);

  const vw = track.displayWidth;
  const vh = track.displayHeight;
  const aw = Math.min(params.analysisWidth, vw);
  const ah = Math.max(1, Math.round((aw / vw) * vh));
  const duration = await input.computeDuration();

  const meta: AnalysisMeta = {
    videoWidth: vw, videoHeight: vh,
    analysisWidth: aw, analysisHeight: ah,
    scale: vw / aw, duration,
  };
  post({ type: "meta", meta });

  const canvas = new OffscreenCanvas(aw, ah);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const debugCanvas = debug ? new OffscreenCanvas(aw, ah) : null;
  const debugCtx = debugCanvas?.getContext("2d") ?? null;
  const sink = new VideoSampleSink(track);

  const distTh = params.distRatio * Math.sqrt(aw * aw + ah * ah);

  // Size-based validity (Python RoIActivity._is_valid, c3/c4).
  const validate = (a: RawActivity): Activity => ({
    ...a,
    isValid:
      a.box.w >= params.minSizeFrac * aw && a.box.w <= params.maxSizeFrac * aw &&
      a.box.h >= params.minSizeFrac * ah && a.box.h <= params.maxSizeFrac * ah,
  });

  let ranges: Range[] = [];
  const coverageOf = (rs: Range[]) => rs.reduce((s, r) => s + (r.end - r.start), 0);
  let sceneId = 0;
  let analyzedSec = 0; // video-seconds actually analyzed (for an honest x-realtime)
  const wallStart = performance.now();

  // Analyze forward from `from` until: a seek is requested, we run into already-analyzed
  // video, or the video ends. Each segment is independent — fresh clusterer, and its start
  // is treated as a scene start (as a cut would be).
  async function analyzeSegment(from: number) {
    const clusterer = new StreamingClusterer(params.spanTh, distTh);
    let prevGray: Uint8Array | null = null;
    let prevRgba: Uint8ClampedArray | null = null;
    let sceneStart = from;
    let lastCut = -Infinity;
    let segEnd = from;
    let lastProgress = from;

    const timestamps: number[] = [];
    for (let t = from; t < duration; t += params.sampleInterval) timestamps.push(t);

    const flushSegment = () => {
      for (const act of clusterer.flush()) post({ type: "activity", activity: validate(act) });
      if (segEnd > sceneStart) post({ type: "scene", scene: { id: sceneId++, start: sceneStart, end: segEnd } });
      ranges = addRange(ranges, { start: from, end: segEnd });
    };

    for await (const sample of sink.samplesAtTimestamps(timestamps)) {
      if (!sample) continue;
      const t = sample.timestamp;

      // The viewer jumped somewhere unanalyzed: drop this segment and go serve them.
      if (seekRequest !== null) { sample.close(); flushSegment(); return; }
      // Ran into video a previous segment already covered: stop. Claim coverage right up
      // to that boundary — otherwise a sub-sample sliver is left behind, and the segment
      // loop would pick it forever without ever producing a sample from it.
      if (t > from && isAnalyzed(ranges, t)) { sample.close(); segEnd = t; flushSegment(); return; }

      sample.draw(ctx, 0, 0, aw, ah);
      sample.close(); // release the decoded frame (readback already done via draw)
      const rgba = ctx.getImageData(0, 0, aw, ah).data;
      const gray = toGray(rgba, aw, ah);

      // Scene cut? Score the HSV content change against the previous sample.
      let isCut = false;
      if (prevRgba) {
        const score = contentScore(prevRgba, rgba);
        if (score >= params.sceneThreshold && t - lastCut >= params.sceneMinLen) {
          isCut = true;
          lastCut = t;
          post({ type: "scene", scene: { id: sceneId++, start: sceneStart, end: t } });
          sceneStart = t;
          // Activities must not span a cut: the Python analyzer generated frame pairs
          // per scene, so no diff ever crossed a boundary. Close everything open.
          for (const act of clusterer.flush()) post({ type: "activity", activity: validate(act) });
        }
      }

      // A cut's own frame pair is a whole-frame change, not instructor activity — skip it.
      if (prevGray && !isCut) {
        const mask = dilate(diffMask(prevGray, gray, aw, ah, params.diffThresh), aw, ah, params.dilateIters);
        const boxes: Box[] = componentBoxes(mask, aw, ah, params.contourAreaLowFrac, params.contourAreaHighFrac);
        for (const box of boxes) {
          for (const act of clusterer.add({ t, box })) post({ type: "activity", activity: validate(act) });
        }

        if (debugCanvas && debugCtx) {
          // Composite: grayscale frame, diff-mask pixels tinted red. WebP-encoded so a
          // whole video's frames fit in memory for after-the-fact scrubbing.
          const comp = new Uint8ClampedArray(aw * ah * 4);
          for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
            const g = gray[i];
            if (mask[i]) { comp[p] = 255; comp[p + 1] = g >> 2; comp[p + 2] = g >> 2; }
            else { comp[p] = g; comp[p + 1] = g; comp[p + 2] = g; }
            comp[p + 3] = 255;
          }
          debugCtx.putImageData(new ImageData(comp, aw, ah), 0, 0);
          const blob = await debugCanvas.convertToBlob({ type: "image/webp", quality: 0.8 });
          post({ type: "debugFrame", t, blob, w: aw, h: ah, boxes });
        }
      }
      prevGray = gray;
      prevRgba = rgba;
      analyzedSec += params.sampleInterval;
      segEnd = t;

      if (t - lastProgress >= 0.5) {
        const wallSec = (performance.now() - wallStart) / 1000;
        post({
          type: "progress",
          analyzedUpTo: t,
          xRealtime: wallSec > 0 ? analyzedSec / wallSec : 0,
          openClusters: clusterer.openCount,
          ranges: addRange(ranges, { start: from, end: segEnd }),
        });
        lastProgress = t;
      }
    }

    segEnd = duration;
    flushSegment();
  }

  // Segment loop: serve seeks first, otherwise fill the earliest remaining gap.
  let start: number | null = 0;
  while (start !== null) {
    const before = coverageOf(ranges);
    await analyzeSegment(start);
    if (seekRequest !== null) {
      const target = seekRequest;
      seekRequest = null;
      start = isAnalyzed(ranges, target) ? nextGap(ranges, duration, 0) : target;
      continue;
    }
    // Safety: a segment that covered nothing new would be picked again forever.
    // Claim the gap it failed on so the loop always terminates.
    if (coverageOf(ranges) <= before + 1e-6) {
      const stuck = nextGap(ranges, duration, 0);
      if (stuck === null) break;
      const nextStart = ranges.find((r) => r.start > stuck)?.start ?? duration;
      ranges = addRange(ranges, { start: stuck, end: nextStart });
    }
    start = nextGap(ranges, duration, 0);
  }

  const wallMs = performance.now() - wallStart;
  post({ type: "done", wallMs, xRealtime: analyzedSec / (wallMs / 1000), ranges });
  input.dispose?.();
}
