// Runnable self-check for the pure pipeline + clusterer logic (no browser needed).
// Run: node --experimental-strip-types src/analyzer/selfcheck.ts
import { changedFrac, componentRegions, diffMask, dilate, expandZoneToEdges, toGray, updateOccupancy, webcamZone, type Region } from "./pipeline.ts";
import { computeFeatures, shapeDiff, type DetailedNode } from "./features.ts";
import { StreamingClusterer } from "./graph.ts";
import { selectActivity, validActivities } from "./select.ts";
import { addRange, coverage, isAnalyzed, nextGap } from "./ranges.ts";
import { cropRect, snippetTimestamps, SNIPPET_MAX_FRAMES } from "./snippets.ts";
import { zoomTransform } from "../player/zoom.ts";
import type { Activity, Node } from "./types.ts";

// Run every check, then fail. Exiting on the first failure means one stale assertion silently
// takes every check after it out of the run — which is exactly what happened: a check that had
// been testing behaviour since moved out of selectActivity sat here failing, and checks 5-10
// below it (scene detection, ranges, Hu moments, features, snippets, zoom) had not executed
// for who knows how long.
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failed++; return; }
  console.log("ok:", msg);
}
process.on("exit", () => process.exitCode = failed > 0 ? 1 : 0);

const W = 100, H = 100;

// Build an RGBA frame with a filled white box.
function frameWithBox(bx: number, by: number, bw: number, bh: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inBox = x >= bx && x < bx + bw && y >= by && y < by + bh;
      const p = (y * W + x) * 4;
      const v = inBox ? 255 : 20;
      rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
      rgba[p + 3] = 255;
    }
  return rgba;
}

// 1. A box that moves should produce exactly one detected component near the motion.
{
  const a = toGray(frameWithBox(20, 20, 12, 12), W, H);
  const b = toGray(frameWithBox(40, 40, 12, 12), W, H);
  const { mask: raw, mag } = diffMask(a, b, W, H);
  const mask = dilate(raw, W, H);
  const regions = componentRegions(mask, W, H, 0.00015, 0.5, mag);
  assert(regions.length >= 1, `motion produces >=1 component (got ${regions.length})`);
  // The changed region spans roughly x:20..52, y:20..52
  const r0 = regions[0];
  assert(r0.box.x < 40 && r0.box.x + r0.box.w > 30, `component overlaps the motion region (x=${r0.box.x},w=${r0.box.w})`);
  assert(r0.mass > 0 && r0.mass <= r0.box.w * r0.box.h, "mass is positive and bounded by bbox area");
  assert(r0.cx >= r0.box.x && r0.cx <= r0.box.x + r0.box.w, "centroid inside bbox");
  assert(r0.meanDiff > 25, `region meanDiff above threshold (${r0.meanDiff.toFixed(1)})`);
}

// 2. Identical frames produce no components.
{
  const a = toGray(frameWithBox(30, 30, 12, 12), W, H);
  const { mask: raw } = diffMask(a, a, W, H);
  const mask = dilate(raw, W, H);
  assert(componentRegions(mask, W, H).length === 0, "identical frames -> 0 components");
}

