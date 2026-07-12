/// <reference lib="webworker" />
// Phase-0 analysis worker: sequential WebCodecs decode (via Mediabunny) of sampled
// frames -> diff pipeline -> streaming clusterer -> postMessage. Measures x-realtime.

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import { componentBoxes, diffMask, dilate, toGray } from "./pipeline";
import { StreamingClusterer, type RawActivity } from "./graph";
import type { Activity, AnalysisMeta, Box, StartMsg, WorkerMsg } from "./types";

const post = (m: WorkerMsg) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<StartMsg>) => {
  const msg = e.data;
  if (msg.type !== "start") return;
  try {
    await run(msg);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

async function run({ file, params }: StartMsg) {
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
  const sink = new VideoSampleSink(track);

  // Time-based sampling (design decision: robust to variable frame rate).
  const timestamps: number[] = [];
  for (let t = 0; t < duration; t += params.sampleInterval) timestamps.push(t);

  const distTh = params.distRatio * Math.sqrt(aw * aw + ah * ah);
  const clusterer = new StreamingClusterer(params.spanTh, distTh);

  // Size-based validity (Python RoIActivity._is_valid, c3/c4).
  const validate = (a: RawActivity): Activity => ({
    ...a,
    isValid:
      a.box.w >= params.minSizeFrac * aw && a.box.w <= params.maxSizeFrac * aw &&
      a.box.h >= params.minSizeFrac * ah && a.box.h <= params.maxSizeFrac * ah,
  });

  let prevGray: Uint8Array | null = null;
  const wallStart = performance.now();
  let lastProgress = 0;

  for await (const sample of sink.samplesAtTimestamps(timestamps)) {
    if (!sample) continue;
    const t = sample.timestamp;
    sample.draw(ctx, 0, 0, aw, ah);
    sample.close(); // release the decoded frame (readback already done via draw)
    const rgba = ctx.getImageData(0, 0, aw, ah).data;
    const gray = toGray(rgba, aw, ah);

    if (prevGray) {
      const mask = dilate(diffMask(prevGray, gray, aw, ah, params.diffThresh), aw, ah, params.dilateIters);
      const boxes: Box[] = componentBoxes(mask, aw, ah, params.contourAreaLowFrac, params.contourAreaHighFrac);
      for (const box of boxes) {
        for (const act of clusterer.add({ t, box })) post({ type: "activity", activity: validate(act) });
      }
    }
    prevGray = gray;

    if (t - lastProgress >= 0.5) {
      const wallSec = (performance.now() - wallStart) / 1000;
      post({ type: "progress", analyzedUpTo: t, xRealtime: wallSec > 0 ? t / wallSec : 0 });
      lastProgress = t;
    }
  }

  for (const act of clusterer.flush()) post({ type: "activity", activity: validate(act) });
  const wallMs = performance.now() - wallStart;
  post({ type: "done", wallMs, xRealtime: duration / (wallMs / 1000) });
  input.dispose?.();
}
