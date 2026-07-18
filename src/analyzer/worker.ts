// Copyright (C) 2026 Yotam Sechayk
// SPDX-License-Identifier: AGPL-3.0-or-later

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
import { accumulateEdges, changedFrac, componentRegions, diffMask, dilate, expandZoneToEdges, toGray, updateOccupancy, webcamZone } from "./pipeline";
import { GLAnalyzer } from "./glPipeline";
import { computeFeatures } from "./features";
import { StreamingClusterer, type RawActivity } from "./graph";
import { addRange, isAnalyzed, nextGap } from "./ranges";
import type { Activity, AnalysisMeta, Box, InMsg, Range, WorkerMsg } from "./types";

const post = (m: WorkerMsg) => (self as unknown as Worker).postMessage(m);

// An error whose message is written FOR the viewer. Everything else that escapes `run` is
// library noise ("Tried reading [0, 9), but slice is [0, 8)") — true, useless, and alarming.
// The distinction exists so the catch below can tell one from the other; without it a corrupt
// file greets someone with a Mediabunny internal assertion.
class UserError extends Error {}

let seekRequest: number | null = null; // set by the main thread; aborts the current segment
let activeGpu: GLAnalyzer | null = null; // disposed when the next run starts

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
    const detail = err instanceof Error ? err.message : String(err);
    post({
      type: "error",
      message: err instanceof UserError
        ? detail
        : `This file couldn't be read — it may be incomplete, corrupt, or in a container ` +
          `this browser can't parse. Re-encoding it to an MP4 usually fixes it. (${detail})`,
    });
  }
};