// 2b. Structural motion: a talking-head webcam in the corner is flagged and its activity
// invalidated, while the instructor writing elsewhere stays valid.
//
// The head DRIFTS rather than flickering in place — that's the case that matters. Only its
// core sits still enough to change on every frame; the silhouette edges move around, so a
// per-pixel "always changes" veto misses them and the corner still produces regions. What
// separates it from ink is that ALL of its pixels move far more often than ink's ever do.
{
  // Head: a 20x20 patch near (72,72) that wobbles a few px each frame. Pen: an 8x8 mark
  // written at a fresh spot, left there afterwards (ink accumulates, it doesn't churn).
  const frame = (i: number, pen?: { x: number; y: number }) => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    const hx = 72 + (i % 3), hy = 72 + ((i * 2) % 3);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let v = 20;
        if (x >= hx && x < hx + 20 && y >= hy && y < hy + 20) v = 200;
        if (pen && x >= pen.x && x < pen.x + 8 && y >= pen.y && y < pen.y + 8) v = 255;
        const p = (y * W + x) * 4;
        rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
        rgba[p + 3] = 255;
      }
    return rgba;
  };
  const occ = new Float32Array(W * H);
  const step = (a: Uint8ClampedArray, b: Uint8ClampedArray): Region[] => {
    const { mask: raw, mag } = diffMask(toGray(a, W, H), toGray(b, W, H), W, H);
    const mask = dilate(raw, W, H);
    updateOccupancy(mask, occ);
    return componentRegions(mask, W, H, 0.00015, 0.5, mag, occ);
  };

  const FLAG = 0.35, VETO = 0.5;
  const head: DetailedNode[] = [];
  let prev = frame(0);
  for (let i = 1; i <= 60; i++) {
    const cur = frame(i);
    for (const r of step(prev, cur)) head.push({ t: i * 0.2, region: r });
    prev = cur;
  }
  assert(head.length > 0, "a drifting head still produces regions (a per-pixel veto would not catch it)");
  const headFeat = computeFeatures(head, FLAG);
  assert(
    headFeat.flaggedFrac >= VETO,
    `webcam activity is mostly flagged nodes -> invalid (flaggedFrac=${headFeat.flaggedFrac.toFixed(2)}, occ=${headFeat.meanOcc.toFixed(2)})`
  );

  // The instructor now writes, one fresh 8x8 mark at a time, away from the head.
  const pen: DetailedNode[] = [];
  for (let i = 61; i <= 70; i++) {
    const cur = frame(i, { x: 10 + (i - 61) * 4, y: 20 });
    for (const r of step(prev, cur)) {
      if (r.box.x < 50) pen.push({ t: i * 0.2, region: r }); // the pen's regions, not the head's
    }
    prev = cur;
  }
  assert(pen.length > 0, "pen strokes are still detected beside the webcam");
  const penFeat = computeFeatures(pen, FLAG);
  assert(
    penFeat.flaggedFrac < VETO,
    `writing survives the veto (flaggedFrac=${penFeat.flaggedFrac.toFixed(2)}, occ=${penFeat.meanOcc.toFixed(2)})`
  );
  assert(
    penFeat.meanOcc < headFeat.meanOcc / 2,
    `ink churns far less than a webcam (ink occ=${penFeat.meanOcc.toFixed(2)} vs head occ=${headFeat.meanOcc.toFixed(2)})`
  );
}

// 3. Clusterer: two nodes within spanTh + distTh merge; a far-future node finalizes them.
{
  const c = new StreamingClusterer(1.0, 15);
  const near = (t: number, x: number): Node => ({ t, box: { x, y: 10, w: 6, h: 6 } });
  let finalized = c.add(near(0.0, 10));
  finalized = finalized.concat(c.add(near(0.4, 12))); // links (close in time+space)
  assert(finalized.length === 0, "linked nodes not yet finalized");
  // A node 3s later is beyond spanTh of the first cluster -> finalizes it.
  finalized = c.add(near(3.0, 80));
  assert(finalized.length === 1, `watermark finalized the stale cluster (got ${finalized.length})`);
  assert(finalized[0].nodeCount === 2, `merged cluster has 2 nodes (got ${finalized[0].nodeCount})`);
  assert(Math.abs(finalized[0].start - 0) < 1e-9 && Math.abs(finalized[0].end - 0.4) < 1e-9, "cluster time span correct");
  const rest = c.flush();
  assert(rest.length === 1, "flush emits the remaining open cluster");
}

// 4. Activity selection: pre-activity lead + active-precedence (study player port).
{
  const act = (id: number, start: number, end: number): Activity => ({
    id, start, end, box: { x: 0, y: 0, w: 10, h: 10 }, nodeCount: 1, isValid: true,
    features: computeFeatures([]),
  });
  const opts = { lead: 1.0, linger: 0.5, minDuration: 0 };
  const A = act(0, 10, 20); // long, active during most tests
  const B = act(1, 21, 25); // upcoming

  // Pre-activity: nothing active at t=9.5, A starts at 10 -> highlighted early.
  assert(selectActivity([A, B], 9.5, opts)?.id === 0, "pre-activity cue shows before start");
  // Nothing eligible well before.
  assert(selectActivity([A, B], 8.5, opts) === null, "no highlight outside lead window");
  // Active precedence: at t=20.3, A lingers (ended 20) and B is upcoming (starts 21).
  // Neither is active; closest start to t wins -> B (|21-20.3| < |10-20.3|).
  assert(selectActivity([A, B], 20.3, opts)?.id === 1, "closest start wins when none active");
  // A active at t=19.9 while B is in its lead window -> the ACTIVE one wins.
  assert(selectActivity([A, B], 19.9, opts)?.id === 0, "active activity beats pre-activity cue");
  // Linger: A still highlighted at t=20.4 when B removed.
  assert(selectActivity([A], 20.4, opts)?.id === 0, "highlight lingers after end");
  // minDuration filter hides short activities. It is applied by validActivities, NOT by
  // selectActivity — the filtering moved there so the player, the timeline and the sidebar all
  // see one list. Passing minDuration to selectActivity does nothing at all.
  const S = act(2, 30, 30.2);
  assert(validActivities([S], 0.5).length === 0, "minDuration hides short activities");
  assert(validActivities([S], 0.1).length === 1, "minDuration keeps activities that are long enough");
  // Invalid activities never selected. Like minDuration, the isValid filter lives in
  // validActivities, not in selectActivity.
  assert(validActivities([{ ...A, isValid: false }], 0).length === 0, "invalid activities never selected");
}

// 5. Scene signal: a small moving mark covers little of the frame; a whole-frame change fills it.
{
  const CUT = 0.08; // DEFAULT_PARAMS.sceneChangeFrac
  // A 6x6 mark on a 100x100 frame, moved. Sized to stand in for a pen stroke: on real footage
  // writing covers well under 2% of the frame, so this wants to land nowhere near the cut. (A
  // 12x12 box here reaches 7.8% once dilated — under the threshold, but only just, which would
  // make this check a coin toss rather than a check.)
  const dark = frameWithBox(20, 20, 6, 6);
  const darkMoved = frameWithBox(34, 34, 6, 6);
  const light = new Uint8ClampedArray(W * H * 4).fill(230); // entirely different frame

  const maskOf = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
    dilate(diffMask(toGray(a, W, H), toGray(b, W, H), W, H, 25).mask, W, H, 3);

  const activityFrac = changedFrac(maskOf(dark, darkMoved));
  const cutFrac = changedFrac(maskOf(dark, light));
  assert(activityFrac < CUT, `pen-stroke-scale change stays below the cut threshold (${(activityFrac * 100).toFixed(1)}%)`);
  assert(cutFrac > CUT, `whole-frame change exceeds the cut threshold (${(cutFrac * 100).toFixed(1)}%)`);
  assert(changedFrac(maskOf(dark, dark)) === 0, "identical frames change nothing");
}