async function run({ file, params, debug, collectNodes, forceCpu }: Extract<InMsg, { type: "start" }>) {
  // The debug params panel is a trust boundary: a 0 (or NaN, or negative) here becomes a
  // zero-width ImageData throw or an endless timestamp loop, and either one leaves playback
  // gated forever with no way out but a reload. Floors, not validation UI — this is a
  // debug-only surface and the analyzer should simply never explode on a typo.
  params = {
    ...params,
    analysisWidth: Math.max(40, params.analysisWidth) || 480,
    sampleInterval: Math.max(0.02, params.sampleInterval) || 0.2,
  };
  // These strings are read by a person who is waiting, not by us. "Reading container" and
  // "probing the demuxer" are true and useless; what they want to know is that something is
  // happening to THEIR video and roughly what.
  post({ type: "status", stage: "Opening your video…" });
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });

  const track = await input.getPrimaryVideoTrack();
  if (!track) {
    throw new UserError(
      "This file has no video track. If it's an audio file or a container we can't parse, try an MP4/WebM."
    );
  }

  post({ type: "status", stage: `Checking the format (${track.codec ?? "unknown"})…` });
  if (!(await track.canDecode())) {
    throw new UserError(
      `Your browser can't decode this video's codec (${track.codec ?? "unknown"}). ` +
        `H.264, VP9 and AV1 work in Chrome; HEVC/H.265 usually does not. ` +
        `Re-encoding to H.264 MP4 will fix it.`
    );
  }

  const vw = track.displayWidth;
  const vh = track.displayHeight;
  const aw = Math.min(params.analysisWidth, vw);
  const ah = Math.max(1, Math.round((aw / vw) * vh));

  // Duration: prefer the container metadata. computeDuration() is documented as
  // "potentially expensive… must check all tracks" (it can scan the whole file), and by
  // default it waits for live streams to end — either of which looks like a hang.
  post({ type: "status", stage: "Reading its length…" });
  const fromMeta = await input.getDurationFromMetadata(undefined, { skipLiveWait: true });
  let duration = fromMeta ?? 0;
  if (!Number.isFinite(duration) || duration <= 0) {
    post({ type: "status", stage: "Working out its length…" });
    duration = await input.computeDuration(undefined, { skipLiveWait: true });
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new UserError("Could not determine the video's duration — the file may be corrupt or still recording.");
  }

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

  // --- Webcam pre-pass ------------------------------------------------------
  // Find the talking-head inset BEFORE any activity exists, so the veto happens at detection
  // time and nothing ever has to be retracted. ~24 frames sampled minutes apart: a person in
  // an inset has always moved between two such frames, so webcam pixels churn in ~every
  // consecutive pair, while slide pixels change only across slide turns and ink only in the
  // pairs that straddle its writing (see pipeline.webcamZone). Justified by measurement: on a
  // 59-minute lecture with a corner webcam, 171 of 602 valid moments were the webcam — the
  // per-pixel occupancy veto misses the inset's rim, whose pixels individually change too
  // rarely (silhouette edges move only when the head does).
  post({ type: "status", stage: "Checking for a webcam overlay…" });
  let webcam: Box | null = null;
  {
    const preStart = performance.now();
    const WEBCAM_SAMPLES = 24;
    const preTs: number[] = [];
    for (let i = 0; i < WEBCAM_SAMPLES; i++) preTs.push(((i + 0.5) / WEBCAM_SAMPLES) * duration);
    const churn = new Uint16Array(aw * ah);
    const edgeCounts = new Uint16Array(aw * ah);
    let prev: Uint8Array | null = null;
    let pairs = 0;
    let sampled = 0;
    for await (const sample of sink.samplesAtTimestamps(preTs)) {
      if (!sample) continue;
      sample.draw(ctx, 0, 0, aw, ah);
      sample.close();
      const gray = toGray(ctx.getImageData(0, 0, aw, ah).data, aw, ah);
      sampled++;
      accumulateEdges(gray, aw, ah, edgeCounts);
      if (prev) {
        const d = diffMask(prev, gray, aw, ah, params.diffThresh);
        const m = dilate(d.mask, aw, ah, params.dilateIters);
        for (let i = 0; i < m.length; i++) churn[i] += m[i];
        pairs++;
      }
      prev = gray;
    }
    webcam = webcamZone(churn, pairs, aw, ah, params.webcamPairFrac);

    // Churn finds the core; the inset's static border says how far the box reaches (the
    // inset's quiet side churns LESS than the slide, so no churn threshold can find it —
    // see pipeline.expandZoneToEdges).
    const edges = new Uint8Array(aw * ah);
    if (sampled > 0) {
      const need = Math.ceil(0.85 * sampled);
      for (let i = 0; i < edges.length; i++) edges[i] = edgeCounts[i] >= need ? 1 : 0;
    }
    if (webcam) webcam = expandZoneToEdges(webcam, edges, aw, ah);

    // Then pad. Measured on entropy.mkv: even after the edge expansion the zone sat ~6px
    // short of the inset's lower-left corner (a soft border/shadow never clears the 85%
    // edge-persistence bar), and shoulder-movement boxes straddling that rim passed the
    // overlap veto and got highlighted. 6px of a 480-wide frame is 1.25% — slide ink that
    // close to the inset is rare, a highlight ON the presenter's chest is not.
    // ponytail: fixed pad; if it ever eats real ink, make expandZoneToEdges accept softer edges instead.
    if (webcam) {
      const PAD = 6;
      const x = Math.max(0, webcam.x - PAD);
      const y = Math.max(0, webcam.y - PAD);
      webcam = {
        x, y,
        w: Math.min(aw - x, webcam.w + (webcam.x - x) + PAD),
        h: Math.min(ah - y, webcam.h + (webcam.y - y) + PAD),
      };
    }

    // Debug heatmap: churn as heat (black -> red -> yellow), the zone outlined in green.
    let blob: Blob | undefined;
    if (debugCanvas && debugCtx && pairs > 0) {
      const img = new Uint8ClampedArray(aw * ah * 4);
      for (let i = 0, p = 0; i < churn.length; i++, p += 4) {
        const v = churn[i] / pairs;
        img[p] = Math.round(Math.min(1, v * 2) * 255);
        img[p + 1] = Math.round(Math.max(0, v * 2 - 1) * 255);
        img[p + 2] = 24;
        img[p + 3] = 255;
        // Persistent edges in cyan — the second signal, so the card shows WHY the zone
        // reaches past the churn (it grew to the inset's static border).
        if (edges[i]) { img[p] = 0; img[p + 1] = 200; img[p + 2] = 220; }
      }
      if (webcam) {
        const { x, y, w: zw, h: zh } = webcam;
        const green = (px: number, py: number) => {
          if (px < 0 || py < 0 || px >= aw || py >= ah) return;
          const p = (py * aw + px) * 4;
          img[p] = 0; img[p + 1] = 255; img[p + 2] = 80;
        };
        for (let d = 0; d < 2; d++) {
          for (let px = x - d; px <= x + zw + d; px++) { green(px, y - d); green(px, y + zh + d); }
          for (let py = y - d; py <= y + zh + d; py++) { green(x - d, py); green(x + zw + d, py); }
        }
      }
      debugCtx.putImageData(new ImageData(img, aw, ah), 0, 0);
      blob = await debugCanvas.convertToBlob({ type: "image/webp", quality: 0.9 });
    }
    post({ type: "webcam", zone: webcam, wallMs: performance.now() - preStart, sampled, blob });
  }

  // A region mostly inside the webcam zone is the webcam, not the instructor — drop it at
  // detection time, before clustering, so no bogus activity is ever created. 0.6 rather than
  // full containment: the head's churn bleeds past the zone's edge by a dilation or two.
  const WEBCAM_OVERLAP_FRAC = 0.6;
  const inWebcam = (b: Box): boolean => {
    if (!webcam) return false;
    const ix = Math.max(0, Math.min(b.x + b.w, webcam.x + webcam.w) - Math.max(b.x, webcam.x));
    const iy = Math.max(0, Math.min(b.y + b.h, webcam.y + webcam.h) - Math.max(b.y, webcam.y));
    return (ix * iy) / (b.w * b.h) >= WEBCAM_OVERLAP_FRAC;
  };

  // GPU path. A rotated track stays on the CPU: sample.draw() applies the rotation
  // metadata, a raw VideoFrame texture upload would not. Disposing the previous run's
  // analyzer here matters: re-analyzing (new params) would otherwise leak a WebGL context
  // per run, and browsers only allow a handful.
  activeGpu?.dispose();
  const gpu = (activeGpu = !forceCpu && track.rotation === 0 ? GLAnalyzer.create(aw, ah) : null);
  post({ type: "status", stage: gpu ? "Analyzing (GPU)…" : "Analyzing (CPU)…" });

  const distTh = params.distRatio * Math.sqrt(aw * aw + ah * ah);

  // Enrich a raw cluster into an Activity: validity heuristics, always-on feature vector,
  // opt-in node log. Two validity rules:
  //  - size (Python RoIActivity._is_valid, c3/c4): the box is neither a speck nor the frame.
  //  - structural motion: most of this activity's nodes sit in frame area that never stops
  //    moving — a talking-head webcam overlay, an animated logo. That is not something the
  //    instructor did, so it must never be highlighted. It's a per-activity verdict rather
  //    than a per-pixel veto because an overlay's edge pixels aren't individually damning;
  //    what damns it is that essentially every node it ever produced is in that patch.
  const finalize = (a: RawActivity): Activity => {
    const detailed = a.log.map((n) => ({ t: n.t, region: n.detail! }));
    const features = computeFeatures(detailed, params.persistFrac);
    return {
      id: nextActivityId++,
      start: a.start,
      end: a.end,
      box: a.box,
      nodeCount: a.nodeCount,
      isValid:
        a.box.w >= params.minSizeFrac * aw && a.box.w <= params.maxSizeFrac * aw &&
        a.box.h >= params.minSizeFrac * ah && a.box.h <= params.maxSizeFrac * ah &&
        features.flaggedFrac < params.persistInvalidFrac,
      features,
      ...(collectNodes ? { nodes: detailed } : {}),
    };
  };

  let ranges: Range[] = [];
  const coverageOf = (rs: Range[]) => rs.reduce((s, r) => s + (r.end - r.start), 0);
  // Activity ids are assigned here, across the whole run, NOT by the per-segment clusterer.
  // Segments each start a fresh clusterer whose internal ids restart at 0 — using those
  // directly meant a seek-heavy run emitted colliding ids, and everything keyed on id
  // downstream (React rows, thumbnail maps) broke.
  let nextActivityId = 0;
  // Scenes are a PARTITION of the video derived from the content cuts found so far — a
  // global model, not a per-segment one. Segments are coverage artifacts (a seek starts
  // one), and posting their spans as scenes fabricated a "scene" per seek: overlapping
  // records, false "scene change" notices, broken sidebar grouping.
  const cuts: number[] = [];
  const postScenes = () => {
    const bounds = [0, ...cuts, duration];
    const scenes = [];
    for (let i = 0; i + 1 < bounds.length; i++) scenes.push({ id: i, start: bounds[i], end: bounds[i + 1] });
    post({ type: "scenes", scenes });
  };
  // Cross-segment debounce: two segments can rediscover the same cut a sample apart
  // (their local debounce state resets), and a transition straddling a segment boundary
  // must not count twice.
  const addCut = (t: number) => {
    if (cuts.some((c) => Math.abs(c - t) < params.sceneMinLen)) return;
    cuts.push(t);
    cuts.sort((a, b) => a - b);
    postScenes();
  };
  let analyzedSec = 0; // video-seconds actually analyzed (for an honest x-realtime)
  const wallStart = performance.now();
  // Where the wall time actually goes. Logged at done under ?debug=1 — it's what tells you
  // whether a slow analysis is decode-bound, readback-bound, or pixel-math-bound, which is
  // the first question worth asking before optimizing anything here.
  const cost = { decode: 0, readback: 0, math: 0 };

  // Analyze forward from `from` until: a seek is requested, we run into already-analyzed
  // video, or the video ends. Each segment is independent — fresh clusterer, fresh diff
  // state — but a segment boundary is a coverage artifact, not a scene: only real content
  // cuts enter the global cut list.
  async function analyzeSegment(from: number) {
    const clusterer = new StreamingClusterer(params.spanTh, distTh);
    gpu?.reset(); // a segment never diffs across its own start
    // Per-pixel change occupancy, for persistent-motion suppression (see pipeline.ts).
    // Per-segment, like the clusterer: a segment is independent and re-learns the webcam
    // in its first ~20 frames.
    const occ = new Float32Array(aw * ah);
    let prevGray: Uint8Array | null = null;
    let lastCut = -Infinity;
    let segEnd = from;
    let lastProgress = from;

    const timestamps: number[] = [];
    for (let t = from; t < duration; t += params.sampleInterval) timestamps.push(t);

    const flushSegment = () => {
      for (const act of clusterer.flush()) post({ type: "activity", activity: finalize(act) });
      ranges = addRange(ranges, { start: from, end: segEnd });
    };

    let mark = performance.now();
    for await (const sample of sink.samplesAtTimestamps(timestamps)) {
      cost.decode += performance.now() - mark;
      if (!sample) { mark = performance.now(); continue; }
      const t = sample.timestamp;

      // The viewer jumped somewhere unanalyzed: drop this segment and go serve them.
      if (seekRequest !== null) { sample.close(); flushSegment(); return; }
      // Ran into video a previous segment already covered: stop. Claim coverage right up
      // to that boundary — otherwise a sub-sample sliver is left behind, and the segment
      // loop would pick it forever without ever producing a sample from it.
      if (t > from && isAnalyzed(ranges, t)) { sample.close(); segEnd = t; flushSegment(); return; }

      // Decode the frame into the mask/mag/gray this sample contributes, plus its scene
      // score against the previous sample. Everything here is null on a segment's first
      // frame — there is nothing to diff against yet.
      const tMath = performance.now();
      let mask: Uint8Array | null = null;
      let mag: Uint8Array | null = null;
      let gray: Uint8Array | null = null;
      let frac: number | null = null;

      if (gpu) {
        const frame = sample.toVideoFrame();
        sample.close();
        const out = gpu.process(frame, params.diffThresh, params.dilateIters);
        frame.close();
        if (out) ({ mask, mag, gray, frac } = out);
      } else {
        const tRead = performance.now();
        sample.draw(ctx, 0, 0, aw, ah);
        sample.close(); // release the decoded frame (readback already done via draw)
        const rgba = ctx.getImageData(0, 0, aw, ah).data;
        cost.readback += performance.now() - tRead;
        gray = toGray(rgba, aw, ah);
        if (prevGray) {
          const d = diffMask(prevGray, gray, aw, ah, params.diffThresh);
          mask = dilate(d.mask, aw, ah, params.dilateIters);
          mag = d.mag;
          frac = changedFrac(mask);
        }
        prevGray = gray;
      }

      // Scene cut? A cut is the frame going away and a new one arriving — so it is measured by
      // HOW MUCH of the frame changed at once, not by how much the average pixel changed.
      let isCut = false;
      if (frac !== null && frac >= params.sceneChangeFrac && t - lastCut >= params.sceneMinLen) {
        isCut = true;
        lastCut = t;
        addCut(t);
        // Activities must not span a cut: the Python analyzer generated frame pairs
        // per scene, so no diff ever crossed a boundary. Close everything open.
        for (const act of clusterer.flush()) post({ type: "activity", activity: finalize(act) });
      }

      // A cut's own frame pair is a whole-frame change, not instructor activity — skip it.
      // (Skipping it here also keeps it out of the occupancy EMA, which a whole-frame
      // change would otherwise poison by nudging every pixel toward "always moving".)
      if (mask && mag && gray && !isCut) {
        updateOccupancy(mask, occ);
        const regions = componentRegions(mask, aw, ah, params.contourAreaLowFrac, params.contourAreaHighFrac, mag, occ)
          .filter((r) => !inWebcam(r.box));
        const boxes = regions.map((r) => r.box);
        for (const r of regions) {
          for (const act of clusterer.add({ t, box: r.box, detail: r })) {
            post({ type: "activity", activity: finalize(act) });
          }
        }

        if (debugCanvas && debugCtx) {
          // Composite: grayscale frame, diff-mask pixels tinted red, habitually-moving pixels
          // tinted blue — the blue is the learned occupancy map, i.e. where the analyzer
          // thinks the frame moves on its own. WebP-encoded so a whole video's frames fit in
          // memory for after-the-fact scrubbing.
          const comp = new Uint8ClampedArray(aw * ah * 4);
          for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
            const g = gray[i];
            if (mask[i]) { comp[p] = 255; comp[p + 1] = g >> 2; comp[p + 2] = g >> 2; }
            else if (occ[i] >= params.persistFrac) { comp[p] = g >> 2; comp[p + 1] = g >> 2; comp[p + 2] = 255; }
            else { comp[p] = g; comp[p + 1] = g; comp[p + 2] = g; }
            comp[p + 3] = 255;
          }
          debugCtx.putImageData(new ImageData(comp, aw, ah), 0, 0);
          const blob = await debugCanvas.convertToBlob({ type: "image/webp", quality: 0.8 });
          post({ type: "debugFrame", t, blob, w: aw, h: ah, boxes });
        }
      }
      analyzedSec += params.sampleInterval;
      segEnd = t;
      cost.math += performance.now() - tMath;
      mark = performance.now();

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
  if (debug) {
    const pct = (ms: number) => `${(ms / 1000).toFixed(1)}s (${((ms / wallMs) * 100).toFixed(0)}%)`;
    console.log(
      `[analyzer] ${gpu ? "GPU" : "CPU"} — wall ${(wallMs / 1000).toFixed(1)}s, decode ${pct(cost.decode)}, ` +
        `readback ${pct(cost.readback)}, pixel math ${pct(cost.math)}`
    );
  }
  // Final partition: with zero cuts this is the first scene post — one span, the whole
  // lecture — which is also what the sidebar expects (a single scene is not a grouping).
  postScenes();
  post({ type: "done", wallMs, xRealtime: analyzedSec / (wallMs / 1000), ranges });
  input.dispose?.();
}