// 5b. Webcam pre-pass: a patch that churns in every sparse pair is the zone; ink that
// changed in a few pairs is not; a churn area spanning the frame (a camera video where the
// instructor IS the picture) yields NO zone rather than a veto over the whole board.
{
  const pairs = 23;
  const churn = new Uint16Array(W * H);
  const paint = (x0: number, y0: number, w0: number, h0: number, v: number) => {
    for (let y = y0; y < y0 + h0; y++) for (let x = x0; x < x0 + w0; x++) churn[y * W + x] = v;
  };

  // A 18x14 "head" churning in all pairs at top-right; ink at left that changed in 3 pairs.
  paint(75, 5, 18, 14, pairs);
  paint(10, 40, 30, 4, 3);
  const zone = webcamZone(churn, pairs, W, H, 0.8);
  assert(zone !== null, "an always-churning patch becomes the webcam zone");
  assert(
    zone !== null && zone.x <= 75 && zone.x + zone.w >= 93 && zone.y <= 5 && zone.y + zone.h >= 19,
    "the zone covers the churning patch"
  );
  assert(zone !== null && !(zone.x <= 10 && zone.y <= 40 && zone.y + zone.h >= 44), "ink stays outside the zone");

  // The same threshold finds nothing when nothing churns persistently.
  churn.fill(0);
  paint(10, 40, 30, 4, 3);
  assert(webcamZone(churn, pairs, W, H, 0.8) === null, "slides-only churn yields no zone");

  // A churn region most of the frame wide (instructor at a whiteboard, camera video) is NOT
  // an inset — declaring it one would veto the board itself.
  churn.fill(0);
  paint(5, 20, 90, 70, pairs);
  assert(webcamZone(churn, pairs, W, H, 0.8) === null, "frame-scale churn is not called a webcam");

  // Too few samples to mean anything.
  churn.fill(0);
  paint(75, 5, 18, 14, 4);
  assert(webcamZone(churn, 4, W, H, 0.8) === null, "too few pairs -> no verdict");

  // Hysteresis: the zone floods from the always-churning core into the CONNECTED
  // sometimes-churning halo (the head's occasional reach — a lean, a gesture), but a
  // disconnected mid-churn blob elsewhere (slide content turning over) stays out.
  churn.fill(0);
  paint(75, 5, 18, 14, pairs); // core: churns in every pair
  paint(65, 5, 10, 20, Math.round(pairs * 0.55)); // halo, touching the core's left side
  paint(10, 50, 20, 20, Math.round(pairs * 0.55)); // same churn rate, but disconnected
  const fz = webcamZone(churn, pairs, W, H, 0.8);
  assert(fz !== null && fz.x <= 65, `zone floods into the connected halo (x=${fz?.x})`);
  assert(fz !== null && !(fz.y + fz.h >= 50), "a disconnected mid-churn blob is not swallowed");

  // Edge expansion: the churn core sits inside an inset whose BORDER is a persistent-edge
  // rectangle (a video-in-video boundary, present in every frame). The zone must grow to
  // that border — the inset's quiet side churns less than the slide, so churn alone can
  // never find it (measured: inset-left 0.13 vs slide 0.44 of pairs).
  const edges = new Uint8Array(W * H);
  const vline = (x0: number, y0: number, y1: number) => { for (let y = y0; y <= y1; y++) edges[y * W + x0] = 1; };
  const hline = (y0: number, x0: number, x1: number) => { for (let x = x0; x <= x1; x++) edges[y0 * W + x] = 1; };
  // Inset rectangle x 60..97, y 2..30; churn core only at x 75..93.
  vline(60, 2, 30); vline(97, 2, 30); hline(2, 60, 97); hline(30, 60, 97);
  const core = { x: 75, y: 5, w: 18, h: 14 };
  const grown = expandZoneToEdges(core, edges, W, H);
  assert(grown.x === 60 && grown.x + grown.w >= 97 && grown.y + grown.h >= 30,
    `zone grows to the inset's static border (got ${grown.x},${grown.y} ${grown.w}x${grown.h})`);
  // No border anywhere -> no growth.
  const same = expandZoneToEdges(core, new Uint8Array(W * H), W, H);
  assert(same.x === core.x && same.w === core.w && same.h === core.h, "no persistent border, no growth");
}

// 6. Range bookkeeping: coverage is a set of segments, and gaps get backfilled in order.
{
  let r = addRange([], { start: 0, end: 10 });
  assert(isAnalyzed(r, 5) && !isAnalyzed(r, 15), "isAnalyzed respects range bounds");
  // Seek to 40 creates a second segment; the gap between them is still open.
  r = addRange(r, { start: 40, end: 50 });
  assert(r.length === 2, "disjoint segments stay separate");
  assert(nextGap(r, 60, 0) === 10, "next gap starts right after the first segment");
  // Fill the middle; adjacent ranges merge.
  r = addRange(r, { start: 10, end: 40 });
  assert(r.length === 1 && r[0].end === 50, "adjacent ranges merge");
  assert(nextGap(r, 60, 0) === 50, "remaining tail is the next gap");
  assert(Math.abs(coverage(r, 60) - 50 / 60) < 1e-9, "coverage fraction correct");
  // Fully covered -> no gaps left.
  r = addRange(r, { start: 50, end: 60 });
  assert(nextGap(r, 60, 0) === null, "no gap when fully covered");
}

// Extract a single region from a hand-built mask.
function regionOfMask(paint: (mask: Uint8Array) => void): Region {
  const mask = new Uint8Array(W * H);
  paint(mask);
  const rs = componentRegions(mask, W, H, 0, 1);
  assert(rs.length === 1, `mask yields exactly one region (got ${rs.length})`);
  return rs[0];
}
const rect = (x0: number, y0: number, w: number, h: number) => (mask: Uint8Array) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) mask[y * W + x] = 1;
};
const lShape = (x0: number, y0: number, s: number) => (mask: Uint8Array) => {
  rect(x0, y0, s, Math.floor(s / 3))(mask); // horizontal bar
  rect(x0, y0, Math.floor(s / 3), s)(mask); // vertical bar
};

// 7. Hu moments: invariant under translation and scale, discriminative across shapes.
{
  const bar = regionOfMask(rect(10, 10, 24, 8));
  const barMoved = regionOfMask(rect(60, 70, 24, 8));
  const barScaled = regionOfMask(rect(10, 30, 48, 16));
  const ell = regionOfMask(lShape(10, 50, 24));

  const dTranslate = shapeDiff(bar.hu, barMoved.hu);
  const dScale = shapeDiff(bar.hu, barScaled.hu);
  const dShape = shapeDiff(bar.hu, ell.hu);
  assert(dTranslate < 0.01, `Hu invariant under translation (d=${dTranslate.toFixed(4)})`);
  assert(dScale < 0.3, `Hu ~invariant under scale (d=${dScale.toFixed(4)})`);
  assert(dShape > dScale * 3, `Hu separates bar vs L-shape (d=${dShape.toFixed(3)} vs ${dScale.toFixed(3)})`);
}

// 8. Activity features: pointing-like (static) vs sketching-like (drifting) logs.
{
  const regionAt = (x: number, y: number): Region =>
    regionOfMask(rect(x, y, 10, 6));
  const pointing: DetailedNode[] = [0, 0.2, 0.4, 0.6].map((t) => ({ t, region: regionAt(30, 30) }));
  const sketching: DetailedNode[] = [0, 0.2, 0.4, 0.6].map((t, i) => ({ t, region: regionAt(20 + i * 12, 30 + i * 8) }));

  const fp = computeFeatures(pointing);
  const fs = computeFeatures(sketching);
  assert(fp.meanConsecIoU === 1, `static activity has IoU 1 (got ${fp.meanConsecIoU})`);
  assert(fp.pathLength < 1e-9 && fp.displacement < 1e-9, "static activity has no trajectory");
  assert(fs.meanConsecIoU < 0.5, `drifting activity has low IoU (got ${fs.meanConsecIoU.toFixed(2)})`);
  assert(fs.displacement > 20, `drifting activity displaces (got ${fs.displacement.toFixed(1)})`);
  assert(fs.growth > fp.growth, "drifting activity's union bbox grows more than static's");
  assert(fp.nodeCount === 4 && Math.abs(fp.duration - 0.6) < 1e-9, "count/duration recorded");
}

// 9. Snippet planning: before-frame, 0.5s cadence, even spread when capped.
{
  const mk = (start: number, end: number): Activity => ({
    id: 0, start, end, box: { x: 10, y: 10, w: 40, h: 30 }, nodeCount: 1, isValid: true,
    features: computeFeatures([]),
  });
  const meta = {
    videoWidth: 1280, videoHeight: 720, analysisWidth: 480, analysisHeight: 270,
    scale: 1280 / 480, duration: 600,
  };

  // A 2s activity: before + start + 0.5 steps + end.
  const ts = snippetTimestamps(mk(10, 12), 600);
  assert(Math.abs(ts[0] - 9.7) < 1e-9, `first frame is the "before" baseline (got ${ts[0]})`);
  assert(Math.abs(ts[ts.length - 1] - 12) < 1e-9, "last frame is the activity end (the result)");
  assert(ts.length === 6, `2s activity -> before+start+3 steps+end = 6 frames (got ${ts.length})`);
  assert(ts.every((t, i) => i === 0 || t > ts[i - 1]), "timestamps strictly ascending");

  // A 30s activity would be 61 frames at 0.5s — must cap and spread evenly.
  const long = snippetTimestamps(mk(100, 130), 600);
  assert(long.length <= SNIPPET_MAX_FRAMES, `long activity capped (got ${long.length})`);
  assert(Math.abs(long[long.length - 1] - 130) < 1e-9, "capped sequence still ends at the end");
  assert(Math.abs(long[1] - 100) < 1e-9, "capped sequence still starts at the start");
  const gaps = long.slice(2).map((t, i) => t - long[i + 1]);
  const spread = Math.max(...gaps) - Math.min(...gaps);
  assert(spread < 1e-6, `capped frames are evenly spread (gap spread ${spread.toExponential(1)})`);

  // Zero-length activity: still yields a before + the moment itself.
  const inst = snippetTimestamps(mk(50, 50), 600);
  assert(inst.length === 2, `instantaneous activity -> before + itself (got ${inst.length})`);

  // Crop rect is in native px, padded, and clamped to the frame.
  const r = cropRect(mk(0, 1), meta);
  assert(r.x >= 0 && r.y >= 0 && r.x < 10 * meta.scale,
    `crop is padded left of the activity box but never negative (x=${r.x})`);
  assert(r.w > 40 * meta.scale, "crop is padded beyond the raw activity box");
  // An activity hugging the top-left corner must clamp rather than go negative.
  const corner = cropRect({ ...mk(0, 1), box: { x: 0, y: 0, w: 20, h: 20 } }, meta);
  assert(corner.x === 0 && corner.y === 0, "crop clamps at the frame origin");
  const edge = cropRect({ ...mk(0, 1), box: { x: 470, y: 260, w: 10, h: 10 } }, meta);
  assert(edge.x + edge.w <= meta.videoWidth && edge.y + edge.h <= meta.videoHeight,
    "crop never exceeds the frame bounds");
}

// 10. Magnification pan: continuous across the frame, saturating (not stepping) at edges.
{
  const frame = { width: 1280, height: 720 };
  const box = (x: number, y: number) => ({ x, y, width: 120, height: 80 });
  const f = 2.5;

  // Centred activity -> its centre lands in the middle of the frame.
  const mid = zoomTransform(box(640 - 60, 360 - 40), frame, f);
  const centreX = f * 640 + mid.tx;
  assert(Math.abs(centreX - frame.width / 2) < 1e-6, "centred activity lands mid-frame");

  // Never pan past an edge: the scaled image always covers the frame.
  for (const [x, y] of [[0, 0], [1160, 640], [0, 640], [1160, 0], [600, 300]] as const) {
    const { tx, ty } = zoomTransform(box(x, y), frame, f);
    assert(tx <= 1e-9 && tx >= frame.width * (1 - f) - 1e-9, `tx within bounds at x=${x}`);
    assert(ty <= 1e-9 && ty >= frame.height * (1 - f) - 1e-9, `ty within bounds at y=${y}`);
  }

  // THE bug: sweep an activity from the middle to the left edge in 1px steps and assert
  // the pan never jumps. A discontinuity here is exactly the "small jump near the edge".
  let prev = zoomTransform(box(600, 300), frame, f).tx;
  let maxStep = 0;
  for (let x = 599; x >= 0; x--) {
    const tx = zoomTransform(box(x, 300), frame, f).tx;
    maxStep = Math.max(maxStep, Math.abs(tx - prev));
    prev = tx;
  }
  // A 1px move of the activity may move the pan by at most `f` px — never more.
  assert(maxStep <= f + 1e-9, `pan is continuous approaching the edge (max step ${maxStep.toFixed(3)}px <= ${f})`);

  // And once clamped, it stops moving entirely rather than overshooting.
  const atEdge = zoomTransform(box(0, 300), frame, f).tx;
  const pastEdge = zoomTransform(box(-50, 300), frame, f).tx;
  assert(atEdge === 0 && pastEdge === 0, "pan saturates at the edge instead of overshooting");
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
